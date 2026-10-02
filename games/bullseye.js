/**
 * PIXEL RUSH — games/bullseye.js — "Bullseye Dash"
 * Contract (SPEC.md): window.PixelGame = { name, instructions, start(root, api) } where
 * api = { setScore(n), setBest(n), gameOver(score) } and start() returns { destroy() }.
 * Self-contained: no imports, no dependencies, no assets — one <canvas> + 2D ctx, a
 * single rAF loop, and every listener created in start() is torn down in destroy().
 */
(function () {
  'use strict';
  /* -------------------------------- Tuning -------------------------------- */
  var STORE_KEY = 'pixelrush.bullseye.best';
  var VISITS = 9, DARTS = 3;
  // Each visit must be cleared on this many points or the run is a bust — the ramp.
  var TARGETS = [40, 55, 70, 85, 100, 115, 130, 145, 160];
  var SPREAD0 = 0.30, SPREAD_FALLOFF = 0.024; // aim scatter from a full-power throw, per visit
  var CHARGE_MS = 1150, CHARGE_MS_FAST = 720; // power-meter sweep period
  var FLIGHT_MS = 360;                         // dart flight time
  var AIM_STEP = 1.15, RAD_STEP = 0.62;       // radians / board-radii per second
  // Standard board, normalised so the double ring's outer edge is radius 1.
  var R_DBL_O = 1.0, R_DBL_I = 0.955, R_TR_O = 0.582, R_TR_I = 0.535, R_OBULL = 0.093, R_IBULL = 0.038;
  var STEP = Math.PI / 10;                     // 20 sectors of 18 degrees
  var ORDER = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];
  var BULL_BONUS = 25, FINISH_BASE = 25, FINISH_STEP = 10;
  // A throw has to be wound up, not tapped: below MIN_CHARGE_MS / MIN_POWER the
  // dart landed dead centre, which is the inner bull and the best dart on the
  // board, so a 40ms tap scored 75 every time and the run was beatable by
  // mashing. Sub-minimum releases are now refused outright.
  var MIN_CHARGE_MS = 180, MIN_POWER = 0.28;
  var SHORT_MSG = 'Too short to throw. Hold to wind up the power meter, then release.';
  var START_AIM_R = 0.45;               // new runs start mid-board, not on the bull
  var METER_H = 8, LABEL_GAP = 9;       // bottom block: power meter + its label
  var STYLES = '.bd{position:relative;width:100%;height:100%;overflow:hidden;touch-action:none;' +
    'user-select:none;-webkit-tap-highlight-color:transparent;' +
    'font-family:var(--font-body,"Rajdhani",system-ui,sans-serif);color:var(--ink,#f2f5ff)}' +
    '.bd canvas{display:block;width:100%;height:100%;outline:none}';
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function readBest() {
    try { var v = parseInt(window.localStorage.getItem(STORE_KEY), 10);
      return isFinite(v) && v > 0 ? v : null; } catch (e) { return null; } // private mode
  }
  function writeBest(v) {
    try { window.localStorage.setItem(STORE_KEY, String(v)); } catch (e) { /* ignore */ }
  }
  /** Convert a board-space point (radius 1 = double outer edge) into a scored hit. */
  function scoreAt(x, y) {
    var r = Math.sqrt(x * x + y * y);
    if (r > R_DBL_O) return { pts: 0, label: 'MISS', fin: false, bull: false };
    var a = Math.atan2(x, y); // 0 at the top, clockwise positive
    var n = ORDER[((Math.round(a / STEP) % 20) + 20) % 20];
    if (r <= R_IBULL) return { pts: 50 + BULL_BONUS, label: 'BULL ' + (50 + BULL_BONUS), fin: true, bull: true };
    if (r <= R_OBULL) return { pts: 25, label: 'OUTER BULL 25', fin: true, bull: true };
    if (r >= R_DBL_I) return { pts: n * 2, label: 'D' + n + ' ' + n * 2, fin: true, bull: false };
    if (r <= R_TR_O && r >= R_TR_I) return { pts: n * 3, label: 'T' + n + ' ' + n * 3, fin: true, bull: false };
    return { pts: n, label: n + '', fin: false, bull: false };
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
    var wrap = document.createElement('div'); wrap.className = 'bd';
    var canvas = document.createElement('canvas');
    canvas.setAttribute('tabindex', '0'); canvas.setAttribute('role', 'application');
    canvas.setAttribute('aria-label', 'Bullseye Dash dartboard. Arrow keys aim, hold SPACE for power, release to throw. On touch, drag to aim and release to throw.');
    var live = document.createElement('div'); // screen-reader announcements
    live.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0)';
    live.setAttribute('aria-live', 'polite');
    var styleTag = document.createElement('style');
    styleTag.textContent = STYLES;                       // one <style>, scoped to .bd
    wrap.appendChild(canvas); wrap.appendChild(live); wrap.appendChild(styleTag); root.appendChild(wrap);
    var ctx = canvas.getContext('2d');
    if (!ctx) { root.removeChild(wrap); return { destroy: function () {} }; }
    var rafId = 0, destroyed = false;
    // window.PX.reduced first, media query as the fallback.
    var reduced = !!(window.PX && window.PX.reduced);
    if (!window.PX || window.PX.reduced === undefined) {
      reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }
    var score = 0, visit = 1, darts = 0, visitScore = 0;
    var bestEver = readBest(), isRecord = false, over = false, booted = false, paused = true;
    var aimA = 0, aimR = 0, power = 0, chargeDir = 1, charging = false, chargeStart = 0;
    var dartsOnBoard = [], flash = null, flashAt = -1e9, lastDart = null;
    var phase = 'aim', flightEnd = 0, overMsg = '';   // phase: 'aim' | 'flight' | 'over'
    var held = {};                                      // keyboard-held aim keys
    // The shell's STATUS tile belongs to whoever owns the state, and this game has
    // a real pause state, so it reports its own.
    function reportStatus() { setStatus(over ? 'Game over' : (paused ? 'Paused' : 'Playing')); }
    function unpause() { if (paused) { paused = false; reportStatus(); } }
    /* ----------------- Sizing (crisp devicePixelRatio) ----------------- */
    var dpr = 1, cssW = 1, cssH = 1, R = 10, cx = 0, cy = 0, btn = null, hudTop = 12, barY = 24, meterOff = 14;
    var RAI = 'Rajdhani, system-ui, sans-serif', ORB = 'Orbitron, system-ui, sans-serif';
    // A phone stage is TALLER than it is wide, so text is sized from the smaller
    // of the two dimensions and then shrunk again to the width it actually needs.
    function hudFont() { return Math.max(10, Math.round(clamp(Math.min(cssH * 0.04, cssW * 0.05), 10, 17))); }
    function textW(weight, size, str, family) {
      ctx.font = weight + ' ' + size + 'px ' + (family || RAI);
      return ctx.measureText(String(str)).width;
    }
    /** Largest size <= `size` at which `str` fits `maxW`, so nothing ever clips. */
    function fitSize(weight, size, str, maxW, min, family) {
      var s = size;
      while (s > min) { if (textW(weight, s, str, family) <= maxW) return s; s -= 1; }
      return min;
    }
    /** Break `text` into the fewest lines that fit `maxW`; shrinks the size if needed. */
    function wrapFit(text, size, weight, maxW, min, maxLines, family) {
      var words = String(text).split(' '), s = size, lines;
      do {
        lines = []; ctx.font = weight + ' ' + s + 'px ' + (family || RAI);
        var cur = '';
        for (var i = 0; i < words.length; i++) {
          var t = cur ? cur + ' ' + words[i] : words[i];
          if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = words[i]; } else cur = t;
        }
        if (cur) lines.push(cur);
        if (lines.length <= maxLines || s <= min) break;
        s -= 1;
      } while (s > min);
      return { size: s, lines: lines };
    }
    function resize() {
      var r = wrap.getBoundingClientRect();
      cssW = Math.max(1, Math.round(r.width)); cssH = Math.max(1, Math.round(r.height));
      dpr = clamp(window.devicePixelRatio || 1, 1, 2); // cap DPR so 3x phones don't choke
      canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
      canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // HUD geometry is measured first, because the board is centred in what is
      // left between the two HUD rows and the touch block: row 1 is the
      // SCORE/VISIT/BEST line, row 2 the visit progress bar. Deriving the board
      // from the old fixed `top` put the bar on the same baseline as row 1 (and
      // clipped it off the top of a short stage entirely).
      var fs = hudFont(), small = cssH < 260 || cssW < 430;
      hudTop = Math.max(small ? 9 : 11, Math.round(cssH * 0.03));
      barY = hudTop + Math.max(small ? 11 : 12, Math.round(fs * 0.85));
      // Top of the board's number ring, so the ring clears the progress bar row.
      var top = barY + Math.max(8, Math.round(fs * 0.55));
      // The bottom block is exactly as tall as the POWER label, the meter and the
      // two buttons need, so a short stage gives the leftover height to the board.
      var bh = clamp(cssH * 0.11, small ? 26 : 30, 52), pad = small ? 6 : 8;
      meterOff = Math.max(small ? 13 : 14, Math.round(bh * 0.34)); // same offset drawHud uses
      var band = pad + bh + meterOff + METER_H + LABEL_GAP + Math.round(fs * 0.5) + 2;
      var avail = Math.max(16, cssH - top - band);
      // Board is square and letterboxed into the play area between them. The
      // sector numbers sit at 1.09R, so the height budget is halved and the whole
      // board — numbers included — is centred in what is left.
      R = Math.max(14, Math.min(cssW * 0.47, avail * 0.5 / 1.09));
      cx = Math.round(cssW / 2); cy = Math.round(top + avail / 2);
      // The two buttons and the 8px gap between them must fit the stage: the
      // pair is asymmetric (0.62w + gap + w), so solving w from the old `cssW *
      // 0.56` hung the right button off a narrow phone.
      var gap = 8, bw = Math.max(60, Math.min(210, (cssW - 24) / 1.62));
      var bx = Math.max(8, (cssW - 1.62 * bw) / 2), by = cssH - bh - pad;
      btn = { x: bx + 0.62 * bw + gap, y: by, w: bw, h: bh,
        small: { x: bx, y: by, w: 0.62 * bw, h: bh } };
    }
    resize();
    function token(n, fb) { // site custom property, with a hard fallback
      var v = getComputedStyle(document.documentElement).getPropertyValue(n); return (v && v.trim()) || fb;
    }
    var C = { bg: token('--bg', '#05060f'), ink: token('--ink', '#f2f5ff'), dim: token('--ink-dim', '#a7b0d0'),
      cyan: token('--cyan', '#22e7ff'), magenta: token('--magenta', '#ff2fb9'), acid: token('--acid', '#c8ff2e'),
      orange: token('--orange', '#ff8a3d'), violet: token('--violet', '#8b5cf6') };
    function hexN(hex, a) { // #rrggbb -> rgba() with alpha `a`
      hex = (hex || '#fff').trim().replace('#', '');
      var n = parseInt(hex, 16);
      return isFinite(n) ? 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')' : 'rgba(255,255,255,' + a + ')';
    }
    function shade(hex, t) { // t<0 darken toward black, t>0 lighten toward white
      var n = parseInt((hex || '#fff').replace('#', ''), 16) || 0xffffff, f = t < 0 ? 0 : 255, p = Math.abs(t), o = '';
      for (var i = 16; i >= 0; i -= 8) o += (i === 8 ? ',' : '') + Math.round(((n >> i) & 255) + (f - ((n >> i) & 255)) * p);
      return 'rgb(' + o + ')';
    }
    function rr(x, y, w, h, r) { // rounded-rect path, with a pre-roundRect fallback
      ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
    }
    /* ---------------------------- Game logic ---------------------------- */
    function chargeMs() { return visit >= 7 ? CHARGE_MS_FAST : CHARGE_MS; }
    function addPoints(v) {
      if (v <= 0) return;
      score += v; setScore(score);
      if (bestEver === null || score > bestEver) { bestEver = score; isRecord = true; writeBest(score); setBest(score); }
    }
    function resetRun() {
      score = 0; visit = 1; darts = 0; visitScore = 0;
      aimA = 0; aimR = START_AIM_R; power = 0; charging = false;
      dartsOnBoard.length = 0; flash = null; lastDart = null;
      phase = 'aim'; paused = !booted; booted = true; isRecord = false; over = false;
      setScore(0); if (bestEver !== null) setBest(bestEver);
      live.textContent = 'New run. Visit 1 of 9. Target 40.';
    }
    /** Where the reticle actually is: the player's aim plus the sway of the board. */
    function reticle(now) {
      var i = visit - 1, ramp = Math.max(0, i - 2) / 6, t = now / 1000, m = 0.3 + 0.7 * ramp;
      var da = (Math.sin(t * 0.9 + i) * 0.09 + Math.sin(t * 2.3 + i * 1.7) * 0.04) * m;
      var dr = (Math.sin(t * 1.15 + i * 2.1) * 0.10 + Math.sin(t * 2.7) * 0.045) * m;
      return { a: aimA + da, r: clamp(aimR + dr, 0, 0.99) };
    }
    function throwDart(now) {
      if (phase !== 'aim' || over || paused) return;
      if (power < MIN_POWER) power = MIN_POWER;   // a released meter is never a dead-centre dart
      var q = reticle(now), spread = SPREAD0 - SPREAD_FALLOFF * (visit - 1);
      var dev0 = 0.008 + spread * (0.05 + 0.95 * power * power);
      // Power sets distance (a weak throw falls short) AND accuracy (a wild one scatters).
      var a = q.a + (Math.random() - 0.5) * dev0, r = q.r * (0.6 + 0.4 * power) + (Math.random() - 0.5) * dev0;
      var x = Math.sin(a) * r, y = Math.cos(a) * r, hit = scoreAt(x, y);
      dartsOnBoard.push({ x: x, y: y, t: now });
      if (dartsOnBoard.length > DARTS) dartsOnBoard.shift();
      lastDart = { x: x, y: y, label: hit.label, pts: hit.pts, fin: hit.fin, bull: hit.bull, t: now };
      addPoints(hit.pts); visitScore += hit.pts; darts++;
      flash = { text: (hit.pts > 0 ? '+' : '') + hit.pts + '  ' + hit.label, color: hit.pts >= 40 ? C.acid : (hit.pts > 0 ? C.cyan : C.magenta) };
      flashAt = now; power = 0; charging = false; phase = 'flight'; flightEnd = now + FLIGHT_MS;
      live.textContent = hit.label + '. Visit score ' + visitScore + ' of ' + TARGETS[visit - 1] + '.';
    }
    function endVisit() {
      var last = lastDart, target = TARGETS[visit - 1], label;
      // The bust check comes first: a visit that missed the target pays nothing,
      // finish bonus included — it used to be banked into the score and the best.
      if (visitScore < target) { finish('BUSTED — short by ' + (target - visitScore)); return; }
      if (last && last.fin) {                       // finished the visit on a double/treble/bull
        var bonus = (last.bull ? 60 : FINISH_BASE + FINISH_STEP * visit) * (visit === VISITS ? 2 : 1);
        addPoints(bonus);
        label = (visit === VISITS ? 'CHECKOUT +' : 'FINISH +') + bonus;
        flash = { text: label, color: C.acid }; flashAt = performance.now();
        live.textContent = label + '.';
      }
      if (visit >= VISITS) { finish('CHECKOUT — all nine visits cleared'); return; }
      visit++; darts = 0; visitScore = 0; dartsOnBoard.length = 0; lastDart = null;
      live.textContent = 'Visit ' + visit + ' of ' + VISITS + '. Target ' + TARGETS[visit - 1] + '.';
    }
    function finish(why) {
      if (over || destroyed) return;                // api.gameOver() fires once per run
      over = true; phase = 'over'; charging = false; overMsg = why;
      reportStatus();
      live.textContent = why + '. Final score ' + score + '.';
      gameOverCb(score);
    }
    /* ----------------------------- Drawing ----------------------------- */
    function drawBoard() {
      var ring = function (rad, col, w) {
        ctx.beginPath(); ctx.arc(cx, cy, R * rad, 0, Math.PI * 2);
        ctx.strokeStyle = col; ctx.lineWidth = w; ctx.stroke();
      };
      var i, a;
      for (i = 0; i < 20; i++) {                   // alternating sector plates
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, R, -i * STEP, -(i + 1) * STEP);
        ctx.closePath(); ctx.fillStyle = i % 2 ? shade(C.violet, -0.82) : shade(C.ink, -0.9); ctx.fill();
      }
      ctx.save();
      ctx.shadowColor = C.magenta; ctx.shadowBlur = 18;   // treble and double rings light up
      ring(R_TR_O, hexN(C.magenta, 0.5), 2); ring(R_TR_I, hexN(C.magenta, 0.5), 2);
      ctx.shadowColor = C.cyan;
      ring(R_DBL_O, hexN(C.cyan, 0.6), 2.5); ring(R_DBL_I, hexN(C.cyan, 0.5), 2);
      ctx.shadowBlur = 0;
      ctx.strokeStyle = hexN(C.dim, 0.5); ctx.lineWidth = 1; ctx.beginPath();   // the 20 wires
      for (i = 0; i < 20; i++) {
        a = -i * STEP;
        ctx.moveTo(cx + Math.sin(a) * R * R_IBULL, cy - Math.cos(a) * R * R_IBULL);
        ctx.lineTo(cx + Math.sin(a) * R, cy - Math.cos(a) * R);
      }
      ring(R_TR_I, hexN(C.dim, 0.35), 1); ring(R_OBULL, hexN(C.dim, 0.35), 1); ctx.stroke();
      ctx.fillStyle = C.acid; ctx.beginPath(); ctx.arc(cx, cy, R * R_OBULL, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = C.magenta; ctx.beginPath(); ctx.arc(cx, cy, R * R_IBULL, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      ctx.font = '700 ' + Math.max(8, Math.round(R * 0.085)) + 'px Rajdhani, system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = hexN(C.ink, 0.85);
      for (i = 0; i < 20; i++) {                       // numbers around the double ring
        a = -i * STEP;
        ctx.fillText(ORDER[i], cx + Math.sin(a) * R * 1.09, cy - Math.cos(a) * R * 1.09);
      }
    }
    function drawDarts(now) {
      for (var i = 0; i < dartsOnBoard.length; i++) {
        var d = dartsOnBoard[i], age = reduced ? 1 : clamp((now - d.t) / 180, 0, 1), len = R * (0.16 + 0.1 * age);
        ctx.save();
        ctx.globalAlpha = 0.4 + 0.6 * age;
        ctx.translate(cx + d.x * R, cy - d.y * R); ctx.rotate(Math.atan2(-d.y, d.x));
        ctx.shadowColor = C.orange; ctx.shadowBlur = 12;
        ctx.strokeStyle = C.ink; ctx.lineWidth = Math.max(1.5, R * 0.016); ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(len, 0); ctx.stroke();
        ctx.shadowColor = C.cyan; ctx.fillStyle = C.cyan;
        rr(len - R * 0.02, -R * 0.035, R * 0.09, R * 0.07, R * 0.02); ctx.fill(); ctx.restore();
      }
    }
    function drawReticle(now) {
      if (over) return;
      var q = reticle(now), s = R * (0.06 + 0.03 * power), col = charging ? C.orange : C.magenta;
      ctx.save();
      ctx.translate(cx + Math.sin(q.a) * q.r * R, cy - Math.cos(q.a) * q.r * R); ctx.rotate(q.a);
      ctx.strokeStyle = col; ctx.shadowColor = col; ctx.shadowBlur = 16; ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(-s * 2.1, 0); ctx.lineTo(-s, 0); ctx.moveTo(s, 0); ctx.lineTo(s * 2.1, 0);
      ctx.moveTo(0, -s * 2.1); ctx.lineTo(0, -s); ctx.moveTo(0, s); ctx.lineTo(0, s * 2.1); ctx.stroke();
      ctx.shadowBlur = 0; ctx.beginPath(); ctx.arc(0, 0, s * 0.42, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
    function drawButton(b, label, col, active) {
      ctx.save();
      rr(b.x, b.y, b.w, b.h, Math.min(14, b.h * 0.32));
      ctx.fillStyle = active ? hexN(col, 0.3) : 'rgba(255,255,255,.05)'; ctx.fill();
      ctx.strokeStyle = hexN(col, active ? 1 : 0.6); ctx.lineWidth = 2;
      ctx.shadowColor = col; ctx.shadowBlur = active ? 22 : 8; ctx.stroke(); ctx.shadowBlur = 0;
      ctx.fillStyle = active ? C.ink : col;
      var bs = fitSize('700', Math.max(11, Math.round(b.h * 0.34)), label, b.w - 12, 9);
      ctx.font = '700 ' + bs + 'px ' + RAI;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(label, b.x + b.w / 2, b.y + b.h / 2); ctx.restore();
    }
    function drawHud(now) {
      var fs = hudFont(), sm = Math.max(9, fs - 2);
      var top = hudTop, v = Math.min(visit, VISITS), target = TARGETS[v - 1];
      var y = barY, w = R * 2, my = btn.y - meterOff, i;
      var lScore = 'SCORE ' + score, lBest = 'BEST ' + (bestEver || 0),
        lVisit = 'VISIT ' + v + '/' + VISITS + '  ·  TARGET ' + target;
      ctx.textBaseline = 'middle';
      // The top row is three readouts sharing one line: shrink until all three
      // fit between the 12px margins, or they collide with each other on a phone.
      var GAPX = 10, room = cssW - 24 - GAPX * 2;
      while (fs > 10) {
        var tw = textW('700', fs, lScore) + textW('700', fs, lVisit) + textW('700', fs, lBest);
        if (tw <= room) break;
        fs--; sm = Math.max(9, fs - 2);
      }
      // HUD text sits over the board, so it carries its own dark shadow.
      ctx.shadowColor = 'rgba(0,0,0,.9)'; ctx.shadowBlur = 5;
      ctx.font = '700 ' + fs + 'px ' + RAI;
      ctx.textAlign = 'left'; ctx.fillStyle = C.ink; ctx.fillText(lScore, 12, top);
      ctx.textAlign = 'right'; ctx.fillStyle = C.ink; ctx.fillText(lBest, cssW - 12, top);
      ctx.textAlign = 'center'; ctx.fillStyle = C.cyan;
      ctx.fillText(lVisit, cssW / 2, top);
      // visit progress bar, with the tally and the three dart pips riding its
      // ends — a phone stage is too narrow to give them a lane beside the bar.
      ctx.fillStyle = 'rgba(255,255,255,.08)'; rr(cx - w / 2, y, w, 5, 2.5); ctx.fill();
      var p = clamp(visitScore / target, 0, 1);
      if (p > 0) { ctx.fillStyle = visitScore >= target ? C.acid : C.cyan; rr(cx - w / 2, y, w * p, 5, 2.5); ctx.fill(); }
      var pr = Math.max(4, R * 0.045);
      var tally = visitScore + '/' + target;
      var ts = fitSize('600', sm, tally, w / 2 - 26, 9);
      var tw2 = textW('600', ts, tally), pw = DARTS * pr * 2.8 + pr;
      ctx.fillStyle = 'rgba(0,0,0,.45)';
      rr(cx - w / 2 + 4, y + 2.5 - ts * 0.75, tw2 + 10, ts * 1.5, 4); ctx.fill();
      rr(cx + w / 2 - 8 - pw, y + 2.5 - pr - 3, pw + 8, (pr + 3) * 2, 4); ctx.fill();
      ctx.font = '600 ' + ts + 'px ' + RAI;
      ctx.fillStyle = C.ink; ctx.textAlign = 'left'; ctx.fillText(tally, cx - w / 2 + 9, y + 2.5);
      for (i = 0; i < DARTS; i++) {
        ctx.beginPath(); ctx.arc(cx + w / 2 - 8 - pr - i * pr * 2.8, y + 2.5, pr, 0, Math.PI * 2);
        ctx.fillStyle = i < darts ? C.magenta : 'rgba(255,255,255,.14)'; ctx.fill();
      }
      // power meter just under the board
      ctx.fillStyle = 'rgba(255,255,255,.08)'; rr(cx - R, my, R * 2, METER_H, 4); ctx.fill();
      if (power > 0) {
        var pc = power < 0.45 ? C.acid : (power < 0.8 ? C.cyan : C.magenta);
        ctx.save(); ctx.shadowColor = pc; ctx.shadowBlur = 12;
        ctx.fillStyle = pc; rr(cx - R, my, R * 2 * power, METER_H, 4); ctx.fill(); ctx.restore();
      }
      ctx.textAlign = 'center'; ctx.fillStyle = C.ink;
      var pwTxt = 'POWER ' + Math.round(power * 100) + '%';
      ctx.font = '600 ' + fitSize('600', sm, pwTxt, R * 2 - 8, 9) + 'px ' + RAI;
      ctx.fillText(pwTxt, cx, my - LABEL_GAP);
      ctx.shadowBlur = 0;
      if (lastDart && !over) {
        ctx.shadowColor = 'rgba(0,0,0,.9)'; ctx.shadowBlur = 5;
        var last = 'LAST: ' + lastDart.label;
        ctx.font = '600 ' + fitSize('600', sm, last, cssW - 20, 9) + 'px ' + RAI;
        ctx.textAlign = 'center'; ctx.fillStyle = C.ink;
        ctx.fillText(last, cx, cy + R * 0.72); ctx.shadowBlur = 0;
      }
      if (flash && now - flashAt < 1100) {          // fading "+60  T20 60" callout
        ctx.globalAlpha = clamp(1 - (now - flashAt) / 1100, 0, 1);
        ctx.fillStyle = flash.color;
        var fl = flash.text, fz = Math.max(13, Math.round(R * 0.13));
        ctx.font = '900 ' + fitSize('900', fz, fl, cssW - 20, 10, ORB) + 'px ' + ORB;
        ctx.textAlign = 'center';
        ctx.shadowColor = flash.color; ctx.shadowBlur = 20;
        ctx.fillText(fl, cx, cy - R * 0.62); ctx.shadowBlur = 0; ctx.globalAlpha = 1;
      }
    }
    function card(title, sub, color, hint) {
      var PAD = 14, maxW = cssW - PAD * 2;
      ctx.fillStyle = hexN(C.bg, 0.74); ctx.fillRect(0, 0, cssW, cssH);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      // The stage is taller than it is wide on a phone, so the height term alone
      // blew these up: size from the smaller dimension, then fit to the width,
      // and wrap the long sub-line (a game-over message) instead of clipping it.
      var tMax = Math.round(clamp(Math.min(cssH * 0.13, cssW * 0.16), 18, 60));
      var tf = fitSize('900', tMax, title, maxW, 13, ORB);
      var sf = Math.round(clamp(Math.min(cssH * 0.05, cssW * 0.06), 12, 22));
      var subFit = wrapFit(sub, sf, '600', maxW, 11, 3);
      var hf = hint ? fitSize('600', sf, hint, maxW, 11) : 0;
      var tH = tf * 1.2, sH = subFit.lines.length * subFit.size * 1.25;
      var total = tH + 6 + sH + (hint ? 12 + sf * 1.3 : 0);
      var y = cssH * 0.4 - total / 2;
      ctx.font = '900 ' + tf + 'px ' + ORB;
      ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 28;
      ctx.fillText(title, cssW / 2, y + tH / 2); ctx.shadowBlur = 0;
      y += tH + 6;
      ctx.font = '600 ' + subFit.size + 'px ' + RAI;
      ctx.fillStyle = C.dim;
      for (var i = 0; i < subFit.lines.length; i++) {
        ctx.fillText(subFit.lines[i], cssW / 2, y + subFit.size * 0.65 + i * subFit.size * 1.25);
      }
      y += sH;
      if (hint) {
        ctx.fillStyle = color; ctx.font = '600 ' + hf + 'px ' + RAI;
        ctx.fillText(hint, cssW / 2, y + 12 + sf * 0.65);
      }
    }
    function draw(now) {
      ctx.fillStyle = C.bg; ctx.fillRect(0, 0, cssW, cssH);
      drawBoard(); drawDarts(now); drawReticle(now);
      // CRT treatment belongs to the world layer only — it is applied before the HUD.
      if (!reduced) { ctx.fillStyle = 'rgba(0,0,0,.15)';
        if (ctx.__pxH !== cssH) { var __px = document.createElement('canvas'); __px.width = 1; __px.height = 3;
          var __pxg = __px.getContext('2d'); __pxg.fillStyle = 'rgba(0,0,0,.15)'; __pxg.fillRect(0, 0, 1, 1);
          ctx.__pxP = ctx.createPattern(__px, 'repeat'); ctx.__pxH = cssH; }
        ctx.fillStyle = ctx.__pxP; ctx.fillRect(0, 0, cssW, cssH); }
      var vig = ctx.createRadialGradient(cssW / 2, cssH / 2, Math.min(cssW, cssH) * 0.35,
        cssW / 2, cssH / 2, Math.max(cssW, cssH) * 0.75);
      vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(0,0,0,.55)');
      ctx.fillStyle = vig; ctx.fillRect(0, 0, cssW, cssH);
      // HUD and touch buttons go on top of the vignette so they stay at full contrast.
      drawHud(now);
      drawButton(btn.small, 'BULL', C.violet, false);
      drawButton(btn, phase === 'aim' ? 'HOLD TO THROW' : 'THROWING…', charging ? C.acid : C.cyan, charging);
      if (over) card('GAME OVER', overMsg + ' — SCORE ' + score + (isRecord ? '  ·  NEW BEST' : ''),
        C.magenta, 'TAP or press SPACE to play again');
      else if (paused) card(booted ? 'PAUSED' : 'BULLSEYE DASH',
        booted ? 'Tap or press a key to resume' : 'Clear the target to advance the visit',
        C.cyan, 'Drag to aim · release to throw');
    }
    /* -------------------------- Single rAF loop -------------------------- */
    var last = 0;
    function frame(now) {
      if (destroyed) return;   // guard: destroy() can land between frames
      var dt = last ? Math.min(120, now - last) : 16; last = now;
      if (!paused && !over) {
        if (held.Left || held.A) aimA -= AIM_STEP * dt / 1000;
        if (held.Right || held.D) aimA += AIM_STEP * dt / 1000;
        if (held.Up || held.W) aimR = clamp(aimR - RAD_STEP * dt / 1000, 0, 0.99);
        if (held.Down || held.S) aimR = clamp(aimR + RAD_STEP * dt / 1000, 0, 0.99);
        if (charging && phase === 'aim') {
          power += chargeDir * dt / chargeMs();
          if (power >= 1) { power = 1; chargeDir = -1; } else if (power <= 0) { power = 0; chargeDir = 1; }
        }
        if (phase === 'flight' && now >= flightEnd) { phase = 'aim'; if (darts >= DARTS) endVisit(); }
      }
      draw(now);
      if (!destroyed) rafId = requestAnimationFrame(frame); // never re-arm after teardown
    }
    /* ------------------- Input: keyboard + pointer drag ------------------- */
    function beginCharge() {
      if (over || paused || phase !== 'aim') return;
      charging = true; power = 0; chargeDir = 1; chargeStart = performance.now();
    }
    function release() {
      if (!charging) return;
      charging = false;
      // A stray tap is not a throw: it never wound the meter, so nothing is thrown.
      // (Zeroing the power and throwing anyway landed every one of them dead centre,
      // which is the inner bull and the best dart on the board.)
      if (performance.now() - chargeStart < MIN_CHARGE_MS) {
        power = 0;
        flash = { text: 'TOO SHORT', color: C.orange };
        flashAt = performance.now();
        if (live.textContent !== SHORT_MSG) live.textContent = SHORT_MSG;
        return;
      }
      throwDart(performance.now());
    }
    function inBtn(b, x, y) { return b && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h; }
    function local(e) { var r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
    function aimAt(x, y) { // touch drag sets the aim point directly on the board
      var nx = (x - cx) / R, ny = (cy - y) / R, m = Math.sqrt(nx * nx + ny * ny);
      if (m > 0.002) aimA = Math.atan2(nx, ny);
      aimR = clamp(m, 0, 0.99);
    }
    var dragging = false, btnMode = false;
    function onPointerDown(e) {
      if (destroyed || (e.button !== undefined && e.button > 0)) return;
      var p = local(e);
      if (over) { resetRun(); reportStatus(); return; }
      unpause(); dragging = true;
      btnMode = inBtn(btn.small, p.x, p.y) ? 'bull' : (inBtn(btn, p.x, p.y) ? 'throw' : null);
      if (btnMode === 'bull') { aimR = 0; aimA = 0; dragging = false; return; } // BULL: snap to dead centre
      if (phase === 'aim') { if (!btnMode) aimAt(p.x, p.y); beginCharge(); }
      if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
      e.preventDefault();
    }
    function onPointerMove(e) { if (!dragging || btnMode || destroyed) return; var p = local(e); aimAt(p.x, p.y); }
    function onPointerUp(e) {
      if (destroyed) return;
      var p = local(e);
      // Sliding off the THROW button cancels the throw instead of firing it.
      if (btnMode === 'throw' && !inBtn(btn, p.x, p.y)) { dragging = false; btnMode = null; return; }
      dragging = false; btnMode = null; release();
    }
    function onPointerCancel() { dragging = false; btnMode = null; charging = false; }
    var AIM_KEYS = { ArrowLeft: 'Left', KeyA: 'A', ArrowRight: 'Right', KeyD: 'D', ArrowUp: 'Up', KeyW: 'W', ArrowDown: 'Down', KeyS: 'S' };
    function isThrow(e) { return e.code === 'Space' || e.code === 'Enter' || e.key === ' '; }
    function inField(t) { return !!(t && t !== canvas && /^(BUTTON|INPUT|SELECT|TEXTAREA|A|SUMMARY)$/.test(t.tagName)); }
    function onKeyDown(e) {
      if (destroyed || e.metaKey || e.ctrlKey || e.altKey) return;
      // Arrows always aim; SPACE/ENTER is only stolen from a genuinely focused control.
      if (AIM_KEYS[e.code]) { held[AIM_KEYS[e.code]] = true; unpause(); e.preventDefault(); return; }
      if (!isThrow(e) || inField(e.target)) return;
      e.preventDefault();
      if (over) { resetRun(); reportStatus(); return; }
      if (paused) { unpause(); return; }
      if (!e.repeat) beginCharge();
    }
    function onKeyUp(e) {
      if (AIM_KEYS[e.code]) { held[AIM_KEYS[e.code]] = false; return; }
      if (isThrow(e) && !inField(e.target)) { e.preventDefault(); release(); }
    }
    function onResize() { if (!destroyed) resize(); }
    function onBlur() {
      if (destroyed) return;
      paused = true; charging = false; dragging = false; held = {};
      if (booted && !over) setStatus('Paused');
    }
    function onVisibility() { if (document.hidden) onBlur(); }
    // Every listener the game owns, in one table so teardown cannot miss one.
    var BIND = [[document, 'keydown', onKeyDown], [document, 'keyup', onKeyUp],
      [canvas, 'pointerdown', onPointerDown], [canvas, 'pointermove', onPointerMove],
      [canvas, 'pointerup', onPointerUp], [canvas, 'pointercancel', onPointerCancel],
      [window, 'resize', onResize, { passive: true }], [window, 'orientationchange', onResize],
      [window, 'blur', onBlur], [document, 'visibilitychange', onVisibility]];
    BIND.forEach(function (b) { b[0].addEventListener(b[1], b[2], b[3]); });
    resetRun(); last = performance.now();
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
    name: 'Bullseye Dash',
    instructions:
      'Nine visits of three darts, darts-style. DRAG anywhere on the board to aim and RELEASE to throw; on ' +
      'keyboard use the ARROW keys to aim, HOLD SPACE to wind up power and release to throw. Power sets ' +
      'distance — a weak throw falls short — and scatter, so the doubles need a full-power dart and the ' +
      'trebles a well-judged one. Hit the visit target or the run is bust, and the sway and the scatter ' +
      'both grow as the visits climb. Finishing a visit on a double, treble or bull pays a bonus. ' +
      'Best score is saved on this device.',
    start: start
  };
})();
