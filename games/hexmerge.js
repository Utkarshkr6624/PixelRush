/**
 * PIXEL RUSH — games/hexmerge.js — "Hex Merge"
 * Contract (SPEC.md): window.PixelGame = { name, instructions, start(root, api) } where
 * api = { setScore(n), setBest(n), gameOver(score) } and start() returns { destroy() }.
 * Self-contained: no imports, no dependencies, no assets — one <canvas> + 2D ctx, and
 * every rAF id, listener and timer created in start() is torn down in destroy().
 */
(function () {
  'use strict';
  /* -------------------------------- Tuning -------------------------------- */
  var STORE_KEY = 'pixelrush.hexmerge.best';
  var COLS = 7, ROWS = 9;         // flat-top hex columns; odd columns sit half a row lower
  var DANGER = 2;                 // settling in the top DANGER rows ends the run
  var HEXW = 1.5, ROWH = Math.sqrt(3); // column pitch / row pitch, in units of R
  var DROPS_PER_LEVEL = 6;        // a level (and its spawn ramp) every N drops
  var DROP_POINTS = 2;            // flat points for every tile that lands
  var MERGE_BASE = 10;            // merge points = MERGE_BASE * 2^rank * chain
  var LEVEL_BONUS = 50;
  var FALL_MS = 150, MERGE_MS = 200, FLICK = 26;  // FLICK = px of horizontal drag per column
  var RANK_C = ['cyan', 'magenta', 'acid', 'orange', 'violet'];
  var STYLES = '.hm{position:relative;width:100%;height:100%;overflow:hidden;touch-action:none;' +
    'user-select:none;-webkit-tap-highlight-color:transparent;' +
    'font-family:var(--font-body,"Rajdhani",system-ui,sans-serif);color:var(--ink,#f2f5ff)}' +
    '.hm canvas{display:block;width:100%;height:100%;outline:none}';
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function readBest() {
    try { var v = parseInt(window.localStorage.getItem(STORE_KEY), 10);
      return isFinite(v) && v > 0 ? v : null; } catch (e) { return null; } // private mode
  }
  function writeBest(v) {
    try { window.localStorage.setItem(STORE_KEY, String(v)); } catch (e) { /* ignore */ }
  }
  /** Odd-q flat-top neighbour table: even columns index up, odd columns index down. */
  function neighbours(r, c) {
    var up = (c & 1) ? 0 : -1, dn = (c & 1) ? 1 : 0;
    return [[r - 1, c], [r + 1, c], [r + up, c - 1], [r + up, c + 1], [r + dn, c - 1], [r + dn, c + 1]];
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
    var wrap = document.createElement('div'); wrap.className = 'hm';
    var canvas = document.createElement('canvas');
    canvas.setAttribute('tabindex', '0'); canvas.setAttribute('role', 'application');
    canvas.setAttribute('aria-label',
      'Hex Merge board. Left and right arrows aim, space drops. On touch, tap a column to drop or swipe sideways.');
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
    /* ------------------------------ State ------------------------------- */
    var grid = [];                 // grid[r][c] = 0 empty, else tile value (1-based)
    var score = 0, bestEver = readBest(), isRecord = false;
    var drops = 0, level = 0;
    var target = 3;                // aimed column
    var cur = 1, next = 1;         // value of the held tile and of the preview
    var started = false, paused = false, busy = false, over = false;
    var fall = null;               // { r, c, val, t0, dur, y0 }
    var pops = [];                 // { r, c, t0, val, col }
    var sparks = [];               // { x, y, vx, vy, t0, col }
    var settleAt = 0, comboShownAt = -1e9, combo = 0, flashCol = -1, flashAt = -1e9, lvlAt = -1e9;
    /* ----------------- Sizing (crisp devicePixelRatio) ----------------- */
    var dpr = 1, cssW = 1, cssH = 1, R = 10, bx = 0, by = 0, areaX = 0, areaY = 0, areaW = 1, areaH = 1;
    var barTop = 0, barBot = 0, btn = null;
    var wu = HEXW * (COLS - 1) + 2, hu = ROWH * (ROWS - 0.5) + 1.7;  // board extents in units of R
    function resize() {
      var r = wrap.getBoundingClientRect();
      cssW = Math.max(1, Math.round(r.width)); cssH = Math.max(1, Math.round(r.height));
      dpr = clamp(window.devicePixelRatio || 1, 1, 2); // capped: 3x phones choke on the glow passes
      canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
      canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Proportional bars. The old fixed 40/58 px floors ate over half of a short phone
      // stage (186 px tall -> 88 px of play area), so the floors scale with the stage.
      barTop = Math.round(clamp(cssH * 0.13, 24, 84));
      barBot = Math.round(clamp(cssH * 0.15, 36, 104));
      areaX = 0; areaY = barTop; areaW = cssW; areaH = Math.max(40, cssH - barTop - barBot);
      // Fit the whole board inside the play area at any aspect ratio — never stretch, never clip.
      R = Math.max(6, Math.min(areaW / wu, areaH / hu));
      bx = areaX + (areaW - R * wu) / 2;
      by = areaY + (areaH - R * hu) / 2;
      // Thumb-zone button row: LEFT / DROP / RIGHT, evenly spaced, no overlap.
      var bh = Math.max(26, Math.min(barBot - 10, Math.max(38, areaW * 0.11))), gap = 10;
      var bw = Math.min(120, (areaW - gap * 4) / 3), bxx = (cssW - (bw * 3 + gap * 2)) / 2;
      var byy = cssH - barBot + Math.max(0, (barBot - bh) / 2);
      btn = {
        h: bh, left: { x: bxx, y: byy, w: bw, h: bh },
        drop: { x: bxx + bw + gap, y: byy, w: bw, h: bh },
        right: { x: bxx + (bw + gap) * 2, y: byy, w: bw, h: bh }
      };
    }
    function cx(c) { return bx + R * (HEXW * c + 1); }
    function cy(r, c) { return by + R * (ROWH * (r + 0.5 * (c & 1)) + 1); }
    function columnAt(px) { return clamp(Math.round((px - bx) / R / HEXW - 1), 0, COLS - 1); }
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
    function mix(a, b, t) { // blend two #rrggbb colours — the rank darkening ramp
      var A = parseInt(a.replace('#', ''), 16), B = parseInt(b.replace('#', ''), 16), o = '';
      for (var i = 16; i >= 0; i -= 8) o += (i === 16 ? '' : ',') +
        Math.round(((A >> i) & 255) + (((B >> i) & 255) - ((A >> i) & 255)) * t);
      return 'rgb(' + o + ')';
    }
    /** Rank v (1-based) -> palette colour, dimmed toward the background as the rank climbs. */
    function tileCol(v) { return mix(C[RANK_C[(v - 1) % RANK_C.length]], C.bg, Math.min(0.52, (v - 1) * 0.075)); }
    var ORB = 'Orbitron, system-ui, sans-serif', RAJ = 'Rajdhani, system-ui, sans-serif';
    /**
     * Set ctx.font, stepping the size down until `text` measures no wider than `maxW`.
     * The stage is taller than it is wide on a phone, so height alone can size text past
     * the canvas edges; this guarantees the fit whatever the aspect ratio.
     */
    function fitFont(weight, size, family, text, maxW) {
      var px = Math.max(8, Math.round(size));
      ctx.font = weight + ' ' + px + 'px ' + family;
      while (px > 8 && ctx.measureText(text).width > maxW) {
        px--; ctx.font = weight + ' ' + px + 'px ' + family;
      }
      return px;
    }
    // Flat-top regular hexagon: 6 vertices 60 deg apart, starting at 0 (corner pointing
    // right), which is the orientation the cx/cy grid and the 1.5R / sqrt(3)R pitches assume.
    function hexPath(x, y, rad) {
      ctx.beginPath();
      for (var i = 0; i < 6; i++) { var a = Math.PI / 3 * i;
        var px = x + rad * Math.cos(a), py = y + rad * Math.sin(a);
        if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); }
      ctx.closePath();
    }
    /* ---------------------------- Game logic ---------------------------- */
    function setPaused(v) { if (paused === v) return; paused = v; setStatus(v ? 'Paused' : 'Playing'); }
    /** Flood fill of same-value tiles connected to (r,c). */
    function group(r, c) {
      var val = grid[r][c], seen = {}, out = [], stack = [[r, c]], key;
      while (stack.length) {
        var p = stack.pop(); key = p[0] + ',' + p[1];
        if (seen[key] || grid[p[0]][p[1]] !== val) continue;
        seen[key] = 1; out.push(p);
        var nb = neighbours(p[0], p[1]);
        for (var i = 0; i < 6; i++) {
          var q = nb[i];
          if (q[0] < 0 || q[0] >= ROWS || q[1] < 0 || q[1] >= COLS) continue;
          if (grid[q[0]][q[1]] === val) stack.push(q);
        }
      }
      return out;
    }
    /** Spawn ramp: rank 1 only at first, higher ranks unlock as levels accrue. */
    function rollTile() {
      var t = Math.random();
      if (level >= 6 && t < 0.07) return 4;
      if (level >= 3 && t < 0.17) return 3;
      if (level >= 1 && t < 0.42) return 2;
      return 1;
    }
    function lowestFree(c) { for (var r = ROWS - 1; r >= 0; r--) if (!grid[r][c]) return r; return -1; }
    function clearGrid() { // a real, empty board — draw() indexes it on frame 1, before the first run
      grid = [];
      for (var r = 0; r < ROWS; r++) { grid.push([]); for (var c = 0; c < COLS; c++) grid[r].push(0); }
    }
    function pushScore(v) {
      score += v; setScore(score);
      if (bestEver === null || score > bestEver) { bestEver = score; isRecord = true; writeBest(score); setBest(score); }
    }
    function resetRun() {
      clearGrid();
      score = 0; drops = 0; level = 0; target = Math.floor(COLS / 2);
      cur = rollTile(); next = rollTile();
      pops.length = 0; sparks.length = 0; fall = null;
      busy = false; combo = 0; comboShownAt = -1e9; flashCol = -1; lvlAt = -1e9;
      started = true; setPaused(false); over = false;
      setScore(0); if (bestEver !== null) setBest(bestEver);
      live.textContent = 'New run. Score 0. Tap a column to drop.';
    }
    function die(reason) {
      if (over || destroyed) return;   // api.gameOver() may only fire once per run
      over = true; busy = false; paused = false; fall = null;
      live.textContent = reason + ' Final score ' + score + '.';
      gameOverCb(score);
    }
    function doDrop() {
      if (destroyed || over || !started || busy) return;
      setPaused(false);
      var r = lowestFree(target);
      if (r < 0) { flashCol = target; flashAt = performance.now(); return; } // column full: refuse, no penalty
      busy = true; combo = 0;
      fall = { r: r, c: target, val: cur, t0: performance.now(), dur: reduced ? 60 : FALL_MS, y0: -R * 1.4 };
      cur = next; next = rollTile();
    }
    function land() {
      var f = fall; fall = null;
      grid[f.r][f.c] = f.val;
      var chain = 0, r = f.r, c = f.c, val = f.val, dur = 0;
      // One resolution pass per chain step; the new tile re-triggers if it touches a pair.
      for (var guard = 0; guard < 12; guard++) {
        var g = group(r, c);
        if (g.length < 2) break;
        chain++; dur += reduced ? 60 : MERGE_MS;
        for (var i = 0; i < g.length; i++) {
          if (g[i][0] === r && g[i][1] === c) continue;
          grid[g[i][0]][g[i][1]] = 0;
          pops.push({ r: g[i][0], c: g[i][1], t0: performance.now(), val: val });
          if (!reduced) burst(cx(g[i][1]), cy(g[i][0], g[i][1]), val, 5);
        }
        val = val + 1;
        grid[r][c] = val;
        pops.push({ r: r, c: c, t0: performance.now(), val: val });
        if (!reduced) burst(cx(c), cy(r, c), val, 12);
        pushScore(MERGE_BASE * Math.pow(2, val - 2) * chain);
      }
      if (chain) { combo = chain; comboShownAt = performance.now(); settleAt = performance.now() + dur; }
      else busy = false;
      pushScore(DROP_POINTS);
      drops++;
      var lv = Math.floor(drops / DROPS_PER_LEVEL);
      if (lv > level) { level = lv; pushScore(LEVEL_BONUS); lvlAt = performance.now(); }
      if (combo) live.textContent = (chain > 1 ? 'Chain of ' + chain + '. ' : '') + 'Score ' + score + '.';
      // Reaching the danger zone (after merges had their chance) ends the run.
      for (var dr = 0; dr < DANGER; dr++) {
        for (var dc = 0; dc < COLS; dc++) if (grid[dr][dc]) { die('Stacked to the top of the board.'); return; }
      }
    }
    function burst(x, y, v, n) {
      for (var i = 0; i < n; i++) {
        var a = Math.random() * Math.PI * 2, sp = R * (0.6 + Math.random() * 1.6);
        sparks.push({ x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, t0: performance.now(), col: tileCol(v) });
      }
    }
    /* ---------------------------- Rendering ---------------------------- */
    function drawHex(x, y, rad, col, alpha, glow) {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.shadowColor = col; ctx.shadowBlur = glow;
      ctx.fillStyle = col; hexPath(x, y, rad); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = alpha * 0.55; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = Math.max(1, rad * 0.06);
      hexPath(x, y, rad * 0.74); ctx.stroke();
      ctx.restore();
    }
    function drawTile(r, c, v, scale, alpha, glow) {
      var col = tileCol(v);
      drawHex(cx(c), cy(r, c), R * 0.94 * scale, col, alpha, glow);
      if (R >= 7 && v >= 3) {  // rank numerals once the hexes are big enough to carry them
        ctx.save();
        ctx.globalAlpha = alpha; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.font = '800 ' + Math.max(6, Math.round(R * 0.8)) + 'px Orbitron, system-ui, sans-serif';
        ctx.fillStyle = hexA('#000000', 0.55); ctx.fillText(String(v), cx(c), cy(r, c) + R * 0.03);
        ctx.fillStyle = hexA('#ffffff', 0.95); ctx.fillText(String(v), cx(c), cy(r, c) + R * 0.03);
        ctx.restore();
      }
    }
    function draw(now) {
      var w = cssW, h = cssH;
      ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);
      // Danger band behind the top rows.
      var dy0 = by + R, dy1 = by + R * (ROWH * (DANGER - 0.5) + 1);
      ctx.fillStyle = hexA(C.magenta, 0.07); ctx.fillRect(0, dy0, w, dy1 - dy0);
      ctx.save(); ctx.strokeStyle = hexA(C.magenta, 0.4); ctx.lineWidth = 1;
      ctx.setLineDash([7, 6]); ctx.beginPath(); ctx.moveTo(0, dy1); ctx.lineTo(w, dy1); ctx.stroke(); ctx.restore();
      // Empty cell wells, the aimed column lit.
      for (var r = 0; r < ROWS; r++) for (var c = 0; c < COLS; c++) {
        if (grid[r][c]) continue;
        var hot = (c === target && !over && started);
        ctx.save();
        ctx.strokeStyle = hexA(hot ? C.cyan : C.dim, hot ? 0.55 : 0.3);
        ctx.lineWidth = hot ? 1.8 : 1; ctx.shadowColor = hexA(C.cyan, 0.5); ctx.shadowBlur = hot ? 12 : 0;
        hexPath(cx(c), cy(r, c), R * 0.88); ctx.stroke();
        if (hot) { ctx.fillStyle = hexA(C.cyan, 0.06); ctx.fill(); }
        ctx.restore();
      }
      // Ghost of the held tile in the cell it would land in.
      var lr = lowestFree(target);
      if (started && !over && !busy && lr >= 0) {
        ctx.save(); ctx.globalAlpha = 0.3; ctx.strokeStyle = tileCol(cur); ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]); ctx.shadowColor = tileCol(cur); ctx.shadowBlur = 10;
        hexPath(cx(target), cy(lr, target), R * 0.9); ctx.stroke(); ctx.restore();
        drawTile(lr, target, cur, 0.55, 0.22, 8);
      }
      // Settled tiles, with a gentle breath on the aimed column.
      for (var rr = 0; rr < ROWS; rr++) for (var cc = 0; cc < COLS; cc++) {
        var v = grid[rr][cc]; if (!v) continue;
        var pulse = (!reduced && cc === target && !over) ? 1 + 0.03 * Math.sin(now / 180) : 1;
        drawTile(rr, cc, v, pulse, 0.92, 14);
      }
      // Merge pops: swell then fade out where the consumed tiles stood.
      for (var p = pops.length - 1; p >= 0; p--) {
        var age = (now - pops[p].t0) / (reduced ? 130 : 260);
        if (age > 1) { pops.splice(p, 1); continue; }
        drawTile(pops[p].r, pops[p].c, pops[p].val, 1 + age * 0.5, 0.9 * (1 - age), 22 * (1 - age));
      }
      // Falling tile.
      if (fall) {
        var t = clamp((now - fall.t0) / fall.dur, 0, 1), ease = 1 - Math.pow(1 - t, 2);
        var fy = fall.y0 + (cy(fall.r, fall.c) - fall.y0) * ease;
        drawHex(cx(fall.c), fy, R * 0.94, tileCol(fall.val), 0.95, 20);
      }
      // Sparks.
      if (!reduced) for (var s = sparks.length - 1; s >= 0; s--) {
        var sa = (now - sparks[s].t0) / 420;
        if (sa > 1) { sparks.splice(s, 1); continue; }
        var sx2 = sparks[s].x + sparks[s].vx * sa * 0.4, sy2 = sparks[s].y + sparks[s].vy * sa * 0.4;
        ctx.save(); ctx.globalAlpha = 1 - sa; ctx.fillStyle = sparks[s].col;
        ctx.shadowColor = sparks[s].col; ctx.shadowBlur = 10; ctx.beginPath();
        ctx.arc(sx2, sy2, Math.max(1, R * 0.09 * (1 - sa)), 0, Math.PI * 2);
        ctx.fill(); ctx.restore();
      }
      // Column-full refusal flash.
      if (flashCol >= 0) {
        var fa = 1 - (now - flashAt) / 260;
        if (fa <= 0) flashCol = -1; else {
          ctx.save(); ctx.globalAlpha = fa; ctx.fillStyle = C.magenta;
          ctx.fillRect(cx(flashCol) - R, by, R * 2, R * hu); ctx.restore();
        }
      }
      // CRT polish: scanlines + vignette over the world only — the HUD is drawn after it.
      if (!reduced) { ctx.fillStyle = 'rgba(0,0,0,.15)';
        for (var sy = 0; sy < h; sy += 3) ctx.fillRect(0, sy, w, 1); }
      var vig = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75);
      vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(0,0,0,.55)');
      ctx.fillStyle = vig; ctx.fillRect(0, 0, w, h);
      // HUD on top of the CRT overlay so the readouts and thumb buttons stay legible.
      drawHud(now);
      if (over) card('GAME OVER', 'SCORE ' + score + (isRecord ? '  ·  NEW BEST' : ''), C.magenta,
        'TAP or press SPACE to play again');
      else if (!started) card('HEX MERGE', 'Match neighbours, climb the ranks', C.cyan, 'TAP, or press SPACE, to start');
      else if (paused) card('PAUSED', 'Tap or press a key to resume', C.cyan, null);
    }
    function drawHud(now) {
      ctx.save();
      var fs = Math.round(clamp(Math.min(cssH * 0.042, cssW * 0.05), 11, 17));
      var scoreMaxW = Math.max(50, cssW * 0.34), centreMaxW = Math.max(50, cssW * 0.28);
      ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      // Soft dark halo so the readouts stay readable over lit tiles and the button row.
      ctx.shadowColor = 'rgba(0,0,0,0.85)'; ctx.shadowBlur = 6;
      fitFont(700, fs, RAJ, 'SCORE ' + score, scoreMaxW);
      ctx.fillStyle = C.ink; ctx.fillText('SCORE ' + score, 12, barTop * 0.5);
      ctx.textAlign = 'center';
      var lvlText = 'LEVEL ' + level;
      fitFont(700, fs, RAJ, lvlText, centreMaxW);
      var lvlHalf = ctx.measureText(lvlText).width / 2;
      ctx.fillStyle = (now - lvlAt < 300) ? C.acid : C.ink;
      ctx.fillText(lvlText, cssW / 2, barTop * 0.5);
      if (now - comboShownAt < 900 && combo > 1) {
        fitFont(700, fs, RAJ, 'COMBO x' + combo, centreMaxW);
        ctx.fillStyle = C.magenta; ctx.shadowColor = C.magenta; ctx.shadowBlur = 14;
        ctx.fillText('COMBO x' + combo, cssW / 2, barTop * 0.5 + fs * 1.4);
        ctx.shadowColor = 'rgba(0,0,0,0.85)'; ctx.shadowBlur = 6;
      }
      // NEXT preview, top-right, with the best score beneath it.
      var pr = Math.min(barTop * 0.5, 26), px = cssW - 12 - pr, py = barTop * 0.5;
      ctx.save(); ctx.globalAlpha = busy ? 0.35 : 1;
      drawHex(px, py, pr, tileCol(next), 0.9, 16); ctx.restore();
      ctx.textAlign = 'right';
      // BEST may only use what is left between the LEVEL readout and the NEXT hex.
      var bestX = cssW - 12 - pr * 2 - 8;
      fitFont(600, fs * 0.78, RAJ, 'BEST ' + (bestEver || 0),
        Math.max(30, bestX - (cssW / 2 + lvlHalf + 8)));
      ctx.fillStyle = C.ink; ctx.fillText('BEST ' + (bestEver || 0), bestX, barTop * 0.5);
      // Thumb-zone buttons.
      drawButton(btn.left, '◀', C.cyan);
      drawButton(btn.right, '▶', C.cyan);
      drawButton(btn.drop, 'DROP', C.acid);
      ctx.restore();
    }
    function drawButton(b, label, col) {
      ctx.save();
      ctx.strokeStyle = hexA(col, 0.75); ctx.lineWidth = 2; ctx.shadowColor = hexA(col, 0.7); ctx.shadowBlur = 12;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(b.x, b.y, b.w, b.h, Math.min(12, b.h * 0.28));
      else ctx.rect(b.x, b.y, b.w, b.h);
      ctx.fillStyle = hexA(col, 0.1); ctx.fill(); ctx.stroke();
      ctx.shadowBlur = 8; ctx.fillStyle = col; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      var f = Math.round(clamp(Math.min(b.h * (label.length > 2 ? 0.34 : 0.5), b.w * 0.34), 11, 22));
      fitFont(900, f, ORB, label, b.w - 10);
      ctx.fillText(label, b.x + b.w / 2, b.y + b.h / 2);
      ctx.restore();
    }
    /** Centred overlay: big neon title, one dim line of sub-copy, optional hint. */
    function card(title, sub, color, hint) {
      ctx.fillStyle = hexA(C.bg, 0.74); ctx.fillRect(0, 0, cssW, cssH);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      var pad = Math.min(24, cssW * 0.06), maxW = Math.max(40, cssW - pad * 2);
      fitFont(900, clamp(Math.min(cssH * 0.11, cssW * 0.14), 16, 56), ORB, title, maxW);
      ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 28;
      ctx.fillText(title, cssW / 2, cssH * 0.4); ctx.shadowBlur = 0;
      var bfs = clamp(Math.min(cssH * 0.045, cssW * 0.055), 10, 20);
      var lh = Math.round(bfs * 1.4);
      var sy = drawLines(sub, bfs, cssH * 0.5, maxW, lh);
      if (hint) drawLines(hint, bfs, sy + lh * 0.3, maxW, lh);
    }
    /** Centred, word-wrapped block laid out downward from `top`; returns the next free y. */
    function drawLines(text, size, top, maxW, lh) {
      var lines = wrapText(text, size, maxW);
      for (var i = 0; i < lines.length; i++) {
        ctx.fillStyle = C.dim; ctx.fillText(lines[i], cssW / 2, top + i * lh);
      }
      return top + lines.length * lh;
    }
    /** Split `text` on spaces, stepping the size down while any line is still too wide. */
    function wrapText(text, size, maxW) {
      var words = String(text).split(' '), lines, cur, i, t;
      for (var px = Math.round(size); px >= 9; px--) {
        ctx.font = '600 ' + px + 'px ' + RAJ;
        lines = []; cur = '';
        for (i = 0; i < words.length; i++) {
          t = cur ? cur + ' ' + words[i] : words[i];
          if (cur && ctx.measureText(t).width > maxW) { lines.push(cur); cur = words[i]; }
          else cur = t;
        }
        if (cur) lines.push(cur);
        var over = false;
        for (i = 0; i < lines.length; i++) if (ctx.measureText(lines[i]).width > maxW) { over = true; break; }
        if (!over) return lines;
      }
      return lines;
    }
    /* -------------------------- Single rAF loop -------------------------- */
    function frame(now) {
      if (destroyed) return;   // guard: destroy() can land between frames
      if (fall && now - fall.t0 >= fall.dur) { land(); if (destroyed) return; }
      if (busy && !fall && now >= settleAt) { busy = false; settleAt = 0; }
      draw(now);
      if (destroyed) return;   // re-check before re-arming: the shell may destroy from a callback
      rafId = requestAnimationFrame(frame);
    }
    /* ------------------- Input: keyboard + pointer ------------------- */
    function press() { // one place that (re)starts a run and un-pauses; true if the press was consumed
      if (over || !started) { resetRun(); return true; }
      if (paused) { setPaused(false); return true; }  // the key that only un-pauses never also acts
      return false;
    }
    function aim(d) { target = clamp(target + d, 0, COLS - 1); }
    function onKeyDown(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var a = document.activeElement;
      if (a && a !== canvas && /^(BUTTON|INPUT|SELECT|TEXTAREA|A|SUMMARY)$/.test(a.tagName)) return;
      if (e.code === 'Space' || e.code === 'Enter' || e.code === 'ArrowDown' || e.key === ' ') {
        e.preventDefault(); if (!press()) doDrop(); return;
      }
      if (e.code === 'ArrowLeft' || e.code === 'KeyA') { e.preventDefault(); if (!press()) aim(-1); }
      else if (e.code === 'ArrowRight' || e.code === 'KeyD') { e.preventDefault(); if (!press()) aim(1); }
      else if (e.code === 'KeyP') { e.preventDefault(); if (started && !over) setPaused(!paused); }
    }
    var down = false, sx = 0, moved = 0, pid = -1;
    function inBtn(x, y, b) { return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h; }
    function localXY(e) {
      var r = canvas.getBoundingClientRect();
      return { x: (e.clientX - r.left) * (cssW / Math.max(1, r.width)),
               y: (e.clientY - r.top) * (cssH / Math.max(1, r.height)) };
    }
    function onPointerDown(e) {
      if (e.button !== undefined && e.button !== 0) return;
      if (destroyed) return;
      var p = localXY(e);
      if (btn) {
        if (inBtn(p.x, p.y, btn.left)) { if (!press()) aim(-1); e.preventDefault(); return; }
        if (inBtn(p.x, p.y, btn.right)) { if (!press()) aim(1); e.preventDefault(); return; }
        if (inBtn(p.x, p.y, btn.drop)) { if (!press()) doDrop(); e.preventDefault(); return; }
      }
      down = true; pid = e.pointerId; sx = p.x; moved = 0;
      if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
    }
    function onPointerMove(e) {
      if (!down || e.pointerId !== pid) return;
      var p = localXY(e), dx = p.x - sx;
      while (Math.abs(dx - moved) >= FLICK) {     // each FLICK px of drag = one column
        var d = dx > moved ? 1 : -1; moved += d * FLICK; press(); aim(d);
      }
    }
    function onPointerUp(e) {
      if (!down || e.pointerId !== pid) return;
      down = false; pid = -1;
      if (Math.abs(moved) >= FLICK) return;   // that was a swipe, not a tap
      var p = localXY(e);
      // Only an actual button box swallows the release; the rest of the bottom strip is
      // live board, so no part of it is a dead zone.
      if (btn && (inBtn(p.x, p.y, btn.left) || inBtn(p.x, p.y, btn.drop) || inBtn(p.x, p.y, btn.right))) return;
      if (press()) return;                    // first tap started the run
      target = columnAt(p.x);                 // tap a column to aim and drop
      doDrop();
    }
    function onPointerCancel() { down = false; pid = -1; }
    function onResize() { if (!destroyed) resize(); }
    function onBlur() { if (!destroyed && !over && started) setPaused(true); }
    function onVisibility() { if (document.hidden) onBlur(); }
    // Every listener the game owns, in one table so teardown cannot miss one.
    var BIND = [[document, 'keydown', onKeyDown], [canvas, 'pointerdown', onPointerDown],
      [canvas, 'pointermove', onPointerMove], [canvas, 'pointerup', onPointerUp],
      [canvas, 'pointercancel', onPointerCancel],
      [window, 'resize', onResize, { passive: true }], [window, 'orientationchange', onResize],
      [window, 'blur', onBlur], [document, 'visibilitychange', onVisibility]];
    BIND.forEach(function (b) { b[0].addEventListener(b[1], b[2], b[3]); });
    clearGrid();                       // the READY screen draws a real (empty) board
    setScore(0);
    if (bestEver !== null) setBest(bestEver); else setBest(0);
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
    name: 'Hex Merge',
    instructions:
      'Aim with LEFT/RIGHT (or A/D), then SPACE or DOWN to drop. Tiles of the same rank that touch merge ' +
      'into the next rank up, and a merge that lands next to another pair chains again for a bigger combo. ' +
      'Score climbs with the rank you merge to, and the multiplier stacks through a chain. Every 6 drops is ' +
      'a level, which unlocks higher-rank tiles to feed the board. Let anything settle in the top band and the ' +
      'run is over. On touch, TAP a column to drop or SWIPE sideways to aim — thumb buttons do the same. ' +
      'Best score is saved on this device.',
    start: start
  };
})();
