/**
 * PIXEL RUSH — games/speed-trap.js — "Speed Trap"
 * Contract (GAME-CONTRACT.md): window.PixelGame = { name, instructions, start(root, api) }
 * where api = { setScore(n), setBest(n), gameOver(score) } and start() returns { destroy() }.
 * Self-contained: no imports, no dependencies, no assets — one <canvas> + 2D ctx, and every
 * rAF id, listener and timer created in start() is torn down in destroy().
 */
(function () {
  'use strict';
  /* -------------------------------- Tuning -------------------------------- */
  var STORE_KEY = 'pixelrush.speed-trap.best'; // localStorage: all-time best score
  var LIVES = 3;                 // failures allowed before the run ends
  var ACC_HOLD = 0.80;           // needle acceleration while the input is held (units/s^2)
  var ACC_DROP = 1.05;           // …and the fall rate once it is released
  var DAMP = 0.90;               // velocity damping: gives the needle a terminal speed
                                 // (hold ≈ 0.89 u/s, release ≈ 1.17 u/s) instead of a hard stop
  var VEL_MAX = 1.45;            // absolute speed ceiling, a safety net only
  var BAND_W0 = 0.18, BAND_W1 = 0.070, BAND_W2 = 0.045; // band half-height: start … full ramp … floor
  var RAMP_T = 45;               // seconds over which difficulty reaches its first plateau
  var DRIFT_W0 = 0.18, DRIFT_W1 = 0.85, DRIFT_W2 = 1.20; // band drift rate (rad/s)
  var DRIFT_A = 0.25;            // band drift amplitude around mid-scale
  var EDGE = 0.05;               // the band never hugs either end of the scale
  var GAP0 = 0.085, GAP1 = 0.045; // redline strip between the band top and the overheat line
  var CORE_F0 = 0.50, CORE_F1 = 0.34; // core half-height as a fraction of the band
  var JINK_FIRST = 7;            // seconds before the band first lurches sideways
  var JINK_GAP0 = 9, JINK_GAP1 = 5.0; // seconds between lurches, early … late
  var JINK_AMP0 = 0.10, JINK_AMP1 = 0.20; // how far each lurch throws the band
  var JINK_LIM = 0.34;           // cap on how far the offsets can stack up
  var JINK_SWING = 0.16;         // seconds for a lurch to play out
  var MULT_UP = 0.85;            // multiplier steps per second riding the core
  var MULT_DN = 0.50;            // …and lost per second merely inside the outer band
  var CHARGE_UP = 4.5;           // seconds in the core to fill the charge bar from empty
  var CHARGE_SAFE = 1.6;         // …slower fill while merely inside the band
  var CHARGE_DN0 = 3.2, CHARGE_DN1 = 1.6; // seconds to drain it while out of band
  var CHARGE_REFILL = 0.5;       // charge handed back with a replacement life
  var CHARGE_START = 0.35;       // …and what a fresh run gets, so no free OVERDRIVE
  var POINT_SEC = 10;            // score for each consecutive second inside the band
  var CORE_SEC = 12;             // …and the extra tick for that second spent in the core
  var MULT_MAX = 9;
  var OVERDRIVE = 150;           // score bonus for a full charge bar
  var RECOVER = 0.9;             // seconds of immunity after losing a life
  // Everything the spec does not name, prefixed `st-` so it cannot collide with
  var STYLES = '.st{position:relative;width:100%;height:100%;overflow:hidden;touch-action:none;' +
    'user-select:none;-webkit-tap-highlight-color:transparent;' +
    'font-family:var(--font-body,"Rajdhani",system-ui,sans-serif);color:var(--ink,#f2f5ff)}' +
    '.st canvas{display:block;width:100%;height:100%;outline:none}';
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function ease(t) { return t * t * (3 - 2 * t); } // smooth 0→1 ramp for the difficulty curve
  function readBest() {
    try { var v = parseInt(window.localStorage.getItem(STORE_KEY), 10);
      return isFinite(v) && v > 0 ? v : null; } catch (e) { return null; } // private mode
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
    var gameOverCb = typeof api.gameOver === 'function' ? api.gameOver : function () {};
    var setStatus  = typeof api.setStatus === 'function' ? api.setStatus : function () {};
    /* -------------------------------- DOM -------------------------------- */
    var wrap = document.createElement('div'); wrap.className = 'st';
    var canvas = document.createElement('canvas');
    canvas.setAttribute('tabindex', '0'); canvas.setAttribute('role', 'application');
    canvas.setAttribute('aria-label',
      'Speed Trap gauge. Hold space, the up arrow, or anywhere on the screen to raise the needle.');
    var live = document.createElement('div'); // screen-reader announcements
    live.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0)';
    live.setAttribute('aria-live', 'polite');
    wrap.appendChild(canvas); wrap.appendChild(live);
    var styleTag = document.createElement('style');
    styleTag.textContent = STYLES; wrap.appendChild(styleTag); root.appendChild(wrap); // one <style>, scoped to .st
    var ctx = canvas.getContext('2d');
    if (!ctx) { root.removeChild(wrap); return { destroy: function () {} }; }
    var rafId = 0, destroyed = false;
    var reduced = !!(window.PX && window.PX.reduced) ||
      !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    var score = 0, mult = 1, lives = LIVES, charge = 1, inT = 0, t = 0, bestEver = readBest();
    var needle = 0.5, vel = 0, band = { lo: 0.35, hi: 0.65 }, overheat = 1, phase = 0;
    var coreLo = 0.45, coreHi = 0.55, multProg = 0, jinkOff = 0, jinkTo = 0, jinkAt = JINK_FIRST, peakMult = 1;
    var holding = false, ptrDown = false, keyDown = false, booted = false, paused = false,
      over = false, isRecord = false;
    var protect = 0, last = 0, flashAt = -1e9, flashMsg = '', flashColor = null, inBand = false,
      inCore = false, lastMsg = '';
    /* ----------------- Sizing (crisp devicePixelRatio) ----------------- */
    var dpr = 1, cssW = 1, cssH = 1, gw = 10, gx = 0, gy = 0, gh = 10;
    var cbw = 10, cbx = 0, cby = 0, py = 0, padH = 44;
    var hudFS = 14, bigFS = 40, multFS = 20, topY = 20;
    /* Vertical stack, top to bottom: score HUD (best + score + multiplier), gauge,
       charge bar with its labels, hold pad. Every band is measured first and the
       gauge is given only what is actually left over, so nothing can spill into
       the strip below it on a phone-sized stage. */
    function layout() {
      // Every size is capped by the WIDTH as well as the height: on a portrait phone
      // the stage is taller than it is wide, so a height-only size balloons and the
      // readouts run off the edges.
      hudFS  = Math.round(clamp(Math.min(cssH * 0.042, cssW * 0.046), 10, 17));
      bigFS  = Math.round(clamp(Math.min(cssH * 0.085, cssW * 0.10), 18, 46));
      multFS = Math.round(clamp(Math.min(cssH * 0.05, cssW * 0.055), 11, 24));
      // Bottom-up: hold pad, then 8px of air, then the 30px charge-bar strip.
      padH = Math.min(Math.round(clamp(cssH * 0.12, 22, 74)), Math.max(12, cssH - 46));
      cby = Math.max(8, cssH - padH - 38);  // charge bar top
      py = cby + 38;                        // hold pad top
      // The gauge starts under the multiplier line, not under a guessed fraction of
      // the height, so the HUD and the gauge can never share a row.
      topY = 4 + bigFS * 0.55;              // centre of the big score == BEST baseline
      // +7 keeps a clear lane under the multiplier for its "next step" progress bar.
      gy = Math.round(topY + bigFS * 0.55 + multFS * 0.55 + multFS * 0.6 + 7);
      gh = Math.max(8, cby - 8 - gy);      // whatever is left, and never a forced minimum
      gw = Math.round(clamp(Math.min(cssW * 0.46, cssH * 0.6), 28, 190));
      gx = Math.round((cssW - gw) / 2);
      cbw = Math.round(Math.min(cssW * 0.72, gw * 2.4));
      cbx = Math.round((cssW - cbw) / 2);
    }
    function resize() {
      var r = wrap.getBoundingClientRect();
      cssW = Math.max(1, Math.round(r.width)); cssH = Math.max(1, Math.round(r.height));
      dpr = clamp(window.devicePixelRatio || 1, 1, 2); // cap DPR: fill-rate win on high-density phones
      canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
      canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      layout();
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
      return isFinite(n) ? 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')'
        : 'rgba(255,255,255,' + a + ')';
    }
    function rr(x, y, w, h, r) { // rounded-rect path, with a pre-roundRect fallback
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
    }
    function yAt(v) { return gy + gh * (1 - v); } // gauge value 0..1 -> canvas y
    /* ---------------------------- Game logic ---------------------------- */
    function load() { return ease(clamp(t / RAMP_T, 0, 1)); }              // main ramp 0 → 1
    function load2() { return ease(clamp((t - RAMP_T) / (RAMP_T * 0.9), 0, 1)); } // squeeze past it
    function gap() { var k = load(); return GAP0 + (GAP1 - GAP0) * k; }
    function updateBand() {
      var k = load(), k2 = load2();
      var w = BAND_W0 + (BAND_W1 - BAND_W0) * k + (BAND_W2 - BAND_W1) * k2;
      var sp = DRIFT_W0 + (DRIFT_W1 - DRIFT_W0) * k + (DRIFT_W2 - DRIFT_W1) * k2;
      var amp = DRIFT_A * (1 + 0.3 * k2);
      // Two incommensurate sines keep the band unpredictable instead of memorisable.
      var c = 0.5 + amp * (Math.sin(phase * sp) + 0.35 * Math.sin(phase * sp * 1.7 + 1.1));
      var lo = w + EDGE, hi = 1 - w - EDGE - gap();
      c = Math.min(Math.max(c + jinkOff, lo), Math.max(lo, hi)); // never hugs a stop, never un-loseable
      band.lo = c - w; band.hi = c + w;
      var cr = w * (CORE_F0 + (CORE_F1 - CORE_F0) * (0.4 * k + 0.6 * k2));
      coreLo = c - cr; coreHi = c + cr;
      overheat = band.hi + gap();
    }
    function jink() {
      if (t < jinkAt || protect > 0) return;
      var k = load();
      jinkAt = t + JINK_GAP0 + (JINK_GAP1 - JINK_GAP0) * k;
      var d = (Math.random() < 0.5 ? -1 : 1) * (JINK_AMP0 + (JINK_AMP1 - JINK_AMP0) * k);
      jinkTo = clamp(jinkTo + d, -JINK_LIM, JINK_LIM);
      bang('SHIFT', C.cyan);
    }
    function resetRun() {
      t = 0; phase = 0; score = 0; mult = 1; lives = LIVES; charge = CHARGE_START; inT = 0; peakMult = 1;
      needle = 0.5; vel = 0; holding = false; ptrDown = false; keyDown = false; inBand = false; inCore = false; multProg = 0;
      jinkOff = 0; jinkTo = 0; jinkAt = JINK_FIRST;
      over = false; isRecord = false; protect = 0; last = performance.now();
      // `booted` is set by the first press, not here, so the opening card reads READY.
      paused = !booted; flashAt = -1e9; flashMsg = ''; lastMsg = '';
      updateBand(); setScore(0);
      if (bestEver !== null) setBest(bestEver);
      live.textContent = 'New run. Score 0.';
    }
    function addScore(n) {
      score += n;
      setScore(score);                                 // HUD mirrors the live score
      if (bestEver === null || score > bestEver) {
        bestEver = score; isRecord = true; writeBest(score); setBest(score);
      }
    }
    function bang(msg, color) { flashAt = performance.now(); flashMsg = msg; flashColor = color; }
    function loseLife(msg, color) {
      if (over || destroyed || protect > 0) return;
      lives--; mult = 1; multProg = 0; inT = 0; charge = CHARGE_REFILL; vel = 0;
      needle = clamp((band.lo + band.hi) / 2, 0.15, 0.85);
      protect = RECOVER; bang(msg, color);
      live.textContent = msg + '. ' + lives + ' lives left.';
      if (lives <= 0) {
        over = true; paused = false;
        live.textContent = msg + '. Final score ' + score + '.';
        gameOverCb(score);                             // EXACTLY ONCE — `over` latches it
      }
    }
    function update(dt) {
      if (paused || over) return;                        // defensive: frame() already gates these
      t += dt; phase += dt;
      jinkOff += (jinkTo - jinkOff) * Math.min(1, dt / JINK_SWING);
      updateBand();
      if (protect > 0) {
        // Recovery parks the needle dead centre of the band and freezes it there, so a
        // player who is still mashing the button gets a clear look at the new band
        // instead of being killed again by a needle they did not choose.
        protect = Math.max(0, protect - dt);
        vel = 0; needle = clamp((band.lo + band.hi) / 2, 0.15, 0.85);
        inBand = true; inCore = needle >= coreLo && needle <= coreHi;
        return;                           // recovering: no scoring, no damage
      }
      // Needle physics: holding pushes it up, releasing lets it fall; damping keeps
      // it from slamming into either stop, which is what makes the gauge holdable.
      vel += (holding ? ACC_HOLD : -ACC_DROP) * dt;
      vel -= vel * DAMP * dt;
      vel = clamp(vel, -VEL_MAX, VEL_MAX);
      needle = clamp(needle + vel * dt, 0, 1);
      var wasIn = inBand;
      inBand = needle >= band.lo && needle <= band.hi;
      inCore = inBand && needle >= coreLo && needle <= coreHi;
      // Leaving the band is now a frequent event, so LOCKED only flashes when the
      // banner is free — otherwise a chattering needle strobes the message.
      if (inBand && !wasIn && performance.now() - flashAt > 600) bang('LOCKED', C.cyan);
      if (needle >= overheat) { loseLife('OVERHEAT', C.orange); return; }
      if (inBand) {
        inT += dt;
        // The multiplier only climbs while the needle is riding the bright core and
        // bleeds back whenever it is merely inside the outer band, so holding one
        // lazy hover in the green is worth nothing.
        multProg += (inCore ? MULT_UP : -MULT_DN) * dt;
        if (multProg >= 1) { if (mult < MULT_MAX) { mult++; multProg -= 1; } else multProg = 1; }
        if (mult > peakMult) peakMult = mult;
        if (multProg < 0) { multProg = 0; if (mult > 1) { mult--; multProg = 1; } }
        charge = Math.min(1, charge + dt / (inCore ? CHARGE_UP : CHARGE_UP * CHARGE_SAFE));
        if (inT >= 1) { inT -= 1; addScore((inCore ? POINT_SEC + CORE_SEC : POINT_SEC) * mult); }
        if (charge >= 1) { charge = 0; addScore(OVERDRIVE * mult); if (mult < MULT_MAX) mult++; bang('OVERDRIVE', C.acid); }
      } else {
        inT = 0;
        if (wasIn) { if (mult > 1) bang('CHAIN LOST', C.dim); mult = 1; multProg = 0; }
        var k = load();
        charge -= dt / (CHARGE_DN0 + (CHARGE_DN1 - CHARGE_DN0) * k);
        if (charge <= 0) { charge = 0; loseLife('COOLANT LOST', C.magenta); return; }
      }
      jink();
      // Only touch the live region when the message actually changes, so screen
      // readers are not spammed 60 times a second.
      var msg = inCore ? 'In the core. Multiplier ' + mult + '. Score ' + score + '.'
        : inBand ? 'In the band. Multiplier ' + mult + '. Score ' + score + '.'
        : 'Out of band. Score ' + score + '.';
      if (msg !== lastMsg) { lastMsg = msg; live.textContent = msg; }
    }
    /* ----------------------------- Drawing ----------------------------- */
    function wrapText(text, maxW) { // greedy word wrap against the live measureText width
      var words = String(text).split(' '), out = [], cur = words[0] || '';
      for (var i = 1; i < words.length; i++) {
        var test = cur + ' ' + words[i];
        if (ctx.measureText(test).width > maxW && cur) { out.push(cur); cur = words[i]; }
        else cur = test;
      }
      out.push(cur);
      return out;
    }
    function card(title, sub, color, lines) {
      ctx.fillStyle = hexA(C.bg, 0.88); ctx.fillRect(0, 0, cssW, cssH);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      var maxW = Math.max(60, cssW - 22);
      var tFS = Math.round(clamp(Math.min(cssH * 0.115, cssW * 0.14), 16, 48));
      // A title is a single unbroken word-block, so wrapText cannot save it: shrink it
      // until the measured width fits, rather than let it clip at both edges.
      ctx.font = '900 ' + tFS + 'px Orbitron, system-ui, sans-serif';
      while (tFS > 16 && ctx.measureText(title).width > maxW) {
        tFS -= 1; ctx.font = '900 ' + tFS + 'px Orbitron, system-ui, sans-serif';
      }
      // Shrink the body until the wrapped block genuinely fits under the title, so a
      // 185px-tall phone stage gets a readable card instead of a wall of text.
      var fs = Math.round(clamp(Math.min(cssH * 0.045, cssW * 0.05), 10, 18)), block = [], lh = 0, total = 0;
      for (var pass = 0; pass < 10; pass++) {
        ctx.font = '600 ' + fs + 'px Rajdhani, system-ui, sans-serif';
        block = [];
        if (sub) block = block.concat(wrapText(sub, maxW));
        for (var i = 0; i < lines.length; i++) block = block.concat(wrapText(lines[i], maxW));
        lh = fs * 1.32; total = tFS * 1.3 + 10 + block.length * lh;
        if (total <= cssH - 10 || fs <= 10) break;
        fs -= 1;
      }
      var y = Math.max(tFS * 0.75, (cssH - total) / 2);
      ctx.font = '900 ' + tFS + 'px Orbitron, system-ui, sans-serif';
      ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 28;
      ctx.fillText(title, cssW / 2, y); ctx.shadowBlur = 0;
      ctx.font = '600 ' + fs + 'px Rajdhani, system-ui, sans-serif';
      y += tFS * 1.3 + 10;
      for (var j = 0; j < block.length; j++) {
        ctx.fillStyle = j === 0 ? C.ink : C.dim;
        ctx.fillText(block[j], cssW / 2, y + j * lh);
      }
    }
    function draw(now) {
      var w = cssW, h = cssH;
      ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);
      // Gauge track.
      ctx.save();
      rr(gx, gy, gw, gh, 18); ctx.fillStyle = 'rgba(255,255,255,.04)'; ctx.fill(); ctx.clip();
      // Everything above the band is redline; the slice between the band top and the
      // overheat line is the strip that actually kills you, so it is the hottest.
      ctx.fillStyle = hexA(C.orange, 0.10); ctx.fillRect(gx, yAt(1), gw, yAt(band.hi) - yAt(1));
      ctx.fillStyle = hexA(C.orange, 0.30); ctx.fillRect(gx, yAt(overheat), gw, yAt(band.hi) - yAt(overheat));
      ctx.fillStyle = hexA(C.magenta, 0.08); ctx.fillRect(gx, yAt(0), gw, yAt(0.04) - yAt(0));
      // Green band: the target, with a hard glow so it reads at 390px wide.
      var by0 = yAt(band.hi), bh = yAt(band.lo) - yAt(band.hi);
      var pulse = reduced ? 1 : 0.82 + 0.18 * Math.sin(now / 300);
      ctx.shadowColor = C.acid; ctx.shadowBlur = 26 * pulse;
      ctx.fillStyle = hexA(C.acid, 0.3); ctx.fillRect(gx, by0, gw, bh);
      ctx.shadowBlur = 0;
      ctx.fillStyle = C.acid; ctx.fillRect(gx + 3, by0, gw - 6, 2); ctx.fillRect(gx + 3, by0 + bh - 2, gw - 6, 2);
      // The core: the narrow bright strip that actually pays. Drawn as its own inset
      // band with caps so it is unmistakable at a glance and on a 390px screen.
      var cy0 = yAt(coreHi), ch = yAt(coreLo) - yAt(coreHi);
      ctx.save(); ctx.shadowColor = inCore ? C.ink : C.acid; ctx.shadowBlur = 18 * pulse;
      ctx.fillStyle = inCore ? hexA(C.ink, 0.92) : hexA(C.acid, 0.85);
      ctx.fillRect(gx + 6, cy0 + 1, gw - 12, Math.max(1, ch - 2));
      ctx.restore();
      // Ticks every 10%.
      ctx.strokeStyle = hexA(C.cyan, 0.16); ctx.lineWidth = 1; ctx.beginPath();
      for (var i = 1; i < 10; i++) { var ty = Math.round(yAt(i / 10)) + 0.5;
        ctx.moveTo(gx, ty); ctx.lineTo(gx + gw, ty); }
      ctx.stroke();
      ctx.restore();
      ctx.save(); rr(gx, gy, gw, gh, 18);
      ctx.strokeStyle = hexA(C.cyan, 0.3); ctx.lineWidth = 2; ctx.shadowColor = hexA(C.cyan, 0.6);
      ctx.shadowBlur = 16; ctx.stroke(); ctx.restore();
      // Overheat threshold marker — it flares while the needle is in the killing strip.
      var red = needle > band.hi;
      ctx.save(); ctx.strokeStyle = hexA(C.orange, red ? 1 : 0.85); ctx.lineWidth = red ? 3 : 2;
      ctx.shadowColor = C.orange; ctx.shadowBlur = red ? 26 : 14;
      ctx.beginPath(); ctx.moveTo(gx - 8, yAt(overheat)); ctx.lineTo(gx + gw + 8, yAt(overheat)); ctx.stroke();
      ctx.restore();
      // Needle: acid inside the band, orange above it, dim violet below.
      var ny = yAt(needle);
      var nCol = inBand ? C.acid : (needle > band.hi ? C.orange : C.violet);
      ctx.save(); ctx.shadowColor = nCol; ctx.shadowBlur = 30;
      ctx.fillStyle = nCol; rr(gx - 12, ny - 4, gw + 24, 8, 4); ctx.fill(); ctx.restore();
      ctx.save(); ctx.fillStyle = C.ink; ctx.beginPath();
      ctx.arc(gx - 14, ny, 5, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      /* CRT polish: scanlines + vignette over the WORLD only — applied before the HUD is
         painted so the score readouts, charge bar and thumb pad stay bright and legible. */
      if (!reduced) { ctx.fillStyle = 'rgba(0,0,0,.16)';
        for (var sy = 0; sy < h; sy += 3) ctx.fillRect(0, sy, w, 1); }
      var vig = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75);
      vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(0,0,0,.55)');
      ctx.fillStyle = vig; ctx.fillRect(0, 0, w, h);
      /* ------------------------------ HUD ------------------------------ */
      // The centred score has to fit between the BEST readout and the life pips at
      // every width, so measure both ends and shrink the score rather than let the
      // digits run over their neighbours on a narrow stage.
      var bestTxt = 'BEST ' + (bestEver || 0);
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left'; ctx.font = '700 ' + hudFS + 'px Rajdhani, system-ui, sans-serif';
      var bestW = ctx.measureText(bestTxt).width;
      var pipsRight = Math.min(w - 12, gx + gw + 4) - (LIVES - 1) * 14 + 9;
      var leftEdge = 10 + bestW + 12, rightEdge = pipsRight - 12;
      var sc = bigFS, sw = 0;
      ctx.textAlign = 'center';
      for (var fit = 0; fit < 8; fit++) {
        ctx.font = '900 ' + sc + 'px Orbitron, system-ui, sans-serif';
        sw = ctx.measureText(String(score)).width;
        if (w / 2 - sw / 2 >= leftEdge || rightEdge >= w / 2 + sw / 2) break;
        if (sc <= 13) break;
        sc -= 2;
      }
      var bestX = clamp(gx - 4, 10, Math.max(10, w / 2 - sw / 2 - 12 - bestW));
      ctx.textAlign = 'left'; ctx.font = '700 ' + hudFS + 'px Rajdhani, system-ui, sans-serif';
      ctx.fillStyle = C.ink; ctx.fillText(bestTxt, bestX, topY);
      // Lives as pips, so a lost life is unmistakable at arm's length.
      for (var L = 0; L < LIVES; L++) {
        var px = Math.min(w - 12, gx + gw + 4) - (LIVES - 1 - L) * 14;
        ctx.fillStyle = L < lives ? C.cyan : hexA(C.dim, 0.6);
        rr(px - 9, topY - 5, 10, 10, 2); ctx.fill();
      }
      // Big centred score + multiplier.
      ctx.textAlign = 'center'; ctx.font = '900 ' + sc + 'px Orbitron, system-ui, sans-serif';
      ctx.fillStyle = C.ink; ctx.shadowColor = hexA(C.cyan, 0.7); ctx.shadowBlur = 14;
      ctx.fillText(String(score), w / 2, topY); ctx.shadowBlur = 0;
      ctx.font = '800 ' + multFS + 'px Orbitron, system-ui, sans-serif';
      ctx.fillStyle = inCore ? C.acid : (inBand ? C.ink : C.dim);
      var multY = topY + bigFS * 0.55 + multFS * 0.55;
      ctx.fillText('x' + mult, cssW / 2, multY);
      // Progress toward the next multiplier step: fills while the needle rides the
      // core, bleeds back while it is only in the band. This is the "hold on" tell.
      var pw = Math.round(clamp(ctx.measureText('x' + mult).width + 30, 26, Math.min(gw, 130))), px0 = Math.round((w - pw) / 2);
      var py2 = Math.round(multY + multFS * 0.52);
      ctx.fillStyle = 'rgba(255,255,255,.10)'; rr(px0, py2, pw, 4, 2); ctx.fill();
      ctx.fillStyle = multProg > 0 ? C.acid : C.orange;
      rr(px0, py2, Math.max(0, pw * multProg), 4, 2); ctx.fill();
      // Charge bar: fills fastest in the core, drains out of the band. Emptying it
      // is a lost life, so it is the run's real clock.
      ctx.fillStyle = 'rgba(255,255,255,.06)'; rr(cbx, cby, cbw, 14, 7); ctx.fill();
      var cCol = charge > 0.35 ? C.acid : C.magenta;
      ctx.save(); ctx.shadowColor = cCol; ctx.shadowBlur = 18; ctx.fillStyle = cCol;
      rr(cbx + 2, cby + 2, Math.max(0, (cbw - 4) * charge), 10, 5); ctx.fill(); ctx.restore();
      var labFS = Math.round(clamp(Math.min(h * 0.032, w * 0.036), 9, 13));
      var stateTxt = inCore ? 'CORE' : (inBand ? 'BAND' : 'DRIFTING');
      ctx.textAlign = 'left'; ctx.font = '700 ' + labFS + 'px Rajdhani, system-ui, sans-serif';
      ctx.fillStyle = C.ink; ctx.fillText('CHARGE', cbx, cby + 26);
      ctx.textAlign = 'right';
      ctx.fillStyle = inCore ? C.acid : (inBand ? C.ink : C.magenta);
      ctx.fillText(stateTxt, cbx + cbw, cby + 26);
      // Escalating-pressure meter, centred between the two charge labels. It is only
      // drawn when the measured labels leave real clearance for it: on a phone the
      // bar is centred on the canvas while the labels are centred on the bar, so a
      // fixed width threshold used to run the two labels into each other.
      var lw = 56, lx = Math.round((w - lw) / 2);
      var chargeW = ctx.measureText('CHARGE').width;
      var loadW = ctx.measureText('LOAD').width;
      var stateW = Math.max(ctx.measureText('DRIFTING').width, ctx.measureText(stateTxt).width);
      // The LOAD label is right-aligned at lx-6, so it reaches back to (lx-6-loadW):
      // the clearance has to be measured against THAT edge, not against the bar.
      if ((lx - 6 - loadW) - (cbx + chargeW) >= 8 && (cbx + cbw - 6 - stateW) - (lx + lw) >= 8) {
        var ld = Math.max(load(), load2() * 0.999);
        ctx.textAlign = 'right'; ctx.fillStyle = C.dim;
        ctx.fillText('LOAD', lx - 6, cby + 26);
        ctx.fillStyle = 'rgba(255,255,255,.10)'; rr(lx, cby + 20, lw, 6, 3); ctx.fill();
        ctx.fillStyle = ld > 0.66 ? C.magenta : C.orange;
        rr(lx, cby + 20, Math.max(2, lw * ld), 6, 3); ctx.fill();
      }
      // Thumb-zone hold pad: lights up while the input is down (mobile affordance).
      ctx.save(); ctx.globalAlpha = holding ? 1 : 0.85;
      ctx.shadowColor = C.cyan; ctx.shadowBlur = holding ? 26 : 10;
      ctx.strokeStyle = C.cyan; ctx.lineWidth = 2;
      rr(cbx, py, cbw, padH, 14); ctx.stroke();
      ctx.fillStyle = hexA(C.cyan, holding ? 0.28 : 0.12); ctx.fill();
      ctx.restore();
      ctx.textAlign = 'center'; ctx.font = '800 ' + Math.round(clamp(Math.min(h * 0.04, w * 0.05), 12, 20)) + 'px Rajdhani, system-ui, sans-serif';
      ctx.fillStyle = C.ink;
      ctx.fillText(holding ? 'HOLDING' : 'HOLD TO CHARGE', w / 2, py + padH / 2);
      // Event banner (OVERHEAT / OVERDRIVE).
      if (flashMsg && now - flashAt < 900) {
        var fa = 1 - (now - flashAt) / 900;
        ctx.globalAlpha = clamp(fa, 0, 1);
        ctx.textAlign = 'center';
        ctx.font = '900 ' + Math.round(clamp(Math.min(h * 0.09, w * 0.105), 18, 40)) + 'px Orbitron, system-ui, sans-serif';
        ctx.fillStyle = flashColor; ctx.shadowColor = flashColor; ctx.shadowBlur = 30;
        ctx.fillText(flashMsg, w / 2, gy + gh * 0.28); ctx.shadowBlur = 0; ctx.globalAlpha = 1;
      }
      if (protect > 0 && !over) {
        ctx.textAlign = 'center'; ctx.font = '800 ' + Math.round(clamp(Math.min(h * 0.06, w * 0.075), 14, 26)) + 'px Orbitron, system-ui, sans-serif';
        ctx.fillStyle = C.cyan; ctx.fillText('RECOVER', w / 2, gy + gh * 0.44);
      }
      if (paused && !over) card(booted ? 'PAUSED' : 'READY',
        booted ? 'Hold again to resume' : 'Ride the bright CORE', C.cyan, booted ? [] : [
          'HOLD anywhere = raise, release = drop',
          'Green is safe. The bright core pays and builds your multiplier.',
          'Cross the orange line = instant overheat.',
          'Outside the band CHARGE drains. Empty = dead. 3 lives.'
        ]);
      if (over) card('GAME OVER',
        'SCORE ' + score + (isRecord ? '  ·  NEW BEST' : ''), C.magenta,
        ['Peak multiplier reached x' + peakMult,
         'HOLD or press SPACE to play again']);
    }
    /* -------------------------- Single rAF loop -------------------------- */
    function frame(now) {
      if (destroyed) return;   // guard: destroy() can land between frames
      var dt = (now - last) / 1000;
      if (!(dt > 0)) dt = 0;                 // never integrate a backwards or NaN step
      dt = Math.min(0.05, dt);               // clamp so a backgrounded tab can't fast-forward
      last = now;
      if (!paused && !over) update(dt);
      draw(now);
      // destroy() can land from inside api.gameOver() — never re-arm after that.
      if (destroyed) return;
      rafId = requestAnimationFrame(frame);
    }
    /* ------------------- Input: one button, everywhere ------------------- */
    // Physical button state is tracked separately from `holding`, so a player who is
    // still pressing when they lose a life is not left with a dead needle.
    function press(src) {        // one place that (re)starts a run and raises the needle
      if (over) { resetRun(); setStatus('Playing'); }    // self-restart under the round-over panel
      if (paused) { paused = false; setStatus('Playing'); }   // keep the sidebar in step with the PAUSED card
      booted = true;
      if (src === 'key') keyDown = true; else ptrDown = true;
      holding = true;
    }
    function release(src) {
      if (src === 'key') keyDown = false; else ptrDown = false;
      holding = keyDown || ptrDown;
    }
    function onKeyDown(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === 'Space' || e.code === 'Enter' || e.code === 'ArrowUp' || e.code === 'KeyW' || e.key === ' ') {
        // A control the player has tabbed onto keeps only the keys it acts on itself:
        // Space/Enter activate a button or a link, and a form control owns typing and
        // arrow navigation. Every other key is ours — otherwise a focused button
        // silently kills the movement keys for the rest of the session.
        var a = document.activeElement;
        if (a && a !== canvas && /^(BUTTON|INPUT|SELECT|TEXTAREA|A|SUMMARY)$/.test(a.tagName)) {
          if (/^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) return;
          if (e.code === 'Space' || e.code === 'Enter' || e.key === ' ') return;
        }
        e.preventDefault(); press('key');
      }
    }
    function onKeyUp(e) {
      if (e.code === 'Space' || e.code === 'Enter' || e.code === 'ArrowUp' || e.code === 'KeyW' || e.key === ' ') release('key');
    }
    function onPointerDown(e) {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
      press('ptr');                                      // hold ANYWHERE on the canvas
    }
    function onPointerUp() { release('ptr'); }
    function onPointerCancel() { release('ptr'); }
    function onResize() { if (!destroyed) resize(); }
    // Auto-pause on focus loss. The sidebar STATUS is driven from here so it never
    // claims "Playing" while the canvas is showing the PAUSED card.
    function onBlur() { if (destroyed) return; ptrDown = false; keyDown = false; holding = false; paused = true; if (!over) setStatus('Paused'); }
    function onVisibility() { if (document.hidden) onBlur(); }
    function onContextMenu(e) { e.preventDefault(); }    // a long press must not open a menu
    // Every listener the game owns, in one table so teardown cannot miss one.
    var BIND = [[document, 'keydown', onKeyDown], [document, 'keyup', onKeyUp],
      [canvas, 'pointerdown', onPointerDown], [canvas, 'pointerup', onPointerUp],
      [canvas, 'pointercancel', onPointerCancel],
      [canvas, 'contextmenu', onContextMenu],
      [window, 'resize', onResize, { passive: true }], [window, 'orientationchange', onResize],
      [window, 'blur', onBlur], [document, 'visibilitychange', onVisibility]];
    BIND.forEach(function (b) { b[0].addEventListener(b[1], b[2], b[3]); });
    resetRun(); rafId = requestAnimationFrame(frame);
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
    name: 'Speed Trap',
    instructions:
      'One button, one gauge. HOLD (space, up arrow, W, or anywhere on the screen) to push the ' +
      'needle up; release and it falls. The green band is safe; the bright CORE inside it is where ' +
      'the game is actually played. Ride the core and your multiplier climbs — every step up makes ' +
      'every tick worth more. Drift out of the core but stay in the band and the multiplier ' +
      'bleeds back down, and the CHARGE bar fills far more slowly. Each full second in the band ' +
      'scores 10 x your multiplier, 22 x while you are in the core, and a CHARGE bar ridden to full ' +
      'pays an OVERDRIVE bonus of 150 x your multiplier — the big score jumps. ' +
      'Push the needle past the orange line and you OVERHEAT: instant life lost. Sit outside the band ' +
      'and CHARGE drains; when it empties the coolant is gone and you lose a life. Leaving the band ' +
      'at all resets your multiplier to x1. You have three lives. The band keeps narrowing, keeps ' +
      'drifting faster, and lurches sideways without warning the longer you survive. Best score is ' +
      'saved on this device.',
    start: start
  };
})();
