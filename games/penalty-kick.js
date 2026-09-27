/**
 * PIXEL RUSH — games/penalty-kick.js — "Penalty Kick"
 * Contract: window.PixelGame = { name, instructions, start(root, api) }, api = { setScore, setBest,
 * gameOver }, start() returns { destroy() }. Five kicks against a keeper who reads your body: aim a
 * reticle, pick SPIN or POWER, and the keeper commits to a dive while the ball is in flight.
 * One <canvas> + 2D ctx, no imports and no assets; every listener is torn down in destroy().
 */
(function () {
  'use strict';
  /* -------------------------------- Tuning -------------------------------- */
  var STORE_KEY = 'pixelrush.penalty-kick.best'; // localStorage: all-time best score
  var KICKS = 5, GOAL_PTS = 100, TOP_PTS = 50, PEN_PTS = 75, CLEAN_PTS = 50, TROPHY_PTS = 500;
  // Per-kick ramp: his read of your body tightens, he reacts faster and his reach grows. By kick 5
  // the lean is accurate, the arms are long, and a shot taken straight after he settles is gone.
  var RAMP = [{ sigma: 0.26, react: 430, reach: 0.200 }, { sigma: 0.24, react: 390, reach: 0.215 },
    { sigma: 0.225, react: 350, reach: 0.232 }, { sigma: 0.21, react: 310, reach: 0.252 },
    { sigma: 0.20, react: 275, reach: 0.275 }];
  var LEAN_K = 2.0, DIVE_K = 0.15;    // how far his read of your body is off, then how much he corrects it
  var READ_ERR = 0.60;               // his read is wrong by this much at worst — a bounded guess
  var EXTEND = 0.33;                 // how much of the gap to the ball's line his dive closes
  var CURVE_SEEN = 0.5;              // he half-anticipates the bend; the other half arrives late
  var SPIN_MS = 620, POWER_MS = 430;   // flight time per shot type — power beats the dive, but sprays
  var CURVE = 0.075;                   // lateral bow of a spin shot, in goal widths
  var SCATTER = { spin: 0.030, power: 0.075 };
  var AIM_SPEED = 0.62, RESULT_MS = 1150; // aim drift per second; beat length of the result card
  // The keeper's reach, in goal space. The shaded envelope drawn over the goal IS this rule:
  // he covers shot.reach goal widths either side of himself, and the higher he must climb the
  // further he travels (REACH_SLOPE), so the corners of the mouth are the safe places to aim.
  // KEEPER_MIN/MAX bound him inside the mouth, so no frame value can ever draw him off the goal.
  var REACH_TOP = 0.28, REACH_SLOPE = 0.30, KEEPER_MIN = 0, KEEPER_MAX = 1;
  var STYLES = '.pk{position:relative;width:100%;height:100%;overflow:hidden;touch-action:none;' +
    'user-select:none;-webkit-tap-highlight-color:transparent;' +
    'font-family:var(--font-body,"Rajdhani",system-ui,sans-serif);color:var(--ink,#f2f5ff)}' +
    '.pk canvas{display:block;width:100%;height:100%;outline:none}';
  // NaN-safe on purpose: a plain v<a?a:(v>b?b:v) returns NaN for NaN, which lets a
  // single bad frame value propagate through the aim and break every draw call.
  function clamp(v, a, b) { return (typeof v !== 'number' || !isFinite(v)) ? a : (v < a ? a : (v > b ? b : v)); }
  function gauss() { return (Math.random() + Math.random() + Math.random() - 1.5) * 2; }
  function easeOut(t) { return 1 - Math.pow(1 - clamp(t, 0, 1), 2); }
  function readBest() {
    try { var v = parseInt(window.localStorage.getItem(STORE_KEY), 10);
      return isFinite(v) && v > 0 ? v : null; } catch (e) { return null; } // private mode
  }
  function writeBest(v) {
    try { window.localStorage.setItem(STORE_KEY, String(v)); } catch (e) { /* ignore */ }
  }
  function start(root, api) {
    api = api || {};
    var setScore   = typeof api.setScore === 'function'  ? api.setScore  : function () {};
    var setBest    = typeof api.setBest === 'function'   ? api.setBest   : function () {};
    var gameOverCb = typeof api.gameOver === 'function' ? api.gameOver : function () {};
    var setStatus  = typeof api.setStatus === 'function' ? api.setStatus : function () {};
    /* -------------------------------- DOM -------------------------------- */
    var wrap = document.createElement('div'); wrap.className = 'pk';
    var canvas = document.createElement('canvas');
    canvas.setAttribute('tabindex', '0'); canvas.setAttribute('role', 'application');
    canvas.setAttribute('aria-label', 'Penalty Kick. Drag on the goal or use arrow keys to aim, ' +
      'then Space to shoot. Hold Shift for a power kick.');
    var live = document.createElement('div'); // screen-reader announcements
    live.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0)';
    live.setAttribute('aria-live', 'polite');
    wrap.appendChild(canvas); wrap.appendChild(live);
    var styleTag = document.createElement('style');
    styleTag.textContent = STYLES; wrap.appendChild(styleTag); root.appendChild(wrap);
    var ctx = canvas.getContext('2d');
    if (!ctx) { root.removeChild(wrap); return { destroy: function () {} }; }
    var rafId = 0, destroyed = false;
    var reduced = !!(window.PX && window.PX.reduced) ||
      !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    // Touch players get the on-canvas SPIN / POWER / SHOOT buttons and have no Space key,
    // so every piece of on-canvas copy names the control the player in front of it can use.
    var coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    var state = 'aim';         // 'aim' -> 'flight' -> 'result' -> (aim | over)
    var kick = 0, goals = 0, score = 0, bestEver = readBest(), isRecord = false, trophy = false;
    var over = false;          // hard guard: api.gameOver() may fire exactly once per run
    var booted = false, paused = false, mode = 'spin', shiftHeld = false;
    var aim = { x: 0.5, y: 0.5 };    // reticle in goal space, 0..1 left-to-right and top-to-bottom
    var keeper = { lean: 0.5, dive: 0.5, x: 0.5, read: 0 }; // read 0 = still guessing, 1 = committed
    var shot = null, result = null, rest = { x: 0, y: 0, r: 0 };
    var resultT = 0, aimT = 0, last = 0, flashAt = -1e9, trail = [], keys = Object.create(null);
    /* ----------------- Sizing (crisp devicePixelRatio) ----------------- */
    var dpr = 1, cssW = 1, cssH = 1, hudH = 40, btnH = 44, btnGap = 8, btnY = 0, btnW = 10, hintH = 18, hintY = 0;
    var gx = 0, gy = 0, gw = 10, gh = 5, spotX = 0, spotY = 0;
    function resize() {
      var r = wrap.getBoundingClientRect();
      cssW = Math.max(1, Math.round(r.width)); cssH = Math.max(1, Math.round(r.height));
      dpr = clamp(window.devicePixelRatio || 1, 1, 2); // cap DPR: fill-rate win on 3x phones
      canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
      canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // A short stage (a phone held upright gives us ~186px) cannot afford a 30px HUD, a
      // 40px button row and an unsized hint band: together they ate the whole pitch. So the
      // button row is reserved FIRST and the hint band is cut out of the strip directly above
      // it — that strip used to be nothing, which is why the hint landed on the buttons.
      var tight = cssH < 340;
      hudH = clamp(cssH * 0.11, tight ? 20 : 30, 58);
      btnH = clamp(cssH * 0.11, tight ? 30 : 40, 62);
      hintH = clamp(cssH * 0.038, tight ? 10 : 14, 20);
      btnY = Math.round(cssH - btnH - 8);
      btnW = Math.floor((cssW - 16 - btnGap * 2) / 3);
      // The goal keeps its real 2.3:1 ratio and is centred in whatever aspect ratio we are given.
      var top = hudH + (tight ? 4 : 8);
      var bandBottom = btnY - hintH - 4;   // nothing the game draws may cross this line
      var bottom = Math.max(top + 20, bandBottom);
      var avail = Math.max(20, bottom - top);
      // The penalty spot needs a strip of its own below the crossbar. It used to be placed at a
      // fixed 0.72 of whatever was left over, which on a short stage was zero — so the ball came
      // to rest sitting in the hint band. Reserve the strip before the goal is sized.
      var spotBand = Math.min(34, avail * 0.14);
      var goalAvail = Math.max(20, avail - spotBand);
      // floor gw: on the first frame the container can measure ~0px, which would
      // make cssW - 18 negative and hand createRadialGradient a negative radius.
      gw = Math.max(24, Math.min(cssW - 18, goalAvail * 2.3)); gh = gw / 2.3;
      gx = Math.round((cssW - gw) / 2); gy = Math.round(top + Math.max(0, (goalAvail - gh) / 2));
      // Centre the ball in the strip, then keep it clear of the hint band whatever the geometry.
      spotX = Math.round(cssW / 2);
      spotY = Math.round(Math.min(gy + gh + (bandBottom - (gy + gh)) * 0.5,
        bandBottom - Math.max(3, gw * 0.03)));
      hintY = Math.round(btnY - (hintH + 4) / 2);
    }
    resize();
    function token(n, fb) { // pull a site custom property, with a hard fallback
      var v = getComputedStyle(document.documentElement).getPropertyValue(n);
      return (v && v.trim()) || fb;
    }
    var C = { bg: token('--bg', '#05060f'), ink: token('--ink', '#f2f5ff'), dim: token('--ink-dim', '#a7b0d0'),
      cyan: token('--cyan', '#22e7ff'), magenta: token('--magenta', '#ff2fb9'), acid: token('--acid', '#c8ff2e'),
      orange: token('--orange', '#ff8a3d'), violet: token('--violet', '#8b5cf6') };
    function hexA(hex, a) { // #rrggbb + alpha -> rgba()
      hex = (hex || '#fff').trim().replace('#', '');
      var n = parseInt(hex, 16);
      return isFinite(n) ? 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')' : 'rgba(255,255,255,' + a + ')';
    }
    function rr(x, y, w, h, r) { // rounded-rect path, with a pre-roundRect fallback
      ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
    }
    var BODY_FONT = 'Rajdhani, system-ui, sans-serif';
    var TITLE_FONT = 'Orbitron, system-ui, sans-serif';
    /**
     * Sets ctx.font and returns the px size used. The base size is taken from the SMALLER stage
     * dimension and then shrunk to the measured width, so a tall portrait phone cannot balloon a
     * label past the canvas edge. Height alone is wrong here: on a phone the stage is taller than
     * it is wide, so every cssH-derived size was the larger one.
     */
    function fontPx(text, weight, family, want, maxPx) {
      var fs = Math.max(8, Math.round(want));
      ctx.font = weight + ' ' + fs + 'px ' + family;
      var w = ctx.measureText(String(text)).width;
      if (w > maxPx && w > 0) {
        fs = Math.max(8, Math.floor(fs * maxPx / w));
        ctx.font = weight + ' ' + fs + 'px ' + family;
      }
      return fs;
    }
    function seg(x1, y1, x2, y2) { ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); }
    function step() { return RAMP[Math.min(kick, RAMP.length - 1)]; }
    /**
     * The keeper's x is always a position inside the mouth — never off the frame, never off
     * the goal. The read he works from is bounded separately (see readErr) so that guessing
     * badly does not pile every overshoot onto the post and hand him the near corner.
     */
    function keeperAt(v) { return clamp(v, KEEPER_MIN, KEEPER_MAX); }
    function readErr(sigma) { return clamp(gauss() * sigma * LEAN_K, -READ_ERR, READ_ERR); }
    /* ---------------------------- Game logic ---------------------------- */
    /** Single writer for `paused`, so the HUD STATUS never disagrees with the overlay. */
    function setPaused(v) {
      v = !!v;
      if (paused === v) return;
      paused = v;
      setStatus(paused ? 'Paused' : 'Playing');
      // Lifting the card is now its own press, so the aim phase has to be announced here —
      // otherwise the live region still reads whatever the READY card said.
      if (!paused && state === 'aim') live.textContent = 'Kick ' + (kick + 1) + ' of ' + KICKS + '. Aim and shoot.';
    }
    function resetRun() {
      kick = 0; goals = 0; score = 0; trophy = false; isRecord = false; over = false; mode = 'spin';
      trail.length = 0; setPaused(!booted); booted = true;
      startKick(); setScore(0);
      if (bestEver !== null) setBest(bestEver);
      live.textContent = 'New run. Five kicks. Score 0.';
    }
    /** Open the aim phase for kick N: reticle centred, keeper idle, no read yet. */
    function startKick() {
      if (kick >= KICKS) { endRun(); return; }
      state = 'aim'; aimT = 0; shot = null; result = null; trail.length = 0;
      aim.x = 0.5; aim.y = 0.5;
      keeper.lean = 0.5; keeper.dive = 0.5; keeper.x = 0.5; keeper.read = 0;
      rest.x = spotX; rest.y = spotY; rest.r = gw * 0.028;
      live.textContent = 'Kick ' + (kick + 1) + ' of ' + KICKS + '. Aim and shoot.';
    }
    /** Fire the kick: spin curves and scatters less, power flies faster but sprays wide and high. */
    function shoot(kind) {
      if (destroyed || over || state !== 'aim') return;
      mode = kind;
      var s = step(), sc = SCATTER[kind];
      var curve = kind === 'spin' ? (aim.x < 0.5 ? -1 : 1) * CURVE * (0.5 + Math.random() * 0.5) : 0;
      shot = { t: 0, dur: kind === 'spin' ? SPIN_MS : POWER_MS, curve: curve,
        tx: clamp(aim.x + gauss() * sc + curve, -0.25, 1.25),      // where it really ends up
        ty: clamp(aim.y + gauss() * sc * 0.8, -0.25, 1.15),
        top: aim.y < 0.26, pen: Math.abs(aim.x - 0.5) < 0.08,    // bonus flags read off the AIM, not luck
        react: s.react, reach: s.reach * (kind === 'spin' ? 0.88 : 1) };
      // He commits: the lean he already telegraphed, extended toward the line the ball is on
      // (so going the other way buys you ground but never all of it), corrected by what he sees
      // as the boot hits, plus half of the bend he thinks he can read. The rest arrives late.
      var line = clamp(aim.x + curve, -0.2, 1.2);
      keeper.dive = keeperAt(keeper.lean + EXTEND * (line - keeper.lean) +
        gauss() * s.sigma * DIVE_K + curve * CURVE_SEEN);
      state = 'flight'; result = null; trail.length = 0;
      if (!reduced) flashAt = performance.now();
    }
    /** Ball crossed the line — judge goal / saved / wide / over and bank the points. */
    function resolve() {
      var sh = shot;
      keeper.x = keeperXAtFlight();   // the dive and the save are judged on the same value
      var dx = Math.abs(sh.tx - keeper.x);
      rest.x = clamp(ballX(sh), gx, gx + gw); rest.y = clamp(ballY(sh), gy, gy + gh); rest.r = gw * 0.042;
      var wide = sh.tx < 0.015 || sh.tx > 0.985, high = sh.ty < 0.02;
      // A save needs the ball inside his reach envelope: within reach of him, and low enough
      // for where he is. Travel costs him height, which is why the top corner is worth taking.
      var saved = !wide && !high && dx < sh.reach && sh.ty > REACH_TOP + REACH_SLOPE * dx;
      var pts = 0, label, color = C.orange;
      if (high) label = 'OVER THE BAR';
      else if (wide) label = sh.tx < 0.5 ? 'WIDE LEFT' : 'WIDE RIGHT';
      else if (saved) { label = 'SAVED'; color = C.magenta; }
      else {
        goals++; pts = GOAL_PTS; color = C.acid; label = 'GOAL';
        if (sh.top) { pts += TOP_PTS; label = 'TOP CORNER'; }
        else if (sh.pen) { pts += PEN_PTS; label = 'PANENKA!'; }
        // "CLEAN" = his hands never got near it, in either axis.
        if (dx >= sh.reach + 0.05 || sh.ty <= REACH_TOP + REACH_SLOPE * dx) {
          pts += CLEAN_PTS; label += ' · CLEAN';
        }
        score += pts; setScore(score); bankBest();
      }
      if (goals >= KICKS) { trophy = true; score += TROPHY_PTS; setScore(score); bankBest(); }
      result = { label: label, color: color, points: pts };
      state = 'result'; resultT = 0;
      live.textContent = label + (pts ? ', plus ' + pts + ' points.' : '.') +
        ' Goals ' + goals + ' of ' + KICKS + '. Score ' + score + '.';
    }
    function bankBest() {
      if (bestEver !== null && score <= bestEver) return;
      bestEver = score; isRecord = true; writeBest(score); setBest(score);
    }
    function endRun() {
      if (over || destroyed) return;   // api.gameOver() may only fire once per run
      over = true; state = 'over'; shot = null;
      live.textContent = 'Full time. Goals ' + goals + ' of ' + KICKS + '. Final score ' + score + '.';
      gameOverCb(score);
    }
    function nextKick() { kick++; startKick(); }
    /* -------------------------- Single rAF loop -------------------------- */
    function ballX(sh) { // spot -> target, bowed sideways at mid-flight so a spin reads as a spin
      return spotX + (gx + sh.tx * gw - spotX) * sh.t + sh.curve * gw * 4 * sh.t * (1 - sh.t);
    }
    function ballY(sh) { return spotY + (gy + sh.ty * gh - spotY) * sh.t; }
    function keeperXAtFlight() { // where the keeper is at a given point of the flight
      if (!shot) return keeper.lean;
      // The dive lives on `keeper`, not on `shot` — reading shot.dive here used to hand the
      // draw code a NaN every frame of the flight, and the NaN-safe clamp then parked the
      // keeper 30% of a goal width outside the left post, off the frame, for every shot.
      var e = easeOut((shot.t * shot.dur - shot.react) / 260);
      return keeperAt(keeper.lean + (keeper.dive - keeper.lean) * e);
    }
    function update(dt, now) {
      if (paused || over) return;
      if (state === 'aim') {
        aimT += dt;
        // Held keys drift the reticle smoothly — the same feel as a thumb drag on the goal.
        var kx = (keys.ArrowRight || keys.KeyD ? 1 : 0) - (keys.ArrowLeft || keys.KeyA ? 1 : 0);
        var ky = (keys.ArrowDown || keys.KeyS ? 1 : 0) - (keys.ArrowUp || keys.KeyW ? 1 : 0);
        if (kx || ky) {
          aim.x = clamp(aim.x + kx * AIM_SPEED * dt / 1000, 0.03, 0.97);
          aim.y = clamp(aim.y + ky * AIM_SPEED * dt / 1000, 0.04, 0.95);
        }
        // He reads the body line a beat into the kick, and the lean he shows is the dive he starts.
        if (aimT > 220 && keeper.read < 1) {
          keeper.lean = keeperAt(aim.x + readErr(step().sigma)); keeper.read = 1;
        }
        keeper.x = keeperAt(keeper.lean) + (reduced ? 0 : Math.sin(now / 460) * 0.012);
      } else if (state === 'flight' && shot) {
        shot.t = clamp(shot.t + dt / shot.dur, 0, 1);
        keeper.x = keeperXAtFlight();
        if (!reduced) { trail.push({ x: ballX(shot), y: ballY(shot) }); if (trail.length > 10) trail.shift(); }
        if (shot.t >= 1) resolve();
      } else if (state === 'result') {
        resultT += dt; if (resultT >= RESULT_MS) nextKick();
      }
    }
    /* ------------------------------ Drawing ------------------------------ */
    function drawGoal() {
      ctx.save(); rr(gx, gy, gw, gh, Math.min(14, gh * 0.2)); ctx.clip();
      ctx.strokeStyle = hexA(C.cyan, 0.13); ctx.lineWidth = 1; ctx.beginPath();
      for (var i = 0; i <= 14; i++) seg(gx + gw * i / 14, gy, gx + gw * i / 14, gy + gh);
      for (var j = 0; j <= 7; j++) seg(gx, gy + gh * j / 7, gx + gw, gy + gh * j / 7);
      ctx.stroke();
      var gl = ctx.createLinearGradient(0, gy, 0, gy + gh);
      gl.addColorStop(0, hexA(C.cyan, 0.1)); gl.addColorStop(1, hexA(C.violet, 0.03));
      ctx.fillStyle = gl; ctx.fillRect(gx, gy, gw, gh); ctx.restore();
      ctx.save(); // posts, crossbar, goal line
      ctx.strokeStyle = C.cyan; ctx.shadowColor = C.cyan; ctx.shadowBlur = 20;
      ctx.lineWidth = Math.max(3, gw * 0.012); ctx.beginPath();
      seg(gx, gy + gh, gx, gy); seg(gx, gy, gx + gw, gy); seg(gx + gw, gy, gx + gw, gy + gh); ctx.stroke();
      ctx.shadowBlur = 8; ctx.lineWidth = 1; ctx.strokeStyle = hexA(C.ink, 0.35); ctx.beginPath();
      seg(gx - gw * 0.03, gy + gh, gx + gw * 1.03, gy + gh); ctx.stroke(); ctx.restore();
      ctx.strokeStyle = hexA(C.ink, 0.14); ctx.lineWidth = 1; ctx.beginPath();  // penalty arc + spot
      ctx.arc(spotX, spotY, gw * 0.34, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke();
      ctx.fillStyle = hexA(C.ink, 0.4); ctx.beginPath();
      ctx.ellipse(spotX, spotY + gh * 0.06, gw * 0.045, gh * 0.018, 0, 0, 6.3); ctx.fill();
    }
    function drawKeeper(now) {
      // Belt and braces: even a bad frame value can only put him inside the goal mouth.
      var x = gx + clamp(keeper.x, 0.02, 0.98) * gw, base = gy + gh, u = gw * 0.09; // u = keeper body unit
      var diving = state === 'flight' && shot && (shot.t * shot.dur - shot.react) > 0;
      var reach = shot ? shot.reach : step().reach * (mode === 'spin' ? 0.88 : 1);
      if (state === 'aim' || state === 'flight') { // his reach envelope, laid down before him
        var side = base - gh * (1 - (REACH_TOP + REACH_SLOPE * reach));
        var mid = base - gh * (1 - REACH_TOP);
        ctx.save();
        ctx.beginPath(); rr(gx, gy, gw, gh, Math.min(14, gh * 0.2)); ctx.clip();
        ctx.beginPath();
        ctx.moveTo(x - reach * gw, base);
        ctx.lineTo(x - reach * gw, side);
        ctx.lineTo(x, mid);
        ctx.lineTo(x + reach * gw, side);
        ctx.lineTo(x + reach * gw, base);
        ctx.closePath();
        ctx.globalAlpha = 0.1 + 0.05 * (reduced ? 0 : Math.sin(now / 300));
        ctx.fillStyle = C.magenta; ctx.fill();
        ctx.globalAlpha = 0.45; ctx.strokeStyle = C.magenta; ctx.lineWidth = 1; ctx.stroke();
        ctx.restore();
      }
      ctx.save();
      if (!reduced) {
        var g = ctx.createRadialGradient(x, base, 0, x, base, u * 2.6);
        g.addColorStop(0, hexA(C.magenta, 0.22)); g.addColorStop(1, hexA(C.magenta, 0));
        ctx.fillStyle = g; ctx.fillRect(x - u * 3, base - u * 3, u * 6, u * 5);
      }
      ctx.translate(x, base); ctx.rotate((diving ? 0.11 : 0) + (reduced || !diving ? 0 : Math.sin(now / 90) * 0.04));
      ctx.shadowColor = C.magenta; ctx.shadowBlur = diving ? 24 : 14;
      ctx.strokeStyle = C.magenta; ctx.fillStyle = C.magenta; ctx.lineCap = 'round';
      ctx.lineWidth = u * 0.24; ctx.beginPath();
      if (diving) { // full stretch toward the ball
        seg(0, -u * 1.9, -u * 0.7, -u * 2.9); seg(0, -u * 1.9, u * 0.7, -u * 3.1);
        seg(0, -u * 1.9, -u * 1.3, -u * 2.6); seg(0, -u * 1.9, u * 1.3, -u * 2.5);
      } else { seg(0, -u * 1.7, -u * 1.5, -u * 2.3); seg(0, -u * 1.7, u * 1.5, -u * 2.3); }
      ctx.stroke();
      rr(-u * 0.5, -u * 1.9, u, u * 1.55, u * 0.3); ctx.fill();      // torso
      ctx.beginPath(); ctx.arc(0, -u * 2.15, u * 0.34, 0, 6.3); ctx.fill();
      ctx.restore();
    }
    function drawOrb(x, y, r, solid, alpha) {
      ctx.save(); ctx.shadowColor = C.acid; ctx.shadowBlur = solid ? 20 : 8;
      ctx.fillStyle = solid ? C.acid : C.cyan; if (alpha !== undefined) ctx.globalAlpha = alpha;
      ctx.beginPath(); ctx.arc(x, y, r, 0, 6.3); ctx.fill();
      if (solid) { ctx.shadowBlur = 0; ctx.fillStyle = hexA(C.bg, 0.85);
        ctx.beginPath(); ctx.arc(x - r * 0.15, y - r * 0.12, r * 0.42, 0, 6.3); ctx.fill(); }
      ctx.restore();
    }
    function drawBall(now) {
      var r = rest.r || gw * 0.028;
      if (state === 'flight' && shot) {
        if (!reduced) for (var i = 0; i < trail.length; i++)
          drawOrb(trail[i].x, trail[i].y, gw * 0.02, false, (i / trail.length) * 0.28);
        return drawOrb(ballX(shot), ballY(shot), gw * (0.028 + 0.014 * shot.t), true);
      }
      if (state === 'aim' && !reduced) r *= 0.9 + 0.1 * Math.sin(now / 300);
      drawOrb(rest.x, rest.y, r, true);
    }
    function drawReticle(now) {
      if (state !== 'aim') return;
      var x = gx + aim.x * gw, y = gy + aim.y * gh, r = Math.max(9, gw * 0.032);
      var col = mode === 'power' ? C.orange : C.cyan;
      ctx.save();
      ctx.strokeStyle = col; ctx.shadowColor = col; ctx.shadowBlur = 18; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, r * (reduced ? 1 : 0.6 + 0.4 * Math.sin(now / 280)), 0, 6.3); ctx.stroke();
      ctx.lineWidth = 1.6; ctx.globalAlpha = 0.85; ctx.beginPath();  // crosshair + aim line from the spot
      seg(x - r * 1.9, y, x - r * 0.55, y); seg(x + r * 0.55, y, x + r * 1.9, y);
      seg(x, y - r * 1.9, x, y - r * 0.55); seg(x, y + r * 0.55, x, y + r * 1.9); ctx.stroke();
      ctx.globalAlpha = 0.16; ctx.setLineDash([4, 6]); ctx.lineWidth = 1; ctx.beginPath();
      seg(spotX, spotY, x, y); ctx.stroke(); ctx.setLineDash([]); ctx.restore();
    }
    /** One line of coaching: what he read, whether the reticle is inside his reach envelope, and
     *  whether the aim sits so far out that the spray can carry it past the post. */
    function aimHint() {
      if (!keeper.read) return (mode === 'power' ? 'POWER' : 'SPIN') + ' READY';
      var side = keeper.x < 0.42 ? 'HE LEANED LEFT' : (keeper.x > 0.58 ? 'HE LEANED RIGHT' : 'HE IS CENTRED');
      var dx = Math.abs(aim.x - keeper.x), reach = step().reach * (mode === 'spin' ? 0.88 : 1);
      var inside = dx < reach && aim.y > REACH_TOP + REACH_SLOPE * dx;
      var edge = mode === 'spin' ? 0.18 : 0.12;
      var risky = aim.x < edge || aim.x > 1 - edge;
      return side + ' · ' + (inside ? 'IN REACH' : 'CLEAR') + (risky ? ' · EDGE RISK' : '');
    }
    function button(i, label, active, color) {
      var x = 8 + i * (btnW + btnGap);
      ctx.save(); rr(x, btnY, btnW, btnH, 10);
      ctx.fillStyle = active ? hexA(color, 0.18) : hexA(C.bg, 0.55);
      ctx.fill(); ctx.lineWidth = active ? 2 : 1; ctx.strokeStyle = active ? color : hexA(C.ink, 0.45);
      if (active) { ctx.shadowColor = color; ctx.shadowBlur = 14; } ctx.stroke(); ctx.shadowBlur = 0;
      ctx.fillStyle = active ? color : C.ink;
      fontPx(label, 800, BODY_FONT, Math.min(btnH * 0.26, cssW * 0.06), btnW * 0.82);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0,0,0,.9)'; ctx.shadowBlur = 6;   // label stays legible over the pitch
      ctx.fillText(label, x + btnW / 2, btnY + btnH / 2); ctx.restore();
    }
    function drawHud(now) {
      var top = hudH * 0.46;
      var left = 'SCORE ' + score, right = 'BEST ' + (bestEver || 0);
      var midCol = now - flashAt < 260 ? C.acid : C.cyan;
      var mid = 'KICK ' + Math.min(kick + 1, KICKS) + '/' + KICKS;
      ctx.save();
      // The two edge readouts share the width between the margins; sizing off that keeps a long
      // score on both sides from driving into the centred KICK label.
      var fs = fontPx(left + right, 800, BODY_FONT, Math.min(hudH * 0.36, cssW * 0.075),
        (cssW - 24) * 0.95);
      ctx.textBaseline = 'middle';
      // Two passes. A single blurred pass (halo only) is what held the peak glyph luma at
      // ~72/255 against a ~10/255 stage — about 2.2:1. Halo first for the backdrop, then
      // the same glyphs again unblurred so the core stays near the full ink colour.
      function hudText() {
        ctx.textAlign = 'left';   ctx.fillStyle = C.ink;    ctx.fillText(left, 10, top);
        ctx.textAlign = 'right';  ctx.fillStyle = C.ink;    ctx.fillText(right, cssW - 10, top);
        ctx.textAlign = 'center'; ctx.fillStyle = midCol;   ctx.fillText(mid, cssW / 2, top);
      }
      ctx.shadowColor = 'rgba(0,0,0,.95)'; ctx.shadowBlur = 10; ctx.shadowOffsetY = 1;
      hudText();
      ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
      hudText();
      var pr = Math.max(3, fs * 0.17), pipY = hudH * 0.85;   // one pip per converted kick
      for (var i = 0; i < KICKS; i++) {
        ctx.beginPath(); ctx.arc(cssW / 2 + (i - (KICKS - 1) / 2) * pr * 2.2, pipY, pr, 0, 6.3);
        if (i < goals) {
          ctx.fillStyle = C.acid; ctx.shadowColor = C.acid; ctx.shadowBlur = 10; ctx.fill();
        } else {
          // Unlit pips were near-invisible (1.3:1). A dim disc plus a bright rim reads as
          // "five kicks, none taken" at a glance.
          ctx.shadowBlur = 0; ctx.fillStyle = hexA(C.ink, 0.30); ctx.fill();
          ctx.lineWidth = Math.max(1, pr * 0.34); ctx.strokeStyle = hexA(C.ink, 0.8); ctx.stroke();
        }
        ctx.shadowBlur = 0;
      }
      ctx.restore();
    }
    /** Centred overlay: big neon title, sub-copy, and the restart affordance. */
    function card(title, sub, color, hint) {
      ctx.fillStyle = hexA(C.bg, 0.72); ctx.fillRect(0, 0, cssW, cssH);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      fontPx(title, 900, TITLE_FONT, Math.min(cssH * 0.14, cssW * 0.13), cssW * 0.9);
      ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 28;
      ctx.fillText(title, cssW / 2, cssH * 0.42); ctx.shadowBlur = 0;
      fontPx(sub, 600, BODY_FONT, Math.min(cssH * 0.05, cssW * 0.052), cssW * 0.9);
      ctx.fillStyle = C.dim; ctx.fillText(sub, cssW / 2, cssH * 0.5);
      if (hint) {
        fontPx(hint, 700, BODY_FONT, Math.min(cssH * 0.038, cssW * 0.048), cssW * 0.92);
        ctx.fillText(hint, cssW / 2, cssH * 0.61);
      }
    }
    function draw(now) {
      var w = cssW, h = cssH;
      ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);
      var bg = ctx.createRadialGradient(w / 2, gy + gh * 0.7, 0, w / 2, gy + gh * 0.7, gw * 1.1);
      bg.addColorStop(0, hexA(C.violet, 0.16)); bg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
      drawGoal(); drawKeeper(now); drawBall(now); drawReticle(now);
      if (result && state === 'result') {
        ctx.save();
        ctx.globalAlpha = clamp(resultT / 260, 0, 1) * clamp((RESULT_MS - resultT) / 260, 0, 1);
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        // "PANENKA! · CLEAN" is the longest verdict there is. At the old 52px it ran 46px past
        // the left edge on a phone, so the qualifier drops to its own line underneath.
        var parts = String(result.label).split(' · '), head = parts[0], tail = parts[1] || '';
        fontPx(head, 900, TITLE_FONT, Math.min(gh * 0.42, cssW * 0.11), cssW * (tail ? 0.86 : 0.94));
        ctx.fillStyle = result.color; ctx.shadowColor = result.color; ctx.shadowBlur = 26;
        ctx.fillText(head, w / 2, gy + gh * (tail ? 0.36 : 0.44));
        if (tail) {
          fontPx(tail, 700, BODY_FONT, Math.min(gh * 0.17, cssW * 0.055), cssW * 0.8);
          ctx.fillText(tail, w / 2, gy + gh * 0.55);
        }
        if (result.points) {
          fontPx('+' + result.points, 800, BODY_FONT, Math.min(gh * 0.2, cssW * 0.07), cssW * 0.6);
          ctx.fillStyle = C.ink; ctx.shadowBlur = 0;
          ctx.fillText('+' + result.points, w / 2, gy + gh * (tail ? 0.8 : 0.68));
        }
        ctx.restore();
      }
      if (!reduced) { ctx.fillStyle = 'rgba(0,0,0,.16)';  // CRT scanlines — world layer only
        for (var sy = 0; sy < h; sy += 3) ctx.fillRect(0, sy, w, 1); }
      var vig = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75);
      vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(0,0,0,.55)');
      ctx.fillStyle = vig; ctx.fillRect(0, 0, w, h);
      // Everything below is HUD chrome: it must sit above the CRT treatment or it goes illegible.
      if (state === 'aim') { // shot-type reminder + where he is leaning, in the strip above the buttons
        ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        fontPx(aimHint(), 700, BODY_FONT, Math.min(gh * 0.16, hintH * 0.95, cssW * 0.05), cssW * 0.94);
        ctx.fillStyle = C.ink; ctx.shadowColor = 'rgba(0,0,0,.9)'; ctx.shadowBlur = 8;
        ctx.fillText(aimHint(), w / 2, hintY);
        ctx.restore();
      }
      drawHud(now);
      button(0, 'SPIN', state === 'aim' && mode === 'spin', C.cyan);
      button(1, 'POWER', state === 'aim' && mode === 'power', C.orange);
      button(2, state === 'aim' ? 'SHOOT' : 'GO', false, C.acid);
      if (paused && !over) card(kick ? 'PAUSED' : 'READY',
        kick ? (coarse ? 'Tap to resume' : 'Tap or press a key to resume')
             : (coarse ? 'Tap to start' : 'Tap or press SPACE to start'), C.cyan, null);
      if (over) card('FULL TIME', 'SCORE ' + score + (isRecord ? '  ·  NEW BEST' : ''), C.magenta,
        (trophy ? 'TROPHY — ALL FIVE SCORED' : goals + '/' + KICKS + ' SCORED') +
        (coarse ? '  ·  TAP to play again' : '  ·  TAP or SPACE to play again'));
    }
    /* -------------------------- Single rAF loop -------------------------- */
    function frame(now) {
      if (destroyed) return;   // guard: destroy() can land between frames
      var dt = Math.min(120, now - last); // clamp so a backgrounded tab cannot fast-forward
      last = now; update(dt, now); draw(now);
      if (!destroyed) rafId = requestAnimationFrame(frame); // re-check: destroy() may run inside gameOver()
    }
    /* ------------------- Input: keyboard + pointer ------------------- */
    function onKeyDown(e) {
      if (destroyed || e.metaKey || e.ctrlKey || e.altKey) return;
      // Never steal keys from a real control the shell may have around the stage.
      var a = document.activeElement;
      if (a && a !== canvas && /^(BUTTON|INPUT|SELECT|TEXTAREA|A|SUMMARY)$/.test(a.tagName)) return;
      if (e.code === 'Space' || e.code === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (over) { resetRun(); return; }
        // The press that lifts the READY / PAUSED card must not also be the shot: it used to
        // clear `paused` and fall straight into shoot(), burning a kick from the dead-centre
        // default reticle (which is also the 75-point PANENKA line) before the player aimed.
        if (paused) { setPaused(false); return; }
        shoot(shiftHeld ? 'power' : mode);
        return;
      }
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') { shiftHeld = true; e.preventDefault(); return; }
      if (e.code.indexOf('Arrow') === 0 || e.code.indexOf('Key') === 0) {
        e.preventDefault(); keys[e.code] = true; if (!over) setPaused(false);
      }
    }
    function onKeyUp(e) {
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') shiftHeld = false;
      keys[e.code] = false;
    }
    function btnAt(x, y) {
      if (y < btnY || y > btnY + btnH) return -1;
      for (var i = 0; i < 3; i++) if (x >= 8 + i * (btnW + btnGap) && x <= 8 + i * (btnW + btnGap) + btnW) return i;
      return -1;
    }
    function aimAt(x, y) { aim.x = clamp((x - gx) / gw, 0.03, 0.97); aim.y = clamp((y - gy) / gh, 0.04, 0.95); }
    var activePointer = -1, aiming = false;
    function onPointerDown(e) {
      if (destroyed || (e.button !== undefined && e.button > 0)) return;
      var r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
      activePointer = e.pointerId;
      if (over) { resetRun(); return; }
      // Same rule as the keyboard: a press that only dismisses the READY / PAUSED card
      // must not fall through into the aim-and-release shot path.
      if (paused) { setPaused(false); return; }
      var b = btnAt(x, y);
      if (b === 0) { mode = 'spin'; return; }
      if (b === 1) { mode = 'power'; return; }
      if (b === 2) { shoot(mode); return; }
      // Touch: a drag that starts on the goal aims; releasing it shoots.
      if (x >= gx - 10 && x <= gx + gw + 10 && y >= gy - 10 && y <= gy + gh + 10) { aiming = true; aimAt(x, y); }
    }
    function onPointerMove(e) {
      if (destroyed || !aiming || e.pointerId !== activePointer || state !== 'aim') return;
      var r = canvas.getBoundingClientRect(); aimAt(e.clientX - r.left, e.clientY - r.top);
    }
    function onPointerUp(e) {
      if (e.pointerId !== activePointer) return;
      activePointer = -1;
      if (!aiming) return;   // a release that never began on the goal is not a shot
      aiming = false;
      if (!destroyed && !over) shoot(mode);
    }
    function onPointerCancel() { aiming = false; activePointer = -1; }
    function onWindowUp() { if (aiming) onPointerUp({ pointerId: activePointer }); } // capture fallback
    function onResize() { if (!destroyed) resize(); }
    function onBlur() { if (!destroyed && !over) setPaused(true); }   // auto-pause on focus loss
    function onVisibility() { if (document.hidden) onBlur(); }
    // Every listener the game owns, in one table so teardown cannot miss one.
    var BIND = [[document, 'keydown', onKeyDown], [document, 'keyup', onKeyUp],
      [canvas, 'pointerdown', onPointerDown], [canvas, 'pointermove', onPointerMove],
      [canvas, 'pointerup', onPointerUp], [canvas, 'pointercancel', onPointerCancel],
      [window, 'pointerup', onWindowUp, true], [window, 'resize', onResize, { passive: true }],
      [window, 'orientationchange', onResize], [window, 'blur', onBlur],
      [document, 'visibilitychange', onVisibility]];
    BIND.forEach(function (b) { b[0].addEventListener(b[1], b[2], b[3]); });
    last = performance.now();
    resetRun(); rafId = requestAnimationFrame(frame);
    return {
      destroy: function () {
        if (destroyed) return;   // idempotent
        destroyed = true; cancelAnimationFrame(rafId);
        BIND.forEach(function (b) { b[0].removeEventListener(b[1], b[2], b[3]); });
        var parent = wrap.parentNode;
        // Removing the wrapper drops the canvas, the live region and the <style> together.
        if (parent && typeof parent.removeChild === 'function') parent.removeChild(wrap);
        else if (typeof wrap.remove === 'function') wrap.remove();
      }
    };
  }
  /* ---------------------- Public module contract ---------------------- */
  window.PixelGame = {
    name: 'Penalty Kick',
    instructions:
      'Five kicks, one keeper who is watching you. Drag on the goal (or use the ARROW KEYS) to place ' +
      'your reticle, pick SPIN or POWER, then shoot — tap the goal and release, or press SPACE (hold ' +
      'SHIFT for a power kick). About a third of a second in, he commits to a read of where you are ' +
      'aiming and leans that way; the pink envelope on the goal is exactly what he can reach. Move ' +
      'your reticle OUT of the envelope after he leans and he dives at empty air — the hint line says ' +
      'IN REACH or CLEAR, and the high corners are always clear because he loses height the further he ' +
      'has to travel. Spin bends away from his dive late, so it beats a keeper who is in the right ' +
      'place, but it scatters less; power flies straight and fast and sprays wide or over the bar. A ' +
      'goal is 100, plus 50 from the top corner, 75 for a penalty down the middle, 50 if he never ' +
      'touched it, and 500 for the trophy if all five go in. He gets sharper every kick, so five in a ' +
      'row is hard. Best score is saved on this device.',
    start: start
  };
})();
