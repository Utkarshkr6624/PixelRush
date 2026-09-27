/**
 * PIXEL RUSH — games/swish.js — "Swish!"
 * Contract (GAME-CONTRACT.md): window.PixelGame = { name, instructions, start(root, api) }
 * where api = { setScore(n), setBest(n), gameOver(score) } and start() returns { destroy() }.
 * Self-contained: no imports, no dependencies, no assets — one <canvas> + 2D ctx, one rAF
 * loop, and every listener and frame id created in start() is torn down in destroy().
 *
 * Camera: the world is a fixed 100-unit-wide stage that is never stretched. The court band is
 * the space between the scoreboard panel and the ANG/POW strip; the playfield is square-ish
 * (0.92 x the stage width at most) and sits on the BOTTOM of that band, so the leftover height
 * becomes a sky band above it. The scoreboard is a fixed-height panel that reserves its own
 * space at the top of the court band, so it never depends on that leftover height. Every
 * length below is a fraction of the world width, so the whole sim is scale-free and behaves
 * identically at any screen size.
 */
(function () {
  'use strict';
  /* -------------------------------- Tuning -------------------------------- */
  var STORE_KEY = 'pixelrush.swish.best';  // localStorage: all-time best score
  var SHOTS = 10;                          // attempts per run
  var D0 = 52, D_STEP = 3;                 // shot distance in world units, growing every attempt
  var RIM0 = 15, RIM_FALL = 0.55;          // rim span, and how much it narrows per attempt
  var BALL_R = 1.3, RIM_R = 0.35, RIM_TUBE = 0.12;      // ball radius / rim tube / board thickness
  var GRAV = 0.46, PWR_LO = 0.80, PWR_HI = 1.50;       // gravity + launch-speed band
  var FLOOR_BOUNCE = 0.50, FLOOR_DRAG = 0.78, BOARD_BOUNCE = 0.72;
  var CONTEST0 = 0.12, CONTEST_STEP = 0.055;          // defender reach chance, per shot index
  var PREVIEW_FRAC = 0.88;   // how far ahead the dotted arc runs — the last drop is on you
  var SWISH_PTS = 100, BANK_PTS = 45, RIM_PTS = 20, STREAK_BONUS = 20;
  var HOLD = 1.05, MAX_FLIGHT = 6, STRIP = 30, ANG_MIN = 20, ANG_MAX = 82;
  var KEYS = {
    ArrowLeft: ['ang', -1], KeyA: ['ang', -1], ArrowRight: ['ang', 1], KeyD: ['ang', 1],
    ArrowUp: ['pow', 1], KeyW: ['pow', 1], ArrowDown: ['pow', -1], KeyS: ['pow', -1]
  };
  var STYLES = '.sw{position:relative;width:100%;height:100%;overflow:hidden;touch-action:none;' +
    'user-select:none;-webkit-tap-highlight-color:transparent;' +
    'font-family:var(--font-body,"Rajdhani",system-ui,sans-serif);color:var(--ink,#f2f5ff)}' +
    '.sw canvas{display:block;width:100%;height:100%;outline:none}';
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function readBest() {
    try { var v = parseInt(window.localStorage.getItem(STORE_KEY), 10);
      return isFinite(v) && v > 0 ? v : 0; } catch (e) { return 0; } // private mode
  }
  function writeBest(v) {
    try { window.localStorage.setItem(STORE_KEY, String(v)); } catch (e) { /* ignore */ }
  }
  /**
   * start(root, api) — build the game inside `root` and return { destroy }.
   * @param {HTMLElement} root
   * @param {{setScore:Function,setBest:Function,gameOver:Function}} api
   */
  function start(root, api) {
    api = api || {};
    var setScore   = typeof api.setScore === 'function'  ? api.setScore  : function () {};
    var setBest    = typeof api.setBest === 'function'   ? api.setBest   : function () {};
    var setStatus  = typeof api.setStatus === 'function' ? api.setStatus : function () {};
    var gameOverCb = typeof api.gameOver === 'function' ? api.gameOver : function () {};
    /* -------------------------------- DOM -------------------------------- */
    var wrap = document.createElement('div'); wrap.className = 'sw';
    var canvas = document.createElement('canvas');
    canvas.setAttribute('tabindex', '0'); canvas.setAttribute('role', 'application');
    canvas.setAttribute('aria-label', 'Swish basketball. Left and right arrows aim, up and down set ' +
      'power, space shoots. On touch: drag to aim and release to shoot, or use the on-screen buttons.');
    var live = document.createElement('div'); // screen-reader announcements
    live.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0)';
    live.setAttribute('aria-live', 'polite');
    wrap.appendChild(canvas); wrap.appendChild(live);
    var styleTag = document.createElement('style');
    styleTag.textContent = STYLES; wrap.appendChild(styleTag); root.appendChild(wrap);
    var ctx = canvas.getContext('2d');
    if (!ctx) { root.removeChild(wrap); return { destroy: function () {} }; }
    /* ------------------------------ State ------------------------------- */
    var rafId = 0, destroyed = false, booted = false, paused = false, over = false;
    var reduced = !!(window.PX && window.PX.reduced) ||
      !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    var score = 0, swishes = 0, streak = 0, shotIdx = 0, bestEver = readBest(), isRecord = false;
    var log = [];   // one entry per finished attempt, for the scoreboard pips
    var state = 'aim', angle = 45, power = 0.6, msg = null, msgT = 0, holdT = 0;
    var hint = null, hintT = 0;   // "not ready yet" feedback for input that arrives mid-shot
    var ball = { x: 0, y: 0, vx: 0, vy: 0 }, trail = [];
    var rimHit = false, boardHit = false, scored = false, crossed = false, contestWon = false;
    var ballLive = false, flightT = 0, restT = 0, defJump = 0, netSway = 0, flashAt = -1e9;
    var dragging = false, dragId = -1, dragX = 0, dragY = 0, holding = null, holdNext = 0;
    var dpr = 1, cssW = 1, cssH = 1, stripTop = 0, barTop = 0, scale = 1, oy = 0, bandH = 0, courtTop = 0;
    var hudTop = 7, hudH = 60;   // scoreboard panel: its own space, not carved out of the court
    function resize() {
      var r = wrap.getBoundingClientRect();
      cssW = Math.max(1, Math.round(r.width)); cssH = Math.max(1, Math.round(r.height));
      dpr = clamp(window.devicePixelRatio || 1, 1, 2); // cap DPR: fill-rate win on high-DPI phones
      canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
      canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
      hex = (hex || '#fff').trim().replace('#', ''); var n = parseInt(hex, 16);
      if (!isFinite(n)) return 'rgba(255,255,255,' + a + ')';
      return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
    }
    function rr(x, y, w, h, r) { // rounded-rect path, with a pre-roundRect fallback
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
    }
    /* -------------------------- Court geometry -------------------------- */
    var W = { w: 100, h: 100, ground: 0, rim: 0, hh: 0, rimX: 0, rimX2: 0, boardX: 0, br: BALL_R,
      shooterX: 0, releaseY: 0, defH: 0, zx: 0, zh: 3.5, zTop: 0, zBot: 0,
      rimLen: RIM0, dist: D0, vNorm: 0 };
    var buttons = [];
    function layout() {
      barTop = cssH - Math.round(clamp(cssH * 0.14, 68, 100));
      stripTop = barTop - STRIP;
      // Scoreboard: a fixed-height panel at the top of the court band. Its height is derived
      // from the canvas, not from bandH — bandH is 0 on every wide/landscape stage, so a
      // scoreboard sized from it would always collapse to its minimum.
      hudH = Math.round(clamp(cssH * 0.20, 62, 150));
      hudH = Math.min(hudH, Math.max(30, Math.round((stripTop - hudTop) * 0.55)));
      // The scoreboard occupies the top of the court band, so the playfield gets what is
      // left below it. The playfield is `playH` tall and sits on the BOTTOM of that band, so
      // the world origin is the leftover sky height only — adding stripTop here would push
      // the whole court one full court-height off the bottom of the canvas.
      var top = hudTop + hudH + 4;
      courtTop = top;
      var courtH = Math.max(40, stripTop - courtTop), playH = Math.min(courtH, cssW * 0.92);
      scale = cssW / W.w; W.h = playH / scale; bandH = courtH - playH; oy = courtTop + bandH;
      W.ground = W.h * 0.90; W.hh = W.h * 0.45; W.rim = W.ground - W.hh;
      W.rimLen = RIM0 - RIM_FALL * shotIdx;
      W.rimX2 = W.w * 0.972; W.boardX = W.rimX2; W.rimX = W.rimX2 - W.rimLen;
      W.dist = D0 + D_STEP * shotIdx; W.shooterX = Math.max(3, W.rimX - W.dist);
      W.releaseY = W.ground - W.hh * 0.20;
      W.defH = W.hh * 0.55; W.zx = W.rimX - W.hh * 0.22;
      W.zTop = W.rim - W.hh * 0.55; W.zBot = W.rim + W.hh * 0.45;
      W.vNorm = Math.sqrt((W.dist + 0.8 * (W.ground - W.releaseY)) * GRAV * W.w);
      // Thumb-zone buttons: four small nudges plus a double-width SHOOT.
      var pad = Math.max(8, cssW * 0.03), gap = Math.max(5, cssW * 0.014);
      var bh = Math.min((barTop - stripTop) * 0.66, 58), by = barTop + (barTop - stripTop - bh) / 2;
      var u = (cssW - pad * 2 - gap * 5) / 6, ids = ['ang-', 'ang+', 'pow-', 'pow+', 'shoot'];
      var labs = ['ANG-', 'ANG+', 'POW-', 'POW+', 'SHOOT'];
      buttons = [];
      for (var i = 0; i < 5; i++) buttons.push({ id: ids[i], label: labs[i], x: pad + i * (u + gap),
        y: by, w: i === 4 ? 2 * u + gap : u, h: bh });
    }
    function sX(x) { return x * scale; }
    function sY(y) { return oy + y * scale; }
    /* ---------------------------- Round set-up ---------------------------- */
    /** Any real player input leaves the READY card and clears an accidental pause. */
    function wake() { setPause(false); }
    /** Single owner of the paused flag, so the toggle works and the HUD label follows. */
    function setPause(v) {
      if (paused === !!v) { booted = true; return; }
      paused = !!v; booted = true;
      setStatus(paused ? 'Paused' : 'Playing');
    }
    /** Shown when a shoot press lands while the previous shot is still resolving. */
    function flashHint(text) { hint = text; hintT = 0.9; }
    function contestRate() { return clamp(CONTEST0 + CONTEST_STEP * shotIdx, 0, 0.75); }
    function distBonus() { return clamp(Math.round((W.dist - 48) / 3) * 5, 0, 40); }
    function armShot() {
      angle = 42 + Math.random() * 24; power = 0.55 + Math.random() * 0.18;
      trail.length = 0; rimHit = boardHit = scored = crossed = contestWon = false;
      ballLive = false; flightT = 0; restT = 0; defJump = 0; netSway = 0; msg = null; hintT = 0;
      layout();
      ball.x = W.shooterX; ball.y = W.releaseY; ball.vx = 0; ball.vy = 0;
    }
    function resetRun() {
      score = 0; swishes = 0; streak = 0; shotIdx = 0; log.length = 0; isRecord = false; over = false;
      state = 'aim'; paused = false; booted = false; setStatus('Playing');
      armShot(); setScore(0); setBest(bestEver);
      live.textContent = 'New run. Ten shots. Score 0.';
    }
    /** Score the attempt, then hold the banner before the next ball. */
    function resolve(kind, pts) {
      if (over) return;
      score += pts; msg = { kind: kind, pts: pts, swish: kind === 'SWISH' }; msgT = 0; holdT = HOLD;
      log[shotIdx] = kind;
      if (kind === 'SWISH') { swishes++; streak++; } else streak = 0;
      setScore(score);
      if (score > bestEver) { bestEver = score; isRecord = true; writeBest(score); setBest(score); }
      live.textContent = kind + ' ' + pts + ' points. Score ' + score + '. Swishes ' + swishes + '.';
      state = 'settle';
    }
    function nextShot() {
      shotIdx++;
      if (shotIdx >= SHOTS) { finish(); return; }
      state = 'aim'; armShot();
    }
    function finish() {
      if (over) return;   // api.gameOver() may only fire once per run
      over = true; ballLive = false; paused = false;
      if (score > bestEver) { bestEver = score; isRecord = true; writeBest(score); setBest(score); }
      live.textContent = 'Game over. Score ' + score + '. ' + swishes + ' swishes. Best ' + bestEver + '.';
      gameOverCb(score);
    }
    function shoot() {
      if (over || destroyed) return;
      if (state !== 'aim') { flashHint('GET READY'); return; }
      wake();
      var a = angle * Math.PI / 180, sp = W.vNorm * (PWR_LO + (PWR_HI - PWR_LO) * power);
      ball.x = W.shooterX; ball.y = W.releaseY;
      ball.vx = Math.cos(a) * sp; ball.vy = -Math.sin(a) * sp;
      trail.length = 0; rimHit = boardHit = scored = crossed = false;
      ballLive = true; flightT = 0; restT = 0;
      contestWon = Math.random() < contestRate();
      state = 'flight';
      live.textContent = 'Shot ' + (shotIdx + 1) + ' of ' + SHOTS + ' away.';
    }
    /* ------------------------------ Physics ------------------------------ */
    function stepBall(h) {
      var px = ball.x, py = ball.y, r = W.br;
      ball.vy += GRAV * W.w * h;
      ball.x += ball.vx * h; ball.y += ball.vy * h;
      flightT += h;
      // The defender reaches once, as the ball crosses his box in front of the rim.
      if (!crossed && px < W.zx && ball.x >= W.zx) {
        crossed = true;
        if (ball.y > W.zTop && ball.y < W.zBot) {
          defJump = 1; flashAt = performance.now();
          if (contestWon) { rimHit = true; ball.vx *= 0.94; ball.vy *= 0.9; } // a touch, not a block
        }
      }
      // Backboard: a solid face just right of the rim.
      if (ball.vx > 0 && ball.x + r > W.boardX && ball.x - r < W.boardX + RIM_TUBE &&
          ball.y + r > W.rim && ball.y - r < W.rim + W.hh * 0.30) {
        ball.x = W.boardX - r; ball.vx = -ball.vx * BOARD_BOUNCE; boardHit = true; netSway = 1;
      }
      // Rim: two tubes, one at each end of the span.
      for (var i = 0; i < 2; i++) {
        var cx = i ? W.rimX2 : W.rimX, dx = ball.x - cx, dy = ball.y - W.rim;
        var d = Math.sqrt(dx * dx + dy * dy), min = r + RIM_R;
        if (d < min && d > 0.0001) {
          var nx = dx / d, ny = dy / d, vn = ball.vx * nx + ball.vy * ny;
          ball.x = cx + nx * min; ball.y = W.rim + ny * min;
          ball.vx = (ball.vx - 1.55 * vn * nx) * 0.86; ball.vy = (ball.vy - 1.55 * vn * ny) * 0.86;
          if (!rimHit) { rimHit = true; netSway = 1; }
        }
      }
      // Through the hoop: the centre crosses rim level going down, inside the span.
      if (!scored && ball.vy > 0 && py < W.rim && ball.y >= W.rim &&
          ball.x > W.rimX + r * 0.2 && ball.x < W.rimX2 - r * 0.2) {
        scored = true; netSway = 1;
        if (rimHit) resolve(boardHit ? 'BANK' : 'RIM', (boardHit ? BANK_PTS : RIM_PTS) + distBonus());
        else resolve('SWISH', SWISH_PTS + (streak ? STREAK_BONUS * streak : 0) + distBonus());
        return;
      }
      if (ball.y + r > W.ground) { // floor
        ball.y = W.ground - r;
        if (ball.vy > 0) { ball.vy = -ball.vy * FLOOR_BOUNCE; ball.vx *= FLOOR_DRAG; }
      }
    }
    function update(dt) {
      if (defJump > 0) defJump = Math.max(0, defJump - dt * 2.2);
      if (netSway > 0) netSway = Math.max(0, netSway - dt * 2.4);
      if (ballLive) {
        var n = Math.max(1, Math.ceil(dt / 0.008)), h = dt / n, t0 = trail[0];
        for (var i = 0; i < n; i++) stepBall(h);
        if (!reduced && (!t0 || t0.x !== ball.x || t0.y !== ball.y)) {
          trail.unshift({ x: ball.x, y: ball.y }); if (trail.length > 10) trail.length = 10;
        }
        if (Math.abs(ball.vx) < 0.5 && Math.abs(ball.vy) < 0.5) {
          if (++restT > 0.35) { ballLive = false; if (state === 'flight') resolve('MISS', 0); }
        } else restT = 0;
        if (ballLive && flightT > MAX_FLIGHT) { ballLive = false; if (state === 'flight') resolve('MISS', 0); }
      }
      if (state === 'settle') { msgT += dt; if ((holdT -= dt) <= 0) nextShot(); }
      if (hintT > 0) hintT -= dt;
    }
    /* ---------------------------- Trajectory ----------------------------- */
    /** Predicted arc: gravity + floor only, cut short before the rim. */
    function preview() {
      var g = GRAV * W.w, a = angle * Math.PI / 180, sp = W.vNorm * (PWR_LO + (PWR_HI - PWR_LO) * power);
      var x = W.shooterX, y = W.releaseY, vx = Math.cos(a) * sp, vy = -Math.sin(a) * sp;
      var stopX = W.shooterX + (W.rimX - W.shooterX) * PREVIEW_FRAC, h = 0.02, out = [];
      for (var i = 0; i < 140 && x < stopX; i++) {
        vy += g * h; x += vx * h; y += vy * h;
        if (y + W.br > W.ground) { y = W.ground - W.br; vy = -vy * FLOOR_BOUNCE; vx *= FLOOR_DRAG; }
        if (i % 2 === 0) out.push({ x: x, y: y });
      }
      return out;
    }
    /* ------------------------------ Input ------------------------------ */
    function nudge(what, dir) {
      if (over) return;
      wake();
      if (what === 'ang') angle = clamp(angle + dir * 1.2, ANG_MIN, ANG_MAX);
      else power = clamp(power + dir * 0.02, 0.05, 1);
    }
    function onKeyDown(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var a = document.activeElement;
      if (a && a !== canvas && /^(BUTTON|INPUT|SELECT|TEXTAREA|A|SUMMARY)$/.test(a.tagName)) return;
      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        if (e.repeat) return;
        if (over) resetRun(); else shoot();
      } else if (e.code === 'Escape' || e.key === 'p' || e.key === 'P') {
        if (!over) { e.preventDefault(); setPause(!paused); }   // wake() here would clear the flag the toggle reads
      } else {
        var k = KEYS[e.code] || KEYS[e.key];
        if (k) { e.preventDefault(); nudge(k[0], k[1]); }
      }
    }
    function hitButton(p) {
      for (var i = 0; i < buttons.length; i++) { var b = buttons[i];
        if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return b; }
      return null;
    }
    function pressButton(id, now) {
      if (id === 'shoot') { if (over) resetRun(); else shoot(); return; }
      if (over) return;
      nudge(id.slice(0, 3) === 'ang' ? 'ang' : 'pow', id.slice(-1) === '+' ? 1 : -1);
      holding = id; holdNext = now + 420;   // then auto-repeat, driven by the frame loop
    }
    function onPointerDown(e) {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      wake();
      var r = canvas.getBoundingClientRect(), p = { x: e.clientX - r.left, y: e.clientY - r.top };
      var b = hitButton(p);
      if (b) { pressButton(b.id, performance.now()); return; }
      if (over) { resetRun(); return; }
      if (state !== 'aim') return;
      dragging = true; dragId = e.pointerId; dragX = p.x; dragY = p.y;
      if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
    }
    function onPointerMove(e) {
      if (!dragging || e.pointerId !== dragId || over || state !== 'aim') return;
      var r = canvas.getBoundingClientRect(), p = { x: e.clientX - r.left, y: e.clientY - r.top };
      angle = clamp(angle + (p.x - dragX) / (cssW * 0.45) * (ANG_MAX - ANG_MIN), ANG_MIN, ANG_MAX);
      power = clamp(power - (p.y - dragY) / (cssH * 0.35), 0.05, 1); // drag up = more power
      dragX = p.x; dragY = p.y;
    }
    function onPointerUp(e) {
      holding = null;   // stop the button auto-repeat even if the press began on a button
      if (!dragging || e.pointerId !== dragId) return;
      dragging = false; dragId = -1;
      if (!over && state === 'aim') shoot();   // release fires the shot
    }
    function onPointerCancel() { dragging = false; dragId = -1; holding = null; }
    function onResize() { if (!destroyed) { resize(); layout(); } }
    function onBlur() { if (!destroyed && !over) setPause(true); }
    function onVisibility() { if (document.hidden) onBlur(); }
    // Every listener the game owns, in one table so teardown cannot miss one.
    var BIND = [[document, 'keydown', onKeyDown], [canvas, 'pointerdown', onPointerDown],
      [canvas, 'pointermove', onPointerMove], [canvas, 'pointerup', onPointerUp],
      [canvas, 'pointercancel', onPointerCancel],
      [window, 'resize', onResize, { passive: true }], [window, 'orientationchange', onResize],
      [window, 'blur', onBlur], [document, 'visibilitychange', onVisibility]];
    BIND.forEach(function (b) { b[0].addEventListener(b[1], b[2], b[3]); });
    /* ----------------------------- Drawing ----------------------------- */
    function drawFigure(x, gy, h, color, arm, jump) {
      var lift = jump * h * 0.24, top = gy - h - lift, hip = gy - h * 0.48 - lift;
      ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = Math.max(1.5, h * 0.08); ctx.lineCap = 'round';
      ctx.shadowColor = color; ctx.shadowBlur = h * 0.5 * (reduced ? 0.4 : 1); ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.moveTo(x - h * 0.16, gy); ctx.lineTo(x, hip); ctx.lineTo(x + h * 0.16, gy);   // legs
      ctx.moveTo(x, hip); ctx.lineTo(x, top + h * 0.22);                                 // torso
      ctx.moveTo(x, top + h * 0.20);
      ctx.lineTo(x + Math.cos(arm) * h * 0.44, top + h * 0.20 - Math.sin(arm) * h * 0.44); // arm
      ctx.stroke(); ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(x, top + h * 0.10, h * 0.11, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    }
    function drawCourt() {
      var g = sY(W.ground), i, gr = ctx.createLinearGradient(0, 0, 0, g);
      gr.addColorStop(0, hexA(C.violet, 0.18)); gr.addColorStop(1, hexA(C.violet, 0.02)); // stands
      ctx.fillStyle = gr; ctx.fillRect(0, 0, cssW, g);
      ctx.strokeStyle = hexA(C.cyan, 0.09); ctx.lineWidth = 1;
      for (i = 1; i < 5; i++) { var y = g * (i / 5); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cssW, y); ctx.stroke(); }
      ctx.fillStyle = hexA(C.cyan, 0.06); ctx.fillRect(0, g, cssW, cssH - g);
      ctx.strokeStyle = hexA(C.cyan, 0.5); ctx.lineWidth = 2; ctx.shadowColor = C.cyan; ctx.shadowBlur = 14;
      ctx.beginPath(); ctx.moveTo(0, g); ctx.lineTo(cssW, g); ctx.stroke(); ctx.shadowBlur = 0;
    }
    function drawHoop(now) {
      var bx = sX(W.boardX), rx = sX(W.rimX), rx2 = sX(W.rimX2), ry = sY(W.rim);
      var t = Math.max(3, RIM_TUBE * scale), bh = W.hh * 0.30 * scale, nx = rx2 - rx;
      ctx.strokeStyle = hexA(C.dim, 0.5); ctx.lineWidth = Math.max(2, t * 1.1);
      ctx.beginPath(); ctx.moveTo(bx + t, ry); ctx.lineTo(bx + t * 2.4, sY(W.ground)); ctx.stroke();
      ctx.save(); ctx.shadowColor = C.cyan; ctx.shadowBlur = 18;
      ctx.strokeStyle = hexA(C.cyan, 0.85); ctx.lineWidth = Math.max(1.5, t * 0.5);
      rr(bx, ry, t, bh, t * 0.3); ctx.stroke();
      ctx.strokeStyle = hexA(C.cyan, 0.45);
      rr(bx + t * 0.2, ry + bh * 0.14, t * 0.6, bh * 0.72, t * 0.12); ctx.stroke(); // shooter's square
      ctx.restore();
      // Net: a tapering cage that kicks when the ball goes in.
      var depth = W.hh * 0.30 * scale, sway = reduced ? 0 : Math.sin(now / 90) * netSway * nx * 0.16;
      ctx.strokeStyle = hexA(C.ink, 0.45); ctx.lineWidth = 1; ctx.beginPath();
      for (var i = 0; i <= 4; i++) { var u = i / 4;
        ctx.moveTo(rx + nx * u, ry);
        ctx.lineTo(rx + nx * (0.5 + 0.32 * (u - 0.5)) + sway * (u - 0.5) * 2, ry + depth); }
      ctx.moveTo(rx + nx * 0.3, ry + depth * 0.55); ctx.lineTo(rx + nx * 0.7, ry + depth * 0.55);
      ctx.stroke();
      var hot = flashAt > 0 && (now - flashAt) < 300;
      ctx.save(); ctx.strokeStyle = hot ? C.magenta : C.orange;
      ctx.shadowColor = ctx.strokeStyle; ctx.shadowBlur = 16; ctx.lineWidth = Math.max(2, RIM_R * 2.2 * scale);
      ctx.beginPath(); ctx.moveTo(rx, ry); ctx.lineTo(rx2, ry); ctx.stroke(); ctx.restore();
    }
    function drawPreview() {
      if (state !== 'aim' || over) return;
      // The box the defender protects: arc clean over it to keep the swish.
      var x0 = sX(W.zx - W.zh), x1 = sX(W.zx + W.zh), y0 = sY(W.zTop), y1 = sY(W.zBot);
      ctx.save(); ctx.strokeStyle = hexA(C.magenta, 0.38); ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 5]); rr(x0, y0, x1 - x0, y1 - y0, 5); ctx.stroke(); ctx.restore();
      var pts = preview();
      for (var i = 0; i < pts.length; i++) {
        var f = 1 - i / pts.length;
        ctx.fillStyle = hexA(C.cyan, 0.10 + f * 0.6);
        ctx.beginPath(); ctx.arc(sX(pts[i].x), sY(pts[i].y), 1.2 + f * 2.2, 0, Math.PI * 2); ctx.fill();
      }
    }
    function drawBall() {
      var r = Math.max(3, W.br * scale), bx = sX(ball.x), by = sY(ball.y), i;
      if (!reduced) for (i = 0; i < trail.length; i++) {
        ctx.fillStyle = hexA(C.orange, 0.24 * (1 - i / trail.length));
        ctx.beginPath(); ctx.arc(sX(trail[i].x), sY(trail[i].y), r * (1 - i / (trail.length * 1.6)), 0, 6.284);
        ctx.fill();
      }
      ctx.save(); ctx.shadowColor = C.orange; ctx.shadowBlur = r * 2.2; ctx.fillStyle = C.orange;
      ctx.beginPath(); ctx.arc(bx, by, r, 0, 6.284); ctx.fill();
      ctx.shadowBlur = 0; ctx.strokeStyle = hexA(C.bg, 0.8); ctx.lineWidth = Math.max(1, r * 0.16);
      ctx.beginPath(); ctx.moveTo(bx - r, by); ctx.lineTo(bx + r, by); ctx.moveTo(bx, by - r);
      ctx.lineTo(bx, by + r); ctx.stroke(); ctx.restore();
    }
    /** Scoreboard: a fixed-height panel overlaid on the top of the court. */
    function drawHud() {
      var i, bh = hudH, bTop = hudTop;
      ctx.save(); ctx.shadowColor = C.cyan; ctx.shadowBlur = 14;
      ctx.fillStyle = hexA(C.cyan, 0.05); ctx.strokeStyle = hexA(C.cyan, 0.28); ctx.lineWidth = 1.5;
      rr(8, bTop, cssW - 16, bh, 12); ctx.fill(); ctx.stroke(); ctx.restore();
      ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      ctx.font = '700 ' + Math.round(clamp(bh * 0.14, 10, 16)) + 'px Rajdhani, system-ui, sans-serif';
      ctx.fillStyle = C.dim; ctx.fillText('BEST ' + bestEver, 20, bTop + bh * 0.20);
      ctx.textAlign = 'right'; ctx.fillStyle = C.acid;
      ctx.fillText(swishes + ' SWISH', cssW - 20, bTop + bh * 0.20);
      ctx.textAlign = 'center'; ctx.fillStyle = C.ink; ctx.shadowColor = C.cyan; ctx.shadowBlur = 24;
      ctx.font = '900 ' + Math.round(clamp(bh * 0.36, 16, 52)) + 'px Orbitron, system-ui, sans-serif';
      ctx.fillText(String(score), cssW / 2, bTop + bh * 0.30); ctx.shadowBlur = 0;
      if (bh < 40) return;   // too short for a caption AND a pip row; the panel keeps its own text
      ctx.font = '600 ' + Math.round(clamp(bh * 0.10, 9, 12)) + 'px Rajdhani, system-ui, sans-serif';
      ctx.fillStyle = C.dim;
      ctx.fillText('SWISH! · SHOT ' + Math.min(shotIdx + 1, SHOTS) + ' OF ' + SHOTS, cssW / 2, bTop + bh * 0.58);
      // One pip per attempt: acid = clean, orange = in, dim = miss.
      var pw = Math.min(18, (cssW - 60) / SHOTS, bh * 0.22), gap = pw * 0.35,
          pxs = (pw * SHOTS + gap * (SHOTS - 1)) / 2;
      for (i = 0; i < SHOTS; i++) {
        var k = log[i], col = k === 'SWISH' ? C.acid : (k ? C.orange : hexA(C.cyan, 0.2));
        ctx.fillStyle = col; ctx.shadowColor = col; ctx.shadowBlur = k ? 8 : 0;
        rr(cssW / 2 - pxs + i * (pw + gap), bTop + bh * 0.72, pw, pw * 0.34, 3); ctx.fill();
      }
    }
    function drawBar() {
      ctx.fillStyle = hexA(C.bg, 0.92); ctx.fillRect(0, stripTop, cssW, cssH - stripTop);
      ctx.strokeStyle = hexA(C.cyan, 0.22); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, stripTop + 0.5); ctx.lineTo(cssW, stripTop + 0.5); ctx.stroke();
      var fs = Math.round(clamp(cssH * 0.025, 10, 14)), mid = stripTop + STRIP / 2, m = Math.max(8, cssW * 0.03);
      ctx.font = '700 ' + fs + 'px Rajdhani, system-ui, sans-serif'; ctx.textBaseline = 'middle';
      ctx.textAlign = 'left'; ctx.fillStyle = C.ink; ctx.fillText('ANG ' + Math.round(angle) + '°', m, mid);
      ctx.textAlign = 'right'; ctx.fillStyle = C.dim; ctx.fillText('SHOT ' + Math.min(shotIdx + 1, SHOTS) + '/' + SHOTS, cssW - m, mid);
      var mw = Math.max(50, cssW * 0.26), mx = (cssW - mw) / 2, my = mid - 5;
      ctx.fillStyle = hexA(C.cyan, 0.14); rr(mx, my, mw, 10, 5); ctx.fill();
      ctx.fillStyle = C.acid; ctx.shadowColor = C.acid; ctx.shadowBlur = 10;
      rr(mx, my, mw * power, 10, 5); ctx.fill(); ctx.shadowBlur = 0;
      ctx.textAlign = 'center';
      for (var i = 0; i < buttons.length; i++) {
        var b = buttons[i], down = holding === b.id, col = b.id === 'shoot' ? C.acid : C.cyan;
        ctx.font = '700 ' + Math.round(clamp(b.h * 0.26, 10, 16)) + 'px Rajdhani, system-ui, sans-serif';
        ctx.fillStyle = down ? hexA(col, 0.32) : hexA(col, 0.10);
        ctx.strokeStyle = hexA(col, down ? 0.9 : 0.45); ctx.lineWidth = 1.5;
        ctx.shadowColor = col; ctx.shadowBlur = down ? 18 : 0;
        rr(b.x, b.y, b.w, b.h, 10); ctx.fill(); ctx.stroke(); ctx.shadowBlur = 0;
        ctx.fillStyle = col; ctx.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2);
      }
    }
    /**
     * Largest size at or below `want` at which `s` still fits the canvas width.
     * `want` is itself capped by the smaller canvas dimension, so a tall portrait
     * stage cannot balloon the text, and a long string still shrinks to fit.
     */
    function fitSize(weight, fam, want, hi, lo, s) {
      var lim = cssW * 0.92, f = Math.round(clamp(want, lo, hi));
      while (f > lo) {
        ctx.font = weight + ' ' + f + 'px ' + fam;
        if (ctx.measureText(s).width <= lim) return f;
        f--;
      }
      return lo;
    }
    function card(title, sub, color, hint) {
      ctx.fillStyle = hexA(C.bg, 0.76); ctx.fillRect(0, 0, cssW, cssH);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      var tf = fitSize('900', 'Orbitron, system-ui, sans-serif',
        Math.min(cssH * 0.13, cssW * 0.14), 58, 16, title);
      ctx.font = '900 ' + tf + 'px Orbitron, system-ui, sans-serif';
      ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 28;
      ctx.fillText(title, cssW / 2, cssH * 0.40); ctx.shadowBlur = 0;
      var bf = Math.min(cssH * 0.045, cssW * 0.055);
      var lines = sub ? (Object.prototype.toString.call(sub) === '[object Array]' ? sub : [sub]) : [];
      ctx.fillStyle = C.dim;
      for (var i = 0; i < lines.length; i++) {
        var f = fitSize('600', 'Rajdhani, system-ui, sans-serif', bf, 21, 10, lines[i]);
        ctx.font = '600 ' + f + 'px Rajdhani, system-ui, sans-serif';
        ctx.fillText(lines[i], cssW / 2, cssH * 0.49 + i * f * 1.35);
      }
      if (hint) {
        var hf = fitSize('600', 'Rajdhani, system-ui, sans-serif', bf, 21, 10, hint);
        ctx.font = '600 ' + hf + 'px Rajdhani, system-ui, sans-serif';
        ctx.fillText(hint, cssW / 2, cssH * 0.60);
      }
    }
    function draw(now) {
      ctx.fillStyle = C.bg; ctx.fillRect(0, 0, cssW, cssH);
      // The world is clipped to the court band so a high arc can never paint over the
      // scoreboard panel or the ANG/POW strip.
      ctx.save(); ctx.beginPath(); ctx.rect(0, courtTop, cssW, Math.max(0, stripTop - courtTop)); ctx.clip();
      drawCourt(); drawHoop(now); drawPreview();
      var hot = flashAt > 0 && (now - flashAt) < 240;
      drawFigure(sX(W.zx), sY(W.ground), W.defH * scale, hot ? C.magenta : C.violet, -Math.PI / 2, defJump);
      if (state === 'aim') drawFigure(sX(W.shooterX), sY(W.ground), W.defH * 0.92 * scale, C.cyan, angle * Math.PI / 180, 0);
      drawBall();
      ctx.restore();
      // CRT polish: scanlines + vignette, applied to the WORLD only so the
      // scoreboard, angle/power strip and touch buttons below stay bright.
      if (!reduced) { ctx.fillStyle = 'rgba(0,0,0,.15)';
        for (var sy = 0; sy < cssH; sy += 3) ctx.fillRect(0, sy, cssW, 1); }
      var vig = ctx.createRadialGradient(cssW / 2, cssH / 2, Math.min(cssW, cssH) * 0.34,
        cssW / 2, cssH / 2, Math.max(cssW, cssH) * 0.76);
      vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(0,0,0,.55)');
      ctx.fillStyle = vig; ctx.fillRect(0, 0, cssW, cssH);
      // Result banner, over the hoop — above the CRT layer so it stays legible.
      if (msg && state === 'settle' && msgT < HOLD) {
        var fade = msgT < HOLD - 0.3 ? 1 : (HOLD - msgT) / 0.3;
        var col = msg.swish ? C.acid : (msg.kind === 'MISS' ? C.dim : C.orange);
        var bx = sX(W.rimX - 4), by = sY(W.rim - W.hh * 0.95);
        ctx.save(); ctx.globalAlpha = clamp(fade, 0, 1);
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.font = '900 ' + Math.round(clamp(cssH * 0.07, 15, 32)) + 'px Orbitron, system-ui, sans-serif';
        ctx.fillStyle = col; ctx.shadowColor = col; ctx.shadowBlur = 20; ctx.fillText(msg.kind, bx, by);
        if (msg.pts > 0) {
          ctx.font = '700 ' + Math.round(clamp(cssH * 0.036, 12, 19)) + 'px Rajdhani, system-ui, sans-serif';
          ctx.fillText('+' + msg.pts, bx, by + clamp(cssH * 0.05, 18, 32));
        }
        ctx.restore();
      }
      drawHud(); drawBar();
      if (hintT > 0 && hint) {   // a shoot press that arrived mid-shot gets an answer
        ctx.save(); ctx.globalAlpha = clamp(hintT / 0.3, 0, 1);
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.font = '700 ' + Math.round(clamp(cssH * 0.035, 11, 18)) + 'px Rajdhani, system-ui, sans-serif';
        ctx.fillStyle = C.orange; ctx.shadowColor = C.orange; ctx.shadowBlur = 12;
        ctx.fillText(hint, cssW / 2, stripTop - Math.max(10, cssH * 0.03));
        ctx.restore();
      }
      if (over) card('GAME OVER', ['SCORE ' + score, (isRecord ? 'NEW BEST  ·  ' : '') + swishes +
        ' SWISH' + (swishes === 1 ? '' : 'ES')], C.magenta, 'TAP or press SPACE to play again');
      else if (paused) card('PAUSED', 'Tap or press a key to resume', C.cyan, null);
      else if (!booted) card('READY', 'Drag to aim · release to shoot', C.cyan, 'Ten shots. Make them count');
    }
    /* -------------------------- Single rAF loop -------------------------- */
    function frame(now) {
      if (destroyed) return;   // guard: destroy() can land between frames
      var dt = Math.min(0.05, (now - last) / 1000) || 0; // clamp so a backgrounded tab cannot fast-forward
      last = now;
      if (!paused && !over) {
        if (holding && now >= holdNext) { holdNext = now + 110; pressButton(holding, now); }
        update(dt);
      }
      draw(now);
      // destroy() can run from inside api.gameOver(), which update() may have called.
      if (destroyed) return;
      rafId = requestAnimationFrame(frame);
    }
    var last = performance.now();
    resetRun();
    rafId = requestAnimationFrame(frame);
    return {
      destroy: function () {
        if (destroyed) return;
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
    name: 'Swish!',
    instructions:
      'Ten shots, one hoop. DRAG anywhere on the court to aim — drag right for a higher arc, drag up for ' +
      'more power — and RELEASE to shoot. The dotted arc is your predicted path; the dashed magenta ' +
      'box is where the defender can reach, so arc clean OVER it to keep a swish. The ANG / POW ' +
      'buttons and the big SHOOT button work too. Keyboard: LEFT and RIGHT aim, UP and DOWN set ' +
      'power, SPACE shoots, P pauses. A clean swish is 100 plus a 20-point streak bonus and up to ' +
      '40 for distance; a bank off the glass is 45 and a rattle off the rim 20. Every attempt is ' +
      'longer, the rim narrows, the contest box grows and the defender gets bolder. Best score is ' +
      'saved on this device.',
    start: start
  };
})();
