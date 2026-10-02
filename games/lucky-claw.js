/**
 * PIXEL RUSH — games/lucky-claw.js — "Lucky Claw"
 * Contract (GAME-CONTRACT.md): window.PixelGame = { name, instructions, start(root, api) }
 * where api = { setScore(n), setBest(n), gameOver(score) } and start() returns { destroy() }.
 * Self-contained: no imports, no dependencies, no assets — one <canvas> + 2D ctx. Every rAF id
 * and listener created in start() is torn down in destroy().
 */
(function () {
  'use strict';
  /* -------------------------------- Tuning -------------------------------- */
  var STORE_KEY = 'pixelrush.lucky-claw.best'; // localStorage: all-time best score
  var COLS = 7, ROWS = 2;      // prize well: 7 columns x 2 rows, plus a chute column on the right
  var DROPS = 12;              // the whole run — every tap spends one
  var DROP_MS = 430, CLOSE_MS = 170, SLIP_MS = 470, LIFT_MS = 540, CHUTE_MS = 300;
  var SWEEP_BASE = 280;        // claw sweep speed px/s at level 0 …
  var SWEEP_GAIN = 26;         // … plus this per level …
  var SWEEP_MAX = 560;         // … capped here so the perfect window stays humanly hittable
  var GRAB_FRAC = 0.44;        // grab window, as a fraction of one column's width
  var PERFECT_FRAC = 0.19;     // dead-centre window for a perfect drop
  var SLIP_BASE = 0.07;        // chance the grab slips …
  var SLIP_GAIN = 0.016;       // … plus this per level …
  var PERFECT_MIN = 120;       // only magenta/acid prizes can be PERFECT
  // Prize ladder. `c` indexes into the neon palette at draw time.
  var TIERS = [
    { v: 10, c: 'cyan' }, { v: 25, c: 'violet' }, { v: 60, c: 'orange' },
    { v: 120, c: 'magenta' }, { v: 300, c: 'acid' }
  ];
  var STYLES = '.lc{position:relative;width:100%;height:100%;overflow:hidden;touch-action:none;' +
    'user-select:none;-webkit-tap-highlight-color:transparent;' +
    'font-family:var(--font-body,"Rajdhani",system-ui,sans-serif);color:var(--ink,#f2f5ff)}' +
    '.lc canvas{display:block;width:100%;height:100%;outline:none}';

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
    var gameOverCb = typeof api.gameOver === 'function' ? api.gameOver : function () {};
    // The shell owns the HUD STATUS row; it knows nothing about our pause state.
    var setStatus  = typeof api.setStatus === 'function' ? api.setStatus : function () {};
    /* -------------------------------- DOM -------------------------------- */
    var wrap = document.createElement('div'); wrap.className = 'lc';
    var canvas = document.createElement('canvas');
    canvas.setAttribute('tabindex', '0'); canvas.setAttribute('role', 'application');
    canvas.setAttribute('aria-label', 'Lucky Claw. Tap the screen or press Space to drop the claw.');
    var live = document.createElement('div'); // screen-reader announcements
    live.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0)';
    live.setAttribute('aria-live', 'polite');
    wrap.appendChild(canvas); wrap.appendChild(live);
    var styleTag = document.createElement('style');
    styleTag.textContent = STYLES; wrap.appendChild(styleTag); root.appendChild(wrap);
    var ctx = canvas.getContext('2d');
    if (!ctx) { root.removeChild(wrap); return { destroy: function () {} }; }
    var rafId = 0, destroyed = false;
    var reduced = !!((window.PX && window.PX.reduced) ||
      (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches));
    /* ------------------------------ State ------------------------------ */
    var bed = [];                 // bed[row][col] = prize object {t,v}
    var score = 0, bestEver = readBest(), isRecord = false;
    var dropsLeft = DROPS, level = 0, mult = 1, streak = 0;
    var state = 'ready', stateT = 0;   // ready|sweep|descend|close|slip|lift|chute
    var clawX = 0, clawY = 0, clawDir = 1, grip = 0;   // grip 0 = open, 1 = closed
    var targetX = 0, col = 0, dx = 0, carried = null, prize = null;
    var fromX = 0, fromY = 0, chuteX = 0, chuteY = 0, fallP = null, chuteFlash = 0, perfectFlash = 0;
    var popups = [], booted = false, paused = false;
    var over = false;             // hard guard: api.gameOver() fires at most once per run
    /* ----------------- Sizing (crisp devicePixelRatio) ----------------- */
    var dpr = 1, cssW = 1, cssH = 1, colStep = 10, rowStep = 10, cellPx = 10;
    var bedX = 0, bedW = 1, bedY = 0, bedH = 1, grabHalf = 4, perfectHalf = 1, grabY = 0, restY = 0;
    var btnW = 1, btnH = 1, btnX = 0, btnY = 0;
    function resize() {
      var r = wrap.getBoundingClientRect();
      cssW = Math.max(1, Math.round(r.width)); cssH = Math.max(1, Math.round(r.height));
      dpr = clamp(window.devicePixelRatio || 1, 1, 2); // cap DPR: fill-rate win on 3x phones
      canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
      canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Portrait and landscape both just work: everything is a fraction of the box.
      var pad = Math.max(8, cssW * 0.05);
      bedW = cssW - pad * 2; bedX = pad;
      colStep = bedW / (COLS + 1);                 // the +1 is the prize chute
      btnH = clamp(cssH * 0.11, 42, 66);
      btnW = Math.min(cssW * 0.56, 300);
      btnX = (cssW - btnW) / 2;
      btnY = cssH - btnH - Math.max(8, cssH * 0.02); // thumb zone, never clipped by the edge
      restY = Math.max(20, cssH * 0.085);
      var ceiling = btnY - btnH * 0.3 - 12;        // top of the well must clear the button
      bedY = restY + colStep * 1.1;                // room for the cable to pay out
      bedH = clamp(colStep * ROWS * 1.9, 40, Math.max(40, ceiling - bedY));
      if (bedY + bedH > ceiling) bedY = Math.max(restY + 10, ceiling - bedH);
      rowStep = bedH / ROWS;
      cellPx = Math.min(colStep, rowStep);
      grabHalf = colStep * GRAB_FRAC;
      perfectHalf = colStep * PERFECT_FRAC;
      grabY = bedY + rowStep * 0.5;
      chuteX = bedX + (COLS + 0.5) * colStep;
      chuteY = bedY + rowStep * 0.7;
      if (!booted) clawX = minX(); else clawX = clamp(clawX, minX(), maxX());
    }
    function minX() { return bedX + 0.5 * colStep; }
    function maxX() { return bedX + (COLS - 0.5) * colStep; }
    function colCenter(i) { return bedX + (i + 0.5) * colStep; }
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
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
    }
    function smooth(t) { return t * t * (3 - 2 * t); }
    /* ---------------------------- Game logic ---------------------------- */
    /** Roll a prize, biasing the high tiers down as the run escalates. */
    function rollPrize() {
      var w = [40, 28, 16, Math.max(2, 13 - level * 1.4), Math.max(0.5, 4 - level * 0.6)];
      var sum = w[0] + w[1] + w[2] + w[3] + w[4], r = Math.random() * sum;
      for (var i = 0; i < w.length; i++) { r -= w[i]; if (r <= 0) return { t: i, v: TIERS[i].v }; }
      return { t: 0, v: TIERS[0].v };
    }
    function fillBed() {
      bed = [];
      for (var r = 0; r < ROWS; r++) { var row = []; for (var c = 0; c < COLS; c++) row.push(rollPrize()); bed.push(row); }
    }
    function resetRun() {
      fillBed();
      score = 0; dropsLeft = DROPS; level = 0; mult = 1; streak = 0;
      state = 'sweep'; stateT = 0; grip = 0; carried = null; prize = null; fallP = null;
      popups = []; chuteFlash = 0; perfectFlash = 0;
      clawX = minX(); clawY = restY; clawDir = 1;
      over = false; paused = false; booted = true;
      setScore(0); setBest(bestEver);
      setStatus('Playing');
      live.textContent = 'New run. Score 0. ' + DROPS + ' drops.';
    }
    function addScore(n) {
      score += n; setScore(score);
      if (score > bestEver) { bestEver = score; isRecord = true; writeBest(score); setBest(score); }
    }
    function popup(text, x, y, color) { popups.push({ text: text, x: x, y: y, c: color, t: 0 }); }
    function bumpMult() {
      streak++; mult = Math.min(9, mult + 1);
      perfectFlash = 1;
      popup('x' + mult, clawX, grabY - cellPx * 0.9, C.acid);
    }
    function breakMult() { mult = 1; streak = 0; }
    /** The one place a tap becomes a claw drop. */
    function drop() {
      if (over || state !== 'sweep') return;
      dropsLeft--; level++;
      targetX = clawX; fromX = clawX; fromY = clawY; state = 'descend'; stateT = 0;
      col = clamp(Math.round((targetX - bedX - 0.5 * colStep) / colStep), 0, COLS - 1);
      dx = Math.abs(targetX - colCenter(col));
    }
    /** Resolve what the claw actually caught. Runs when the cable hits the prize row. */
    function resolve() {
      prize = bed[0][col];
      if (dx > grabHalf) {                    // closed on empty air — a wasted drop
        state = 'close'; stateT = 0; grip = 1; breakMult();
        popup('MISS', targetX, grabY - cellPx * 0.7, C.dim);
        return;
      }
      var quality = 1 - dx / grabHalf;        // 1 = dead centre
      var slip = SLIP_BASE + SLIP_GAIN * level - quality * quality * 0.14;
      if (Math.random() < clamp(slip, 0, 0.4)) {
        state = 'slip'; stateT = 0; grip = 1; breakMult();
        fallP = { p: prize, x: targetX, y: grabY, t0: performance.now() }; // own clock: outlives the state
        popup('SLIP!', targetX, grabY - cellPx * 0.7, C.orange);
        live.textContent = 'The grab slipped.';
        return;
      }
      carried = prize;
      grip = 0; state = 'close'; stateT = 0;
    }
    /** A prize left the well: the column settles down and a new one is rolled in behind. */
    function settleColumn() {
      bed[0][col] = bed[ROWS - 1][col];
      bed[ROWS - 1][col] = rollPrize();
    }
    function bankPrize() {
      var quality = clamp(1 - dx / grabHalf, 0, 1);
      var perfect = dx <= perfectHalf && prize.v >= PERFECT_MIN;
      var pts, label;
      if (perfect) { pts = Math.round(prize.v * 2.5); }
      else { pts = Math.round(prize.v * (0.35 + 0.65 * quality)); }
      var total = pts * (perfect ? mult : 1);
      if (perfect) { label = 'PERFECT +' + total; popup(label, targetX, grabY - cellPx * 0.8, C.acid); bumpMult(); }
      else { label = '+' + total; popup(label, targetX, grabY - cellPx * 0.8, C.orange); breakMult(); }
      addScore(total);
      settleColumn();
      live.textContent = label + '. Score ' + score + '.';
    }
    function endRun() {
      if (over || destroyed) return;   // api.gameOver() may only fire once per run
      over = true; state = 'ready'; paused = false;
      live.textContent = 'Out of drops. Final score ' + score + '.';
      gameOverCb(score);
    }
    /* --------------------------- State machine --------------------------- */
    function update(dt) {
      stateT += dt;
      switch (state) {
        case 'ready': // slow idle drift behind the title card
          clawX += clawDir * (SWEEP_BASE * 0.35) * (dt / 1000);
          if (clawX >= maxX()) { clawX = maxX(); clawDir = -1; }
          if (clawX <= minX()) { clawX = minX(); clawDir = 1; }
          break;
        case 'sweep':
          clawY += (restY - clawY) * Math.min(1, dt / 90);
          var sp = Math.min(SWEEP_MAX, SWEEP_BASE + SWEEP_GAIN * level);
          clawX += clawDir * sp * (dt / 1000);
          if (clawX >= maxX()) { clawX = maxX(); clawDir = -1; }
          if (clawX <= minX()) { clawX = minX(); clawDir = 1; }
          break;
        case 'descend':
          if (stateT >= DROP_MS) { clawY = grabY; resolve(); }
          else clawY = fromY + (grabY - fromY) * smooth(stateT / DROP_MS);
          break;
        case 'close':
          grip = clamp(stateT / CLOSE_MS, 0, 1);
          if (stateT >= CLOSE_MS) {
            if (carried) { bankPrize(); fromX = clawX; fromY = clawY; state = 'lift'; stateT = 0; }
            else { fromY = clawY; state = 'rise'; stateT = 0; }   // fizzle or slip: back up empty
          }
          break;
        case 'slip':
          grip = 1;
          if (stateT >= SLIP_MS) { fromY = clawY; state = 'rise'; stateT = 0; }
          break;
        case 'rise':
          grip = 1 - clamp(stateT / CLOSE_MS, 0, 1);
          if (stateT >= CLOSE_MS) { clawY = restY; grip = 0; state = 'sweep'; stateT = 0; afterDrop(); }
          else clawY = fromY + (restY - fromY) * smooth(stateT / CLOSE_MS);
          break;
        case 'lift':
          grip = 1;
          if (stateT >= LIFT_MS) { fromX = clawX; fromY = clawY; state = 'chute'; stateT = 0; }
          else clawY = grabY + (restY - grabY) * smooth(stateT / LIFT_MS);
          break;
        case 'chute':  // travel over the chute and pay the prize out
          grip = 1;
          if (stateT >= CHUTE_MS) {
            clawX = chuteX; chuteFlash = 1; carried = null; state = 'return'; stateT = 0;
          } else {
            var e = smooth(stateT / CHUTE_MS);
            clawX = fromX + (chuteX - fromX) * e;
            clawY = restY + (chuteY - restY) * e;
          }
          break;
        case 'return':
          grip = 1 - clamp(stateT / CLOSE_MS, 0, 1);
          if (stateT >= CLOSE_MS) { clawX = maxX(); clawDir = -1; grip = 0; state = 'sweep'; stateT = 0; afterDrop(); }
          break;
      }
    }
    function afterDrop() {
      fallP = null;
      if (dropsLeft <= 0) endRun();
    }
    /* ---------------------------- Rendering ---------------------------- */
    function prizeColor(p) { return C[TIERS[p.t].c]; }
    /** One plush. Shape carries the tier so the field is readable without the number. */
    function drawPrize(p, x, y, s, alpha) {
      var col = prizeColor(p);
      ctx.save();
      ctx.globalAlpha = alpha === undefined ? 1 : alpha;
      ctx.shadowColor = col; ctx.shadowBlur = 22;
      ctx.fillStyle = col;
      var k = p.t, i, a;
      ctx.beginPath();
      if (k === 0) ctx.arc(x, y, s * 0.42, 0, Math.PI * 2);
      else if (k === 1) { if (ctx.roundRect) ctx.roundRect(x - s * .4, y - s * .4, s * .8, s * .8, s * .16); else ctx.rect(x - s * .4, y - s * .4, s * .8, s * .8); }
      else if (k === 2) { for (i = 0; i < 6; i++) { a = Math.PI / 6 + i * Math.PI / 3;
        var px = x + Math.cos(a) * s * 0.46, py = y + Math.sin(a) * s * 0.46; if (!i) ctx.moveTo(px, py); else ctx.lineTo(px, py); } ctx.closePath(); }
      else if (k === 3) { ctx.moveTo(x, y - s * .48); ctx.lineTo(x + s * .46, y); ctx.lineTo(x, y + s * .48); ctx.lineTo(x - s * .46, y); ctx.closePath(); }
      else ctx.arc(x, y, s * 0.46, 0, Math.PI * 2);
      ctx.fill();
      if (k === 4) { ctx.shadowBlur = 0; ctx.strokeStyle = C.bg; ctx.lineWidth = Math.max(1.5, s * 0.09);
        ctx.beginPath(); ctx.arc(x, y, s * 0.3, 0, Math.PI * 2); ctx.stroke(); }
      ctx.shadowBlur = 0;
      ctx.fillStyle = C.bg;
      ctx.font = '700 ' + Math.round(clamp(s * 0.36, 8, 18)) + 'px Rajdhani, system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(p.v), x, y + s * 0.02);
      ctx.restore();
    }
    /** The carriage + cable + three prongs. `grip` 0 open -> 1 closed. */
    function drawClaw() {
      var s = Math.max(10, cellPx * 0.9), open = (1 - grip) * s * 0.46; // open prongs -> pinched
      ctx.save();
      ctx.strokeStyle = hexA(C.cyan, 0.85); ctx.lineWidth = 2; ctx.shadowColor = C.cyan; ctx.shadowBlur = 12;
      ctx.beginPath(); ctx.moveTo(clawX, 0); ctx.lineTo(clawX, clawY - s * 0.32); ctx.stroke();
      ctx.shadowBlur = 16; ctx.fillStyle = C.violet;
      rr(clawX - s * 0.42, clawY - s * 0.62, s * 0.84, s * 0.42, s * 0.12); ctx.fill();
      ctx.shadowBlur = 0; ctx.strokeStyle = C.cyan; ctx.lineWidth = Math.max(2, s * 0.11); ctx.lineCap = 'round';
      for (var i = -1; i <= 1; i += 2) {
        ctx.beginPath(); ctx.moveTo(clawX - s * 0.3, clawY - s * 0.2);
        ctx.quadraticCurveTo(clawX + i * (open * 1.15), clawY - s * 0.1, clawX + i * open, clawY + s * 0.42);
        ctx.stroke();
      }
      if (carried) drawPrize(carried, clawX, clawY + s * 0.78, s * 0.92);
      ctx.restore();
    }
    /** Centred overlay: big neon title, one dim line of sub-copy, optional hint. */
    function card(title, sub, color, hint) {
      ctx.fillStyle = hexA(C.bg, 0.74); ctx.fillRect(0, 0, cssW, cssH);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      // Size from the SHORTER edge: a portrait stage is taller than it is wide,
      // so height alone would balloon the type off both sides of the canvas.
      var ts = Math.round(clamp(Math.min(cssH * 0.12, cssW * 0.115), 16, 60));
      var bs = Math.round(clamp(Math.min(cssH * 0.045, cssW * 0.052), 10, 20));
      var cy = cssH * 0.40;
      ctx.font = '900 ' + ts + 'px Orbitron, system-ui, sans-serif';
      ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 28;
      ctx.fillText(title, cssW / 2, cy); ctx.shadowBlur = 0;
      // Stack off the measured type sizes so the lines never sit on top of each other.
      var sy = cy + ts * 0.72 + bs * 0.8;
      ctx.font = '600 ' + bs + 'px Rajdhani, system-ui, sans-serif';
      ctx.fillStyle = C.dim; ctx.fillText(sub, cssW / 2, sy);
      if (hint) ctx.fillText(hint, cssW / 2, sy + bs * 1.6);
    }
    function draw(now, dt) {
      var w = cssW, h = cssH;
      if (chuteFlash > 0) chuteFlash = Math.max(0, chuteFlash - dt / 260);
      if (perfectFlash > 0) perfectFlash = Math.max(0, perfectFlash - dt / 320);
      ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);

      // Machine head rail + carriage track.
      ctx.fillStyle = hexA(C.violet, 0.14); ctx.fillRect(0, 0, w, Math.max(10, restY - cellPx * 0.4));
      ctx.fillStyle = hexA(C.cyan, 0.1); ctx.fillRect(bedX, restY - 2, bedW, 2);

      // Cabinet: the machine body the well sits in, so tall screens aren't dead space.
      var bx0 = bedX - colStep * 0.14, bw0 = bedW + colStep * 0.28;
      var by0 = bedY - cellPx * 0.55, bb0 = btnY - btnH * 0.32;
      ctx.save(); rr(bx0, by0, bw0, bb0 - by0, Math.min(18, cellPx * 0.4));
      ctx.fillStyle = hexA(C.violet, 0.07); ctx.fill();
      ctx.strokeStyle = hexA(C.cyan, 0.16); ctx.lineWidth = 2; ctx.stroke(); ctx.restore();

      // The well.
      var br = Math.min(14, cellPx * 0.3);
      ctx.save(); rr(bedX, bedY, bedW, bedH, br);
      ctx.fillStyle = 'rgba(255,255,255,.035)'; ctx.fill(); ctx.clip();
      ctx.strokeStyle = hexA(C.cyan, 0.08); ctx.lineWidth = 1; ctx.beginPath();
      for (var c = 1; c <= COLS; c++) { ctx.moveTo(bedX + c * colStep, bedY); ctx.lineTo(bedX + c * colStep, bedY + bedH); }
      ctx.moveTo(bedX, bedY + rowStep); ctx.lineTo(bedX + bedW, bedY + rowStep); ctx.stroke();
      // The chute column, lit when a prize drops in.
      ctx.fillStyle = hexA(C.acid, 0.05 + chuteFlash * 0.35);
      ctx.fillRect(bedX + COLS * colStep, bedY, colStep, bedH);
      ctx.restore();
      ctx.save(); rr(bedX, bedY, bedW, bedH, br);
      ctx.strokeStyle = hexA(C.cyan, 0.26); ctx.lineWidth = 2; ctx.stroke(); ctx.restore();
      // Delivery chute: where the claw takes won prizes, so the field has a purpose.
      var cw = colStep * 0.72, cx = chuteX - cw / 2, cy = bedY + bedH, ch = btnY - cy - 8;
      ctx.fillStyle = hexA(C.acid, 0.05 + chuteFlash * 0.3); ctx.fillRect(cx, cy, cw, Math.max(0, ch));
      ctx.strokeStyle = hexA(C.acid, 0.2 + chuteFlash * 0.6); ctx.lineWidth = 1;
      ctx.strokeRect(cx, cy, cw, Math.max(0, ch));
      if (ch > 34) { // marquee on the cabinet front, opposite the chute
        ctx.fillStyle = hexA(C.acid, 0.4); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.font = '700 ' + Math.round(clamp(cellPx * 0.26, 9, 15)) + 'px Orbitron, system-ui, sans-serif';
        ctx.fillText('PRIZE OUT', (bedX + bedW) / 2, cy + ch * 0.5);
        ctx.fillText('DROPS LEFT ' + dropsLeft, (bedX + bedW) / 2, cy + ch * 0.5 + cellPx * 0.42);
      }

      var ps = cellPx * 0.86;
      for (var r = ROWS - 1; r >= 0; r--) for (var k = 0; k < COLS; k++) {
        if (!bed[r][k]) continue;
        var bob = reduced ? 0 : Math.sin(now / 520 + k * 1.7 + r) * cellPx * 0.035;
        drawPrize(bed[r][k], colCenter(k), bedY + (r + 0.5) * rowStep + bob, ps, r === 0 ? 1 : 0.72);
      }
      if (fallP) { // the slipped prize, tumbling out of frame
        var t = clamp((now - fallP.t0) / SLIP_MS, 0, 1);
        drawPrize(fallP.p, fallP.x, fallP.y + t * t * bedH * 1.4, ps * (1 - t * 0.4), 1 - t);
        if (t >= 1) fallP = null;
      }
      // Grab window: the bright band is how wide a catch is, the acid sliver is perfect.
      if (state === 'sweep' && !over) {
        var pulse = reduced ? 0.5 : 0.35 + 0.25 * Math.sin(now / 300);
        ctx.fillStyle = hexA(C.cyan, 0.05 + pulse * 0.06); ctx.fillRect(clawX - grabHalf, bedY, grabHalf * 2, bedH);
        ctx.fillStyle = hexA(C.acid, 0.5); ctx.fillRect(clawX - perfectHalf, bedY, perfectHalf * 2, bedH);
      }
      drawClaw();

      // CRT polish: scanlines + vignette over the WORLD only.
      if (!reduced) { ctx.fillStyle = 'rgba(0,0,0,.16)';
        if (ctx.__pxH !== h) { var __px = document.createElement('canvas'); __px.width = 1; __px.height = 3;
          var __pxg = __px.getContext('2d'); __pxg.fillStyle = 'rgba(0,0,0,.16)'; __pxg.fillRect(0, 0, 1, 1);
          ctx.__pxP = ctx.createPattern(__px, 'repeat'); ctx.__pxH = h; }
        ctx.fillStyle = ctx.__pxP; ctx.fillRect(0, 0, w, h); }
      var vig = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75);
      vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(0,0,0,.55)');
      ctx.fillStyle = vig; ctx.fillRect(0, 0, w, h);

      // Readability layer, drawn ABOVE the CRT so text keeps full contrast.
      // Floating score pops.
      for (var q = popups.length - 1; q >= 0; q--) {
        var u = popups[q]; u.t += dt; u.y -= dt * 0.03;
        var a = u.t > 620 ? 1 - (u.t - 620) / 380 : 1;
        if (a <= 0) { popups.splice(q, 1); continue; }
        ctx.save(); ctx.globalAlpha = a;
        ctx.font = '800 ' + Math.round(clamp(Math.min(cellPx * 0.42, w * 0.062), 11, 20)) + 'px Orbitron, system-ui, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = u.c; ctx.shadowColor = u.c; ctx.shadowBlur = 14;
        // A long pop ("PERFECT +300") is wider than the old fixed 30px margin, so
        // inset by its own half-width instead and let it slide back toward the middle.
        var halfW = ctx.measureText(u.text).width / 2 + 4;
        ctx.fillText(u.text, clamp(u.x, halfW, Math.max(halfW, w - halfW)), u.y); ctx.restore();
      }

      // HUD: score, best, drop pips, multiplier.
      var fs = Math.round(clamp(Math.min(cssH * 0.042, cssW * 0.05), 11, 17)), top = Math.max(13, restY * 0.5);
      var pipW = Math.min(11, bedW / (DROPS + 1));
      ctx.font = '700 ' + fs + 'px Rajdhani, system-ui, sans-serif';
      ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.fillStyle = C.ink;
      ctx.fillText('SCORE ' + score, bedX, top);
      ctx.textAlign = 'right'; ctx.fillStyle = C.dim; ctx.fillText('BEST ' + bestEver, bedX + bedW, top);
      for (var d = 0; d < DROPS; d++) { // one pip per drop: the run's fuel gauge
        ctx.fillStyle = d < dropsLeft ? hexA(C.cyan, 0.9) : hexA(C.ink, 0.4);
        ctx.fillRect(bedX + d * pipW, top + fs * 0.75, pipW - 2, 3);
      }
      if (mult > 1) {
        ctx.textAlign = 'center'; ctx.fillStyle = perfectFlash > 0.4 ? C.acid : C.orange;
        ctx.font = '800 ' + Math.round(fs * 1.15) + 'px Orbitron, system-ui, sans-serif';
        ctx.fillText('x' + mult, w / 2, top + 2);
      }
      // Thumb-zone button: an affordance, and the same action as a tap anywhere.
      var hot = (state === 'sweep' && !over) || over || (paused && booted);
      ctx.save(); rr(btnX, btnY, btnW, btnH, btnH / 2);
      ctx.fillStyle = hexA(hot ? C.cyan : C.ink, hot ? 0.18 : 0.09); ctx.fill();
      ctx.strokeStyle = hexA(hot ? C.cyan : C.ink, hot ? 0.85 : 0.45);
      ctx.lineWidth = 2; ctx.shadowColor = C.cyan; ctx.shadowBlur = hot ? 16 : 0; ctx.stroke();
      ctx.shadowBlur = 0; ctx.fillStyle = hot ? C.cyan : C.ink;
      ctx.font = '800 ' + Math.round(clamp(Math.min(btnH * 0.38, btnW * 0.1), 12, 22)) + 'px Orbitron, system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(over ? 'PLAY AGAIN' : (paused && booted ? 'RESUME' : 'DROP'), btnX + btnW / 2, btnY + btnH / 2);
      ctx.restore();

      if (!booted) card('LUCKY CLAW', '12 drops. Time the sweep.', C.cyan, 'TAP or press SPACE to start');
      else if (over) card('GAME OVER', 'SCORE ' + score + (isRecord ? '  ·  NEW BEST' : ''), C.magenta, 'TAP or press SPACE to play again');
      else if (paused) card('PAUSED', 'SCORE ' + score, C.cyan, 'Tap or press SPACE to resume');
    }
    /* -------------------------- Single rAF loop -------------------------- */
    var last = 0;
    function frame(now) {
      if (destroyed) return;   // guard: destroy() can land between frames
      var dt = last ? Math.min(120, now - last) : 16; // clamp so a backgrounded tab can't fast-forward
      last = now;
      if (!paused && !over) update(dt);
      // update() may have reached endRun() -> api.gameOver() -> destroy(), so re-check.
      if (!destroyed) draw(now, paused ? 0 : dt);
      if (!destroyed) rafId = requestAnimationFrame(frame);
    }
    /* ------------------- Input: pointer, keyboard, focus ------------------- */
    /** The single entry point for every "I want to act" gesture. */
    function act() {
      if (destroyed) return;
      if (over || !booted) { resetRun(); return; }   // tap on a dead/blank screen restarts
      if (paused) { paused = false; setStatus('Playing'); return; }  // resuming never costs a drop
      drop();
    }
    function onKeyDown(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Never steal Space from a real control; the canvas owns it while focused.
      var a = document.activeElement;
      if (a && a !== canvas && /^(BUTTON|INPUT|SELECT|TEXTAREA|A|SUMMARY)$/.test(a.tagName)) return;
      if (e.code === 'Space' || e.code === 'Enter' || e.code === 'NumpadEnter' || e.key === ' ') {
        e.preventDefault(); act();
      }
    }
    function onPointerDown(e) {
      if (e.button !== undefined && e.button !== 0) return;
      if (canvas.setPointerCapture && e.pointerId !== undefined) {
        try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      }
      if (canvas.focus) { try { canvas.focus({ preventScroll: true }); } catch (err) { /* ignore */ } }
      act();
    }
    /* The cabinet is taller than the viewport on a phone held sideways, and the
       page chrome above it can push the whole playfield below the fold. Bring it
       back into view when we boot, when the device is rotated and when a short
       landscape window cuts the well in half — a no-op once the cabinet is on
       screen, so it never yanks a settled page.
       `partial` is the resize case: only rescue a cabinet that is half on screen
       (a viewport change the player did not ask for). If they have deliberately
       scrolled it off, leave their scroll position alone.
       Returns true once the cabinet is on screen and needs nothing more. */
    var SCROLL_SLOP = 16;   // px of cabinet we are willing to leave below the fold
    function keepInView(partial) {
      if (destroyed || !root || !root.scrollIntoView) return true;
      var r = wrap.getBoundingClientRect();
      var vh = window.innerHeight || document.documentElement.clientHeight;
      var onScreen = r.top >= -SCROLL_SLOP && r.bottom <= vh + SCROLL_SLOP;
      if (!vh || onScreen) return true;
      if (partial && (r.bottom <= 0 || r.top >= vh)) return true; // scrolled away on purpose
      // Taller than the fold: line the bottom up, so the prize well and the DROP
      // button stay on screen and only the score strip rides above the top edge.
      var tall = r.height > vh;
      try { wrap.scrollIntoView({ block: tall ? 'end' : 'center' }); }
      catch (err) { try { wrap.scrollIntoView(); } catch (e2) { /* ignore */ } }
      return onScreen;
    }
    function onResize() { if (!destroyed) { resize(); keepInView(true); } }
    function onOrientation() { if (!destroyed) { resize(); keepInView(); } }
    function onBlur() {   // auto-pause on focus loss
      if (destroyed || !booted || over || paused) return;
      paused = true;
      setStatus('Paused');
    }
    function onVisibility() { if (document.hidden) onBlur(); }
    function clock() { return window.performance && performance.now ? performance.now() : Date.now(); }
    // One boot-time check is not enough: the module is injected the moment the
    // shell hands it the stage, which can be well before the shell's first settled
    // layout pass, so a phone that loads the page already sideways measures a
    // stage that is not on screen yet and scrolls to nothing. Re-check until the
    // cabinet is up, for two seconds at most — keepInView() reports when there is
    // nothing left to do, and any scroll of the player's own cancels the lot.
    var settleDone = false, settleY = -1, settleUntil = clock() + 2000;
    function stopSettle() { settleDone = true; }
    var SETTLE_OPTS = { passive: true, once: true };
    // Every listener the game owns, in one table so teardown cannot miss one.
    var BIND = [[document, 'keydown', onKeyDown], [root || canvas, 'pointerdown', onPointerDown],
      [window, 'resize', onResize, { passive: true }], [window, 'orientationchange', onOrientation],
      [window, 'blur', onBlur], [document, 'visibilitychange', onVisibility],
      [window, 'wheel', stopSettle, SETTLE_OPTS], [window, 'touchmove', stopSettle, SETTLE_OPTS],
      [window, 'pointerdown', stopSettle, SETTLE_OPTS]];
    BIND.forEach(function (b) { b[0].addEventListener(b[1], b[2], b[3]); });
    fillBed(); clawX = minX(); clawY = restY; booted = false; paused = false;
    setScore(0); setBest(bestEver);
    (function settle() {
      if (destroyed || settleDone) return;
      if (keepInView()) return;                    // the cabinet is up: done
      if (clock() >= settleUntil) return;
      // A cabinet far taller than the fold can never report "on screen" (the top
      // edge is always above the viewport), so stop as soon as the page stops
      // moving: it is as far in as it goes.
      var y = Math.round(window.pageYOffset || document.documentElement.scrollTop || 0);
      if (y === settleY) return;
      settleY = y;
      requestAnimationFrame(settle);
    })();
    last = 0; rafId = requestAnimationFrame(frame);
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
    name: 'Lucky Claw',
    instructions:
      'The claw sweeps over the prize well — TAP the cabinet (or press SPACE) to drop it. ' +
      'Drop dead centre on a pink or acid prize for a PERFECT, and perfect grabs stack a multiplier ' +
      'up to x9; an off-centre grab still pays out, a slip or a miss breaks the streak. ' +
      'You only get 12 drops, the sweep speeds up as you burn them, and high-value prizes get rarer. ' +
      'Best score is saved on this device.',
    start: start
  };
})();
