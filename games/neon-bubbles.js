/**
 * PIXEL RUSH — games/neon-bubbles.js — "Neon Bubbles"
 * Contract: window.PixelGame = { name, instructions, start(root, api) } with
 * api = { setScore(n), setBest(n), gameOver(score) }; start() returns { destroy() }.
 * Hex-grid bubble shooter. Self-contained: one <canvas> + 2D ctx, no assets, no deps.
 */
(function () {
  'use strict';
  /* -------------------------------- Tuning -------------------------------- */
  var STORE_KEY = 'pixelrush.neon-bubbles.best'; // localStorage: best score only
  var COLS = 11;              // odd so the staggered hex rows stay symmetric
  var INITIAL_ROWS = 5;       // rows pre-filled at level 0
  var POP_POINTS = 10;        // per popped bubble …
  var CLUSTER_5 = 25;         // … plus a cluster bonus at 5+ and 9+ …
  var CLUSTER_9 = 60;         // … on top
  var DROP_POINTS = 20;       // per bubble that falls without being shot
  var CLEAR_BONUS = 500;      // whole field cleared
  var POPS_PER_LEVEL = 7;     // level ramp cadence
  var BASE_DROP = 9000;       // ms between descents at level 0 …
  var DROP_FALLOFF = 650;     // … minus this per level, …
  var MIN_DROP = 2800;        // … floored so it stays winnable
  var POP_MIN = 3;            // cluster size that counts as a pop
  var MAX_COLOURS = 6;        // cyan, magenta, acid, orange, violet, rose
  var AIM_RATE = 2.0;         // rad/s of keyboard aim sweep
  var AIM_MIN = Math.PI * 1.08, AIM_MAX = Math.PI * 1.92; // clamped to the upward arc
  var SWAP_COOLDOWN = 250;    // ms between colour swaps
  var STYLES = '.nb{position:relative;width:100%;height:100%;overflow:hidden;touch-action:none;' +
    'user-select:none;-webkit-tap-highlight-color:transparent;' +
    'font-family:var(--font-body,"Rajdhani",system-ui,sans-serif);color:var(--ink,#f2f5ff)}' +
    '.nb canvas{display:block;width:100%;height:100%;outline:none}';

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function randInt(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
  function readBest() {
    try { var v = parseInt(window.localStorage.getItem(STORE_KEY), 10);
      return isFinite(v) && v > 0 ? v : null; } catch (e) { return null; } // private mode
  }
  function writeBest(v) {
    try { window.localStorage.setItem(STORE_KEY, String(v)); } catch (e) { /* ignore */ }
  }

  function start(root, api) {
    api = api || {};
    var setScore = typeof api.setScore === 'function' ? api.setScore : function () {};
    var setBest = typeof api.setBest === 'function' ? api.setBest : function () {};
    var gameOverCb = typeof api.gameOver === 'function' ? api.gameOver : function () {};
    /* -------------------------------- DOM -------------------------------- */
    var wrap = document.createElement('div'); wrap.className = 'nb';
    var canvas = document.createElement('canvas');
    canvas.setAttribute('tabindex', '0'); canvas.setAttribute('role', 'application');
    canvas.setAttribute('aria-label', 'Neon Bubbles board. Left and right arrows aim, space fires, S swaps the next colour. On touch, drag to aim and release to fire.');
    var live = document.createElement('div'); // screen-reader announcements
    live.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0)';
    live.setAttribute('aria-live', 'polite');
    wrap.appendChild(canvas); wrap.appendChild(live);
    var styleTag = document.createElement('style'); styleTag.textContent = STYLES;
    wrap.appendChild(styleTag); root.appendChild(wrap);
    var ctx = canvas.getContext('2d');
    if (!ctx) { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); return { destroy: function () {} }; }

    var rafId = 0, destroyed = false;
    var reduced = !!(window.PX && window.PX.reduced) ||
      !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

    /* ------------------------------ State ------------------------------ */
    var grid = [];            // grid[row][col] = colour index, or 0 for empty
    var fallers = [];         // unshot bubbles animating away
    var shot = null;          // the bubble in flight
    var angle = -Math.PI / 2, score = 0, level = 0, pops = 0, bestEver = readBest();
    var queue = [1, 0, 1];    // [current, next, next-after]
    var dropIn = BASE_DROP, swapAt = 0, shake = 0, flashAt = -1e9;
    var booted = false, paused = false, isRecord = false, dragging = false;
    var over = false;         // hard guard: api.gameOver() fires exactly once per run

    /* ---------------------------- Geometry ----------------------------- */
    var dpr = 1, cssW = 1, cssH = 1, R = 16, DY = 27, bx = 0, fieldW = 1, fieldTop = 34;
    var btnH = 48, pad = 8, loseRow = 14, shooterY = 100, shooterX = 0;
    var startRows = INITIAL_ROWS;  // resolved in layout(), capped by safeFillRows()
    var swapBtn = { x: 0, y: 0, w: 0, h: 0 }, fireBtn = {}, pauseBtn = {};
    var ROW_GAP = 6;               // guard band between the last row and the shooter
    var MIN_R = 7;                 // below this a bubble stops being readable or tappable
    var START_SLACK = 3;           // empty rows kept between the start pack and the lose line
    /** Highest row whose bubble still clears the shooter area, for the current R/shooterY. */
    function fitRows() {
      return Math.max(0, Math.floor((shooterY - fieldTop - 2 * R - ROW_GAP) / DY));
    }
    /** Deepest pack a fresh fill may occupy: never within START_SLACK of the lose line. */
    function safeFillRows(n) {
      return clamp(n, 1, Math.max(1, loseRow - START_SLACK));
    }
    function layout() {
      var r = wrap.getBoundingClientRect();
      cssW = Math.max(1, Math.round(r.width)); cssH = Math.max(1, Math.round(r.height));
      dpr = clamp(window.devicePixelRatio || 1, 1, 2); // capped: fill-rate win on 3x phones
      canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
      canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Short stages (phones in portrait) give the HUD strip and the thumb bar less room so
      // the playfield keeps a usable number of rows instead of collapsing to the lose line.
      btnH = clamp(cssH * 0.075, 40, 56); pad = 8; fieldTop = clamp(cssH * 0.075, 20, 46);
      R = Math.max(MIN_R, Math.floor((cssW - 12) / (2 * COLS))); DY = R * Math.sqrt(3);
      // Shrink the bubbles until the start pack plus its slack fits between the HUD and the
      // shooter, so the pack never begins life on or near the danger line. MIN_R is a hard
      // floor: below it a bubble is neither readable nor reliably tappable, and once we are
      // at the floor the pack is made shallower instead (see safeFillRows).
      for (var i = 0; i < 10; i++) {
        shooterY = cssH - btnH - pad - R * 1.5; shooterX = cssW / 2;
        if (fitRows() >= INITIAL_ROWS + START_SLACK || R <= MIN_R) break;
        R = Math.max(MIN_R, Math.floor(R * 0.9)); DY = R * Math.sqrt(3);
      }
      // The loop may have shrunk R on its last pass, which leaves shooterY stale for that R.
      // Re-derive it (and the centre) so fitRows() below measures the geometry actually drawn.
      shooterY = cssH - btnH - pad - R * 1.5; shooterX = cssW / 2;
      fieldW = COLS * 2 * R; bx = Math.round((cssW - fieldW) / 2);
      // The lose line is the bottom row the geometry allows, and every fill is capped
      // START_SLACK rows above it: on a very short stage the pack starts shallower rather
      // than on the line, so a couple of non-popping shots can be absorbed before death.
      loseRow = Math.max(3, fitRows());
      startRows = safeFillRows(INITIAL_ROWS);
      var bw = Math.min(96, Math.max(64, cssW * 0.28));
      window.__nbGeom = { cssW: cssW, cssH: cssH, R: R, DY: DY, loseRow: loseRow, startRows: startRows, btnH: btnH, fieldTop: fieldTop, fieldW: fieldW, shooterY: shooterY };
      swapBtn = { x: pad, y: cssH - btnH - pad, w: bw, h: btnH };
      pauseBtn = { x: cssW - pad - bw, y: cssH - btnH - pad, w: bw, h: btnH };
      fireBtn = { x: (cssW - bw) / 2, y: cssH - btnH - pad, w: bw, h: btnH };
    }
    layout(); // fieldTop is the HUD strip reserved above the ceiling
    function token(n, fb) { // site custom property with a hard fallback
      var v = getComputedStyle(document.documentElement).getPropertyValue(n);
      return (v && v.trim()) || fb;
    }
    var C = { bg: token('--bg', '#05060f'), ink: token('--ink', '#f2f5ff'), dim: token('--ink-dim', '#a7b0d0'),
      cyan: token('--cyan', '#22e7ff'), magenta: token('--magenta', '#ff2fb9'), acid: token('--acid', '#c8ff2e'),
      orange: token('--orange', '#ff8a3d'), violet: token('--violet', '#8b5cf6') };
    var PAL = [C.cyan, C.magenta, C.acid, C.orange, C.violet, '#ff4d6d'];
    function hexA(hex, a) { // #rrggbb + alpha -> rgba()
      var h = (hex || '#fff').trim().replace('#', ''), n = parseInt(h, 16);
      return isFinite(n) ? 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')' : 'rgba(255,255,255,' + a + ')';
    }
    /* On-canvas text is sized from the SMALLER stage dimension: on a portrait phone the
       height is the larger one, so scaling off height alone blows the strings up until they
       run off both edges. fitFont() then shrinks a long string further rather than let it clip. */
    var FONT_T = 'Orbitron, system-ui, sans-serif', FONT_B = 'Rajdhani, system-ui, sans-serif';
    function fitFont(size, weight, family, text, maxW) {
      var s = Math.round(size);
      ctx.font = weight + ' ' + s + 'px ' + family;
      while (s > 8 && ctx.measureText(text).width > maxW) {
        s -= 1; ctx.font = weight + ' ' + s + 'px ' + family;
      }
      return s;
    }
    function rr(x, y, w, h, r) {
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
    }
    /* ------------------------- Hex grid helpers ------------------------- */
    function at(c, r) { return (grid[r] && grid[r][c]) || 0; }
    function cellX(c, r) { return bx + (c + (r & 1) * 0.5) * 2 * R; }
    function cellY(r) { return fieldTop + R + r * DY; }
    function neighbours(c, r) { // staggered rows: odd rows are shifted right by half a cell
      return (r & 1)
        ? [[c - 1, r], [c + 1, r], [c, r - 1], [c + 1, r - 1], [c, r + 1], [c + 1, r + 1]]
        : [[c - 1, r], [c + 1, r], [c - 1, r - 1], [c, r - 1], [c - 1, r + 1], [c, r + 1]];
    }
    function paletteSize() { return clamp(3 + level, 3, MAX_COLOURS); }
    function newRow() { // a fresh ceiling row, biased to colours already on the board
      var n = paletteSize(), present = {}, i;
      for (i = 0; i < grid.length; i++) for (var j = 0; j < COLS; j++) if (grid[i][j]) present[grid[i][j]] = 1;
      var keys = []; for (var k in present) if (present.hasOwnProperty(k)) keys.push(+k);
      var row = [], nxt = randInt(0, n - 1);
      for (i = 0; i < COLS; i++) {
        row.push(keys.length && Math.random() < 0.55 ? keys[randInt(0, keys.length - 1)] : nxt);
        if (Math.random() < 0.45) nxt = randInt(0, n - 1);
      }
      return row;
    }
    function fillRows(count) { // cap the ceiling so nothing is orphaned
      for (var r = 0; r < count; r++) grid.unshift(newRow());
    }
    function colourOnBoard() { // never hand out a colour the player cannot match
      var seen = {}, keys = [];
      for (var r = 0; r < grid.length; r++) for (var c = 0; c < COLS; c++) {
        var v = at(c, r); if (v && !seen[v]) { seen[v] = 1; keys.push(v); }
      }
      if (keys.length) return keys[randInt(0, keys.length - 1)];
      return randInt(1, paletteSize());
    }
    function refills() { queue[1] = colourOnBoard(); queue[2] = colourOnBoard(); queue[0] = colourOnBoard(); }
    /* ---------------------------- Run control ---------------------------- */
    function resetRun() {
      grid = []; fallers = []; shot = null;
      angle = -Math.PI / 2; score = 0; level = 0; pops = 0;
      dropIn = BASE_DROP; shake = 0; isRecord = false; over = false;
      paused = !booted; booted = true; dragging = false;
      fillRows(startRows);
      refills();
      setScore(0); if (bestEver !== null) setBest(bestEver);
      live.textContent = 'New run. Score 0.';
    }
    function addScore(n) {
      score += n; setScore(score);
      if (bestEver === null || score > bestEver) {
        bestEver = score; isRecord = true; writeBest(score); setBest(score);
      }
    }
    function die() {
      if (over || destroyed) return;   // api.gameOver() may only fire once per run
      live.textContent = 'Game over. Final score ' + score + '.';
      over = true; paused = false; gameOverCb(score);
    }
    function swapColours() {
      if (over || destroyed) return;
      var t = queue[0]; queue[0] = queue[1]; queue[1] = t; swapAt = performance.now();
    }
    /* ----------------------------- Firing ----------------------------- */
    function fire() {
      if (over || shot || destroyed) return;
      paused = false;
      shot = { x: shooterX, y: shooterY - R * 1.1, vx: Math.cos(angle), vy: Math.sin(angle), colour: queue[0], speed: R * 42 };
      queue.shift(); queue.push(colourOnBoard());
    }
    /** Nearest occupied cell within one bubble of (x,y), or null. */
    function hitCell(x, y) {
      var r0 = Math.max(0, Math.floor((y - fieldTop - R) / DY) - 1), best = null, bestD = 1e9;
      for (var r = r0; r <= r0 + 2; r++) for (var c = 0; c < COLS; c++) {
        if (!at(c, r)) continue;
        var dx = cellX(c, r) - x, dy = cellY(r) - y, d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = { c: c, r: r }; }
      }
      return best && bestD < (2 * R * 0.92) * (2 * R * 0.92) ? best : null;
    }
    /** Snap the in-flight bubble to the free cell nearest where it landed. */
    function landing(x, y, hit) {
      var cands = [], i, p;
      if (!hit) { for (i = 0; i < COLS; i++) cands.push([i, 0]); }
      else cands = neighbours(hit.c, hit.r);
      var free = [];
      for (i = 0; i < cands.length; i++) {
        p = cands[i];
        if (p[0] >= 0 && p[0] < COLS && p[1] >= 0 && !at(p[0], p[1])) free.push(p);
      }
      if (!free.length) { // fully walled in: fall back to any free cell near the impact
        for (var r = 0; r <= grid.length; r++) for (var c = 0; c < COLS; c++) if (!at(c, r)) free.push([c, r]);
      }
      var best = null, bestD = 1e9;
      for (i = 0; i < free.length; i++) {
        var dx = cellX(free[i][0], free[i][1]) - x, dy = cellY(free[i][1]) - y, d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = free[i]; }
      }
      return best;
    }
    function ensureRow(r) { while (grid.length <= r) grid.push(new Array(COLS).fill(0)); }
    function settle(c, r, colour) {
      ensureRow(r); grid[r][c] = colour; shot = null;   // ensureRow pads EMPTY, never random
      var cluster = flood(c, r, colour);
      if (cluster.length >= POP_MIN) {
        for (var i = 0; i < cluster.length; i++) grid[cluster[i][1]][cluster[i][0]] = 0;
        var gain = cluster.length * POP_POINTS;
        if (cluster.length >= 9) gain += CLUSTER_9; else if (cluster.length >= 5) gain += CLUSTER_5;
        var dropped = dropFloating();
        addScore(gain + dropped * DROP_POINTS);
        pops += cluster.length;
        level = Math.floor(pops / POPS_PER_LEVEL);
        dropIn = Math.max(MIN_DROP, BASE_DROP - level * DROP_FALLOFF);
        if (!reduced) shake = Math.min(10, 3 + cluster.length * 0.6);
        flashAt = performance.now();
        live.textContent = 'Popped ' + cluster.length + (dropped ? ', dropped ' + dropped : '') + '. Score ' + score + '.';
        if (gridEmpty()) {                       // field cleared: refill and pay out
          addScore(CLEAR_BONUS); grid = [];
          fillRows(safeFillRows(startRows - level)); refills();
          live.textContent = 'Field cleared! Bonus ' + CLEAR_BONUS + '.';
        }
      }
      if (deepestRow() >= loseRow) die();   // judged on the surviving pack, so a clear never kills
    }
    function gridEmpty() {
      for (var r = 0; r < grid.length; r++) for (var c = 0; c < COLS; c++) if (at(c, r)) return false;
      return true;
    }
    /** Same-colour connected run containing (c,r), 4-connected on the hex lattice. */
    function flood(c, r, colour) {
      var seen = {}, out = [], stack = [[c, r]], key;
      while (stack.length) {
        var p = stack.pop(); key = p[0] + ',' + p[1];
        if (seen[key] || p[0] < 0 || p[0] >= COLS || p[1] < 0 || p[1] >= grid.length) continue;
        if (at(p[0], p[1]) !== colour) continue;
        seen[key] = 1; out.push(p);
        var nb = neighbours(p[0], p[1]);
        for (var i = 0; i < nb.length; i++) stack.push(nb[i]);
      }
      return out;
    }
    /** Anything not reachable from the ceiling falls; returns how many dropped. */
    function dropFloating() {
      var seen = {}, stack = [], i, p, key, n = 0;
      for (var c = 0; c < COLS; c++) if (at(c, 0)) { seen['c,0'] = 1; stack.push([c, 0]); }
      while (stack.length) {
        p = stack.pop(); var nb = neighbours(p[0], p[1]);
        for (i = 0; i < nb.length; i++) {
          key = nb[i][0] + ',' + nb[i][1];
          if (seen[key] || nb[i][0] < 0 || nb[i][0] >= COLS || nb[i][1] < 0 || nb[i][1] >= grid.length) continue;
          if (!at(nb[i][0], nb[i][1])) continue;
          seen[key] = 1; stack.push(nb[i]);
        }
      }
      for (var r = 0; r < grid.length; r++) for (c = 0; c < COLS; c++) {
        if (at(c, r) && !seen[c + ',' + r]) {
          n++;
          if (!reduced) fallers.push({ x: cellX(c, r), y: cellY(r), v: 60, colour: at(c, r) });
          grid[r][c] = 0;
        }
      }
      while (grid.length && !grid[grid.length - 1].some(function (v) { return !!v; })) grid.pop();
      return n;
    }
    function descend() {
      grid.unshift(newRow());
      if (!reduced) shake = 8;
      if (deepestRow() >= loseRow) die();
    }
    function deepestRow() {
      for (var r = grid.length - 1; r >= 0; r--) if (anyAt(r)) return r;
      return -1;
    }
    function anyAt(r) { for (var c = 0; c < COLS; c++) if (at(c, r)) return true; return false; }
    /* ------------------------------ Update ------------------------------ */
    function update(dt, now) {
      if (paused || over) return;
      for (var i = fallers.length - 1; i >= 0; i--) {  // unshot bubbles tumble away
        var f = fallers[i]; f.v += 1500 * dt; f.y += f.v * dt;
        if (f.y > cssH + R) fallers.splice(i, 1);
      }
      if (shot) {
        var s = shot;
        s.x += s.vx * s.speed * dt; s.y += s.vy * s.speed * dt;
        if (s.x < bx + R) { s.x = bx + R; s.vx = Math.abs(s.vx); }        // side walls bounce
        else if (s.x > bx + fieldW - R) { s.x = bx + fieldW - R; s.vx = -Math.abs(s.vx); }
        if (s.y - R <= fieldTop) { var c0 = landing(s.x, fieldTop + R, null);
          if (c0) settle(c0[0], c0[1], s.colour); else shot = null; return; }
        var hit = hitCell(s.x, s.y);
        if (hit) { var cell = landing(s.x, s.y, hit);
          if (cell) settle(cell[0], cell[1], s.colour); else shot = null; return; }
      }
      dropIn -= dt * 1000;
      if (dropIn <= 0) { dropIn = Math.max(MIN_DROP, BASE_DROP - level * DROP_FALLOFF); descend(); }
      if (shake > 0) shake = Math.max(0, shake - dt * 26);
    }
    /* ------------------------------ Render ------------------------------ */
    function drawBubble(x, y, colour, scale, alpha) {
      var col = PAL[(colour - 1) % PAL.length] || C.ink, rr_ = R * scale;
      ctx.save();
      ctx.globalAlpha = alpha;
      var g = ctx.createRadialGradient(x - rr_ * 0.35, y - rr_ * 0.4, rr_ * 0.1, x, y, rr_);
      g.addColorStop(0, hexA(col, 0.95)); g.addColorStop(0.55, hexA(col, 0.62)); g.addColorStop(1, hexA(col, 0.18));
      ctx.fillStyle = g; ctx.shadowColor = hexA(col, 0.9); ctx.shadowBlur = reduced ? 6 : 16;
      ctx.beginPath(); ctx.arc(x, y, rr_, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0; ctx.strokeStyle = hexA(col, 0.95); ctx.lineWidth = Math.max(1, R * 0.08);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,.45)';
      ctx.beginPath(); ctx.arc(x - rr_ * 0.3, y - rr_ * 0.34, rr_ * 0.22, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    function drawButton(b, label, colour, glow) {
      ctx.save();
      rr(b.x, b.y, b.w, b.h, b.h * 0.32);
      ctx.fillStyle = 'rgba(5,6,15,.78)'; ctx.fill();   // dark plate: label contrast on any backdrop
      ctx.fillStyle = hexA(colour, 0.1 + (glow ? 0.18 : 0)); ctx.fill();
      ctx.strokeStyle = hexA(colour, 0.55 + (glow ? 0.4 : 0)); ctx.lineWidth = 1.5;
      ctx.shadowColor = hexA(colour, 0.8); ctx.shadowBlur = glow ? 16 : 8; ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.fillStyle = colour; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '800 ' + fitFont(clamp(Math.min(b.h * 0.3, b.w * 0.18), 11, 15),
        '800', FONT_B, label, b.w - 10) + 'px ' + FONT_B;
      ctx.fillText(label, b.x + b.w / 2, b.y + b.h / 2 + 1);
      ctx.restore();
    }
    /** Dotted preview of the shot, including wall bounces, plus the landing ring. */
    function drawAim() {
      if (over || shot) return;
      var x = shooterX, y = shooterY - R * 1.1, vx = Math.cos(angle), vy = Math.sin(angle), step = R * 0.55;
      var hit = null, cell = null;
      for (var i = 0; i < 90; i++) {
        x += vx * step; y += vy * step;
        if (x < bx + R) { x = bx + R; vx = -vx; } else if (x > bx + fieldW - R) { x = bx + fieldW - R; vx = -vx; }
        if (y - R <= fieldTop) { cell = landing(x, fieldTop + R, null); break; }
        hit = hitCell(x, y);
        if (hit) { cell = landing(x, y, hit); break; }
      }
      if (cell) {
        ctx.save();
        ctx.strokeStyle = hexA(PAL[(queue[0] - 1) % PAL.length] || C.ink, 0.75);
        ctx.lineWidth = 2; ctx.setLineDash([4, 4]);
        ctx.shadowColor = ctx.strokeStyle; ctx.shadowBlur = reduced ? 0 : 12;
        ctx.beginPath(); ctx.arc(cellX(cell[0], cell[1]), cellY(cell[1]), R * 0.86, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      }
    }
    function card(title, sub, colour, hint) {
      ctx.fillStyle = hexA(C.bg, 0.74); ctx.fillRect(0, 0, cssW, cssH);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '900 ' + fitFont(clamp(Math.min(cssH * 0.13, cssW * 0.14), 16, 60),
        '900', FONT_T, title, cssW - 16) + 'px ' + FONT_T;
      ctx.fillStyle = colour; ctx.shadowColor = colour; ctx.shadowBlur = reduced ? 0 : 28;
      ctx.fillText(title, cssW / 2, cssH * 0.4); ctx.shadowBlur = 0;
      var bsz = clamp(Math.min(cssH * 0.045, cssW * 0.05), 10, 21);
      ctx.font = '600 ' + fitFont(bsz, '600', FONT_B, sub, cssW - 16) + 'px ' + FONT_B;
      ctx.fillStyle = C.dim; ctx.fillText(sub, cssW / 2, cssH * 0.49);
      if (hint) {
        ctx.font = '600 ' + fitFont(bsz, '600', FONT_B, hint, cssW - 16) + 'px ' + FONT_B;
        ctx.fillText(hint, cssW / 2, cssH * 0.59);
      }
    }
    function draw(now) {
      var w = cssW, h = cssH;
      ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);
      ctx.save();
      if (shake > 0) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
      // playfield plate, danger band and the losing line
      ctx.fillStyle = 'rgba(255,255,255,.028)';
      ctx.fillRect(bx, fieldTop, fieldW, h - fieldTop);
      var loseY = cellY(loseRow) - R * 0.6;
      ctx.fillStyle = hexA(C.magenta, 0.05);
      ctx.fillRect(bx, loseY, fieldW, h - loseY);
      ctx.save();
      ctx.strokeStyle = hexA(C.magenta, 0.65); ctx.lineWidth = 2; ctx.setLineDash([9, 7]);
      ctx.beginPath(); ctx.moveTo(bx, loseY); ctx.lineTo(bx + fieldW, loseY); ctx.stroke();
      ctx.restore();
      drawAim();
      for (var r = 0; r < grid.length; r++) for (var c = 0; c < COLS; c++)
        if (at(c, r)) drawBubble(cellX(c, r), cellY(r), at(c, r), 1, 1);
      for (var i = 0; i < fallers.length; i++) {
        var f = fallers[i];
        drawBubble(f.x, f.y, f.colour, reduced ? 1 : 1 + clamp(f.v / 900, 0, 0.3), reduced ? 0.6 : clamp(1 - f.v / 1400, 0, 0.9));
      }
      if (shot) drawBubble(shot.x, shot.y, shot.colour, 1, 1);
      // shooter: launcher ring + the current bubble
      var sx = shooterX, sy = shooterY;
      ctx.save();
      ctx.strokeStyle = hexA(C.cyan, 0.5); ctx.lineWidth = Math.max(2, R * 0.18);
      ctx.shadowColor = C.cyan; ctx.shadowBlur = reduced ? 0 : 18;
      ctx.beginPath(); ctx.arc(sx, sy, R * 0.75, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
      drawBubble(sx + Math.cos(angle) * R * 0.4, sy + Math.sin(angle) * R * 0.4, queue[0], 0.92, 1);
      // CRT polish: scanlines + vignette. Applied to the world layer only — the HUD
      // below is drawn after it so the overlays never darken the readouts.
      if (!reduced) {
        ctx.fillStyle = 'rgba(0,0,0,.16)';
        for (var sy2 = 0; sy2 < h; sy2 += 3) ctx.fillRect(0, sy2, w, 1);
      }
      var vig = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.32, w / 2, h / 2, Math.max(w, h) * 0.75);
      vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(0,0,0,.55)');
      ctx.fillStyle = vig; ctx.fillRect(0, 0, w, h);
      // HUD: score left, level centre, best + the next two colours on the right
      var fs = Math.round(clamp(Math.min(cssH * 0.038, cssW * 0.05), 11, 17)), hy = fieldTop * 0.5;
      var nr = Math.max(6, R * 0.42);
      ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      // Dark halo so the readouts stay legible over any board colour.
      ctx.shadowColor = 'rgba(0,0,0,.85)'; ctx.shadowBlur = 6;
      // A six-digit score or best is far wider than the strip it sits in, so both readouts
      // are fitted to the run they have: the left half and the right bubble column.
      var scoreTxt = 'SCORE ' + score, bestTxt = 'BEST ' + (bestEver || 0);
      ctx.font = '700 ' + fitFont(fs, '700', FONT_B, scoreTxt, w * 0.42) + 'px ' + FONT_B;
      ctx.fillStyle = C.ink; ctx.fillText(scoreTxt, pad + 2, hy);
      ctx.textAlign = 'right'; ctx.fillStyle = C.ink;
      ctx.font = '700 ' + fitFont(fs, '700', FONT_B, bestTxt, w * 0.34) + 'px ' + FONT_B;
      ctx.fillText(bestTxt, w - pad - nr * 5, hy);
      drawBubble(w - pad - nr * 2.6, hy, queue[1], (nr / R) * 0.9, 0.8);
      drawBubble(w - pad - nr * 0.7, hy, queue[2], (nr / R) * 0.62, 0.5);
      if (level > 0) {
        ctx.textAlign = 'center'; ctx.fillStyle = now - flashAt < 300 ? C.acid : C.orange;
        ctx.font = '700 ' + fitFont(fs, '700', FONT_B, 'LV ' + level, w * 0.2) + 'px ' + FONT_B;
        ctx.fillText('LV ' + level, w / 2, hy);
      }
      ctx.shadowBlur = 0;
      ctx.restore();
      if (paused && !over) card(booted && pops ? 'PAUSED' : 'READY', booted && pops ? 'Tap or press a key to resume' : 'Drag to aim, release to fire', C.cyan, null);
      if (over) card('GAME OVER', 'SCORE ' + score + (isRecord ? '  ·  NEW BEST' : ''), C.magenta, 'TAP or press SPACE to play again');
      // Thumb bar last, so the overlays never bury the controls
      drawButton(swapBtn, 'SWAP', C.acid, now - swapAt < SWAP_COOLDOWN);
      drawButton(fireBtn, 'FIRE', C.cyan, !shot && !over);
      drawButton(pauseBtn, paused ? 'RESUME' : 'PAUSE', C.violet, paused);
    }
    /* -------------------------- Single rAF loop -------------------------- */
    function frame(now) {
      if (destroyed) return;   // guard: destroy() can land between frames
      var dt = Math.min(0.05, (now - last) / 1000); last = now; // clamp vs backgrounded tabs
      update(dt, now);
      draw(now);
      if (destroyed) return;   // the shell may destroy from inside api.gameOver()
      rafId = requestAnimationFrame(frame);
    }
    var last = performance.now();
    /* ------------------- Input: buttons, pointer, keys ------------------- */
    function inBtn(b, x, y) { return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h; }
    function local(e) {
      var r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }
    function aimAt(x, y) {
      var a = Math.atan2(y - shooterY, x - shooterX);
      angle = clamp(a, AIM_MIN, AIM_MAX); // never aim into the floor
    }
    function resume() { if (!over) paused = false; }
    /** Any tap on a live button: on a dead run the first press restarts instead. */
    function press(b, x, y, act) {
      if (!inBtn(b, x, y)) return false;
      if (over) resetRun(); else { act(); }
      return true;
    }
    function onPointerDown(e) {
      if (e.button !== undefined && e.button !== 0) return;
      if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
      var p = local(e);
      if (press(swapBtn, p.x, p.y, swapColours)) return;
      if (press(fireBtn, p.x, p.y, fire)) return;
      if (press(pauseBtn, p.x, p.y, function () { paused = !paused; })) return;
      if (over) { resetRun(); return; }   // a tap anywhere else restarts a dead run
      resume();
      dragging = true; aimAt(p.x, p.y);
    }
    function onPointerMove(e) { if (dragging) { var p = local(e); aimAt(p.x, p.y); } }
    function onPointerUp() { if (!dragging) return; dragging = false; fire(); } // drag to aim, release to fire
    function onPointerCancel() { dragging = false; }
    function onKeyDown(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var code = e.code, ae = document.activeElement;
      // Only a text field may keep the keyboard to itself.
      if (ae && (/^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) || ae.isContentEditable)) return;
      // A HUD/header control can still hold focus (Tab, or a click the shell has not blurred
      // yet). Hand focus back to the board instead of dropping the game's keys on the floor —
      // Enter is left alone so a focused button can still be activated from the keyboard.
      if (code !== 'Enter' && code !== 'KeyNumpadEnter' &&
          ae && ae !== canvas && ae !== document.body &&
          /^(BUTTON|A|SUMMARY)$/.test(ae.tagName)) {
        try { canvas.focus({ preventScroll: true }); } catch (err) { canvas.focus(); }
      }
      if (code === 'ArrowLeft' || code === 'KeyA' || code === 'ArrowRight' || code === 'KeyD') {
        e.preventDefault(); resume();
        angle = clamp(angle + (code === 'ArrowLeft' || code === 'KeyA' ? -1 : 1) * 0.055, AIM_MIN, AIM_MAX);
        return;
      }
      if (code === 'Space' || code === 'Enter' || code === 'KeyNumpadEnter') {
        var b = document.activeElement;
        if (b && b !== canvas && b !== document.body &&
            /^(BUTTON|INPUT|SELECT|TEXTAREA|A|SUMMARY)$/.test(b.tagName)) return;
        e.preventDefault();
        if (over) resetRun(); else { paused = false; fire(); }
        return;
      }
      if (code === 'ArrowDown' || code === 'KeyS' || code === 'KeyX' || code === 'ShiftLeft') { e.preventDefault(); resume(); swapColours(); return; }
      if (code === 'KeyP' || code === 'Escape') { e.preventDefault(); if (!over) paused = !paused; return; }
    }
    // Re-measure and rebuild the grid. Fires on window resize/orientation change, on
    // entering or leaving fullscreen (which fires no resize), and whenever the stage box
    // itself settles — the first layout() can run before the stage has its final size.
    function onResize() {
      if (destroyed) return;
      var r = wrap.getBoundingClientRect();
      var w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
      if (w === cssW && h === cssH) return;   // unchanged: keep the backing store, break any loop
      layout();
    }
    function onBlur() { if (!destroyed && !over) { paused = true; dragging = false; } }
    function onVisibility() { if (document.hidden) onBlur(); }
    var ro = window.ResizeObserver ? new window.ResizeObserver(onResize) : null;
    if (ro) ro.observe(wrap);
    // Every listener the game owns, in one table so teardown cannot miss one.
    var BIND = [[document, 'keydown', onKeyDown], [canvas, 'pointerdown', onPointerDown],
      [canvas, 'pointermove', onPointerMove], [canvas, 'pointerup', onPointerUp],
      [canvas, 'pointercancel', onPointerCancel], [canvas, 'pointerleave', onPointerCancel],
      [window, 'resize', onResize, { passive: true }], [window, 'orientationchange', onResize],
      [document, 'fullscreenchange', onResize], [document, 'webkitfullscreenchange', onResize],
      [window, 'blur', onBlur], [document, 'visibilitychange', onVisibility]];
    BIND.forEach(function (b) { b[0].addEventListener(b[1], b[2], b[3]); });
    resetRun();
    rafId = requestAnimationFrame(frame);
    return {
      destroy: function () {
        if (destroyed) return;
        destroyed = true; cancelAnimationFrame(rafId);
        if (ro) ro.disconnect();
        BIND.forEach(function (b) { b[0].removeEventListener(b[1], b[2], b[3]); });
        var parent = wrap.parentNode;
        if (parent && typeof parent.removeChild === 'function') parent.removeChild(wrap);
        else if (typeof wrap.remove === 'function') wrap.remove();
      }
    };
  }

  /* ---------------------- Public module contract ---------------------- */
  window.PixelGame = {
    name: 'Neon Bubbles',
    instructions:
      'Drag to aim and release to fire, or use LEFT/RIGHT to aim and SPACE to fire — the bubble ' +
      'bounces off the side walls. Match 3 or more connected bubbles of one colour to pop them; ' +
      'anything left hanging falls for a bonus. S or X swaps to the next colour, P pauses. The pack ' +
      'drops a row every few seconds, so play faster than it falls — clear the field for a big bonus.',
    start: start
  };
})();
