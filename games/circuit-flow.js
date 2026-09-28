/**
 * PIXEL RUSH — games/circuit-flow.js — "Circuit Flow"
 * Contract (GAME-CONTRACT.md): window.PixelGame = { name, instructions, start(root, api) }
 * where api = { setScore(n), setBest(n), gameOver(score) } and start() returns { destroy() }.
 * Self-contained: no imports, no dependencies, no assets — one <canvas> + 2D ctx; every rAF id
 * and listener created in start() is torn down in destroy().
 */
(function () {
  'use strict';
  /* -------------------------------- Tuning -------------------------------- */
  var STORE_KEY = 'pixelrush.circuit-flow.best';
  var TOTAL_LEVELS = 8;            // the run ends after this many boards
  /* The clock is budgeted per open node, not per level index. Every tile costs the same one or
     two turns whatever the grid size, so a flat per-level budget starves the 8x8 boards: level 8
     asks for 70+ rotations and a fixed 22s makes it unreachable by a human no matter how well it
     is generated. Keeping the per-node budget and tightening it slightly each level preserves the
     intended pressure curve while still letting the late boards be played. */
  var TIME_PER_NODE = 2, TIME_NODE_FALLOFF = 0.09, TIME_MIN = 16;   // seconds per open node, per level
  var TURN_POINTS = 2;             // per rotation
  var LIT_POINTS = 12;             // per node newly brought to life
  var CLEAR_POINTS = 150;          // x level, on completion
  var TIME_POINTS = 20;            // x whole seconds left on the clock
  var BLOCK_CAP = 0.16;            // most of the board that ever goes void
  var SPIN_MS = 120, PULSE_MS = 900, FLICK = 22;  // spin ease, pulse travel, swipe px
  var U = [-1, 0, 1, 0], R = [0, 1, 0, -1];       // dir 0=N 1=E 2=S 3=W
  var DIRS = { up: 0, right: 1, down: 2, left: 3 };
  var FOOTER = ['TAP A TILE TO ROTATE', 'SWIPE OR ARROWS TO AIM', 'SPACE ROTATES'];
  var KEYS = { ArrowUp: 'up', KeyW: 'up', ArrowRight: 'right', KeyD: 'right',
    ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left' };
  var STYLES = '.cf{position:relative;width:100%;height:100%;overflow:hidden;touch-action:none;' +
    'user-select:none;-webkit-tap-highlight-color:transparent;' +
    'font-family:var(--font-body,"Rajdhani",system-ui,sans-serif);color:var(--ink,#f2f5ff)}' +
    '.cf canvas{display:block;width:100%;height:100%;outline:none}';
  var TAU = Math.PI * 2;
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function randInt(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
  function rotM(m, k) { k &= 3; return ((m << k) | (m >> (4 - k))) & 15; } // turn a pipe mask
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
    var setStatus  = typeof api.setStatus === 'function'  ? api.setStatus  : function () {};
    /* -------------------------------- DOM -------------------------------- */
    var wrap = document.createElement('div'); wrap.className = 'cf';
    var canvas = document.createElement('canvas');
    canvas.setAttribute('tabindex', '0'); canvas.setAttribute('role', 'application');
    canvas.setAttribute('aria-label', 'Circuit Flow board. Arrow keys move the selector, space rotates. ' +
      'On touch, tap a tile to rotate and swipe to move the selector.');
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
    /* ------------------------------ State ------------------------------ */
    var grid = [], cols = 4, rows = 4, core = { x: 0, y: 0 };
    var level = 1, score = 0, bestEver = readBest(), isRecord = false;
    var litCount = 0, openCount = 1, timeLeft = 0, timeMax = 1, clearBonus = 0;
    var selX = 0, selY = 0, over = false, overReason = '';
    var state = 'intro';        // intro | play | paused | clear | over
    var stateT = 0;             // ms spent in the current state
    var dpr = 1, cssW = 1, cssH = 1, cell = 24, bx = 0, by = 0, bw = 0, bh = 0, last = 0;
    var statusPrimed = false;   // re-assert our own state once, on the first drawn frame
    /* One clock for the whole game. Lit-stamps and the frame timestamp must come from the
       same source: a rAF timestamp is the frame's start, so stamping with performance.now()
       inside an input handler can put `age` a few ms in the future and drive radii negative. */
    var clock = performance.now();
    /* ----------------- Sizing (crisp devicePixelRatio) ----------------- */
    function resize() {
      var r = wrap.getBoundingClientRect();
      cssW = Math.max(1, Math.round(r.width)); cssH = Math.max(1, Math.round(r.height));
      dpr = clamp(window.devicePixelRatio || 1, 1, 2); // cap DPR: fill-rate win on 3x phones
      canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
      canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // The board is square, so it letterboxes into whatever aspect ratio the stage has.
      cell = Math.max(8, Math.floor(Math.min(cssW * 0.94, cssH * 0.62) / Math.max(cols, rows)));
      bw = cell * cols; bh = cell * rows;
      bx = Math.round((cssW - bw) / 2);
      by = Math.round(Math.max(cssH * 0.20, (cssH - bh) * 0.5));
    }
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
    /* --------------------------- Level building --------------------------- */
    function tile(x, y) { return grid[y] ? grid[y][x] : null; }
    /** Flood power out from the core through reciprocal joins. Returns the number of live nodes. */
    function recompute() {
      var y, x, t, i, d, nx, ny, nb;
      for (y = 0; y < rows; y++) for (x = 0; x < cols; x++) {
        t = grid[y][x]; t.powered = false; t.depth = 0; t.litT = -1e9;
      }
      var q = [], c0 = grid[core.y][core.x];
      c0.powered = true; c0.depth = 0; q.push(c0);
      for (i = 0; i < q.length; i++) {
        t = q[i];
        for (d = 0; d < 4; d++) {
          if (!(t.mask & (1 << d))) continue;
          nx = t.x + R[d]; ny = t.y + U[d];
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          nb = grid[ny][nx];
          if (nb.blocked || nb.powered || !(nb.mask & (1 << ((d + 2) & 3)))) continue;
          nb.powered = true; nb.depth = t.depth + 1; q.push(nb);
        }
      }
      for (i = 0; i < q.length; i++) if (q[i].litT < -1e8) q[i].litT = clock;
      return q.length;
    }
    function spin(t) { t.rot = (t.rot + 1) & 3; t.mask = rotM(t.base, t.rot); t.angT = t.rot * Math.PI / 2; }
    /**
     * Build one board: punch out void cells, grow a random spanning tree from the core over
     * everything left, add decoy spurs, then scatter the nodes and seal a few in place.
     */
    function buildLevel(n) {
      var i, d, nx, ny, nb, cur, j, k, l, f, g, g2, g3, g4, free, tries, s2;
      var s = Math.min(8, 3 + n);
      cols = s; rows = s; grid = [];
      for (var y = 0; y < rows; y++) { grid[y] = []; for (var x = 0; x < cols; x++)
        grid[y][x] = { x: x, y: y, base: 0, mask: 0, rot: 0, ang: 0, angT: 0,
          locked: false, blocked: false, powered: false, depth: 0, litT: -1e9 }; }
      var voidTarget = n < 2 ? 0 : Math.round(cols * rows * Math.min(BLOCK_CAP, (n - 2) * 0.035));
      for (k = 0; k < voidTarget; k++) grid[randInt(0, rows - 1)][randInt(0, cols - 1)].blocked = true;
      var start = null;
      for (k = 0; k < cols * rows && !start; k++) { g = grid[randInt(0, rows - 1)][randInt(0, cols - 1)];
        if (!g.blocked) start = g; }
      if (!start) { start = grid[0][0]; start.blocked = false; }
      core = { x: start.x, y: start.y };
      // Randomised DFS: a spanning tree over the reachable open cells, core at the root.
      var seen = {}, stack = [start], order;
      seen[start.x + ',' + start.y] = 1;
      while (stack.length) {
        cur = stack[stack.length - 1]; var moved = false;
        order = [0, 1, 2, 3];
        for (i = 3; i > 0; i--) { j = randInt(0, i); s2 = order[i]; order[i] = order[j]; order[j] = s2; }
        for (d = 0; d < 4; d++) {
          nx = cur.x + R[order[d]]; ny = cur.y + U[order[d]];
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          nb = grid[ny][nx];
          if (nb.blocked || seen[nb.x + ',' + nb.y]) continue;
          seen[nb.x + ',' + nb.y] = 1;
          cur.base |= 1 << order[d]; nb.base |= 1 << ((order[d] + 2) & 3);
          stack.push(nb); moved = true; break;
        }
        if (!moved) stack.pop();
      }
      // Anything the tree could not reach is unreachable anyway — void it out.
      openCount = 0;
      for (y = 0; y < rows; y++) for (x = 0; x < cols; x++) {
        g = grid[y][x];
        if (!g.blocked && !seen[x + ',' + y]) g.blocked = true;
        if (!g.blocked) openCount++;
      }
      // Decoys: a spur arm leading into a void cell or off-grid. It never carries power.
      var decoys = n < 3 ? 0 : Math.min(5, n - 2);
      for (k = 0; k < decoys; k++) {
        g2 = grid[randInt(0, rows - 1)][randInt(0, cols - 1)];
        if (g2.blocked) continue;
        free = -1;
        for (d = 0; d < 4; d++) if (!(g2.base & (1 << d))) { free = d; break; }
        if (free < 0) continue;
        g2.base |= 1 << free;
      }
      // Scatter every node, then seal a few (from level 4) straight into place.
      for (y = 0; y < rows; y++) for (x = 0; x < cols; x++) {
        g = grid[y][x];
        if (g.blocked) continue;
        g.rot = randInt(0, 3); g.mask = rotM(g.base, g.rot);
        g.ang = g.angT = g.rot * Math.PI / 2 - randInt(0, 3) * TAU; // same facing, different spin-in
      }
      var locks = n < 4 ? 0 : Math.min(4, n - 3);
      for (l = 0; l < locks; l++) {
        g3 = null; tries = 0;
        while (tries++ < 40) { g = grid[randInt(0, rows - 1)][randInt(0, cols - 1)];
          if (!g.blocked && !g.locked && !(g.x === core.x && g.y === core.y)) { g3 = g; break; } }
        if (!g3) break;
        g3.locked = true; g3.rot = 0; g3.mask = g3.base; g3.ang = g3.angT = 0;
      }
      // A board that spawned already solved would waste the player's time.
      if (recompute() >= openCount) for (f = 0; f < 3; f++) {
        g4 = grid[randInt(0, rows - 1)][randInt(0, cols - 1)];
        if (!g4.blocked && !g4.locked) spin(g4);
      }
      selX = core.x; selY = core.y;
      timeMax = Math.max(TIME_MIN, Math.round(openCount * (TIME_PER_NODE - (n - 1) * TIME_NODE_FALLOFF)));
      timeLeft = timeMax;
      litCount = recompute();
    }
    /* ----------------------------- Run flow ----------------------------- */
    function addScore(n) {
      score += n; setScore(score);
      if (bestEver === null || score > bestEver) { bestEver = score; isRecord = true; writeBest(score); setBest(score); }
    }
    function enterLevel(n) {
      level = n; buildLevel(n);
      // buildLevel() resizes the board (4x4 -> 8x8), so the layout has to be refitted here: cell
      // size, board origin and the clock bar are all derived from cols/rows, and the pointer
      // hit-test reads back the same bx/by/cell. Without this the new, larger grid is drawn and
      // hit-tested with the previous level's geometry and the outer rows/columns fall off-stage,
      // where they can be neither seen nor tapped.
      resize();
      state = n === 1 ? 'intro' : 'play'; stateT = 0;
      setStatus(state === 'intro' ? 'Ready' : 'Playing');
      live.textContent = 'Level ' + n + ' of ' + TOTAL_LEVELS + '. ' + litCount + ' of ' + openCount + ' nodes powered.';
    }
    function begin() {
      if (over) { resetRun(); return; }
      if (state === 'intro') { state = 'play'; stateT = 0; setStatus('Playing'); }
    }
    function resume() { if (state === 'paused') { state = 'play'; stateT = 0; setStatus('Playing'); } }
    function pause() {
      if (state !== 'play') { resume(); return; }
      state = 'paused'; stateT = 0; setStatus('Paused');
    }
    function resetRun() {
      score = 0; isRecord = false; over = false; overReason = ''; clearBonus = 0; setScore(0);
      if (bestEver !== null) setBest(bestEver);
      enterLevel(1);
    }
    function endRun(reason) {
      if (over || destroyed) return;   // api.gameOver() may only fire once per run
      over = true; overReason = reason; state = 'over'; stateT = 0;
      setStatus('Game over');
      live.textContent = reason + '. Final score ' + score + '.';
      gameOverCb(score);
    }
    /** Rotate one node. Locked targets are a wrong tap and blow the run. */
    function tapCell(x, y) {
      if (state === 'intro') { begin(); return; }
      if (state === 'over') { resetRun(); return; }
      if (state === 'paused') { resume(); return; }
      if (state !== 'play') return;
      selX = x; selY = y;
      var t = tile(x, y);
      if (!t || t.blocked) return;                    // void cells simply ignore input
      if (t.locked) { endRun('SHORT CIRCUIT — you turned a locked node'); return; }
      var was = litCount;
      spin(t);
      litCount = recompute();
      addScore(TURN_POINTS + Math.max(0, litCount - was) * LIT_POINTS);
      live.textContent = 'Selector at column ' + (selX + 1) + ', row ' + (selY + 1) + '. ' +
        litCount + ' of ' + openCount + ' nodes powered. Score ' + score + '.';
      if (litCount >= openCount) {
        clearBonus = CLEAR_POINTS * level + Math.max(0, Math.ceil(timeLeft)) * TIME_POINTS;
        addScore(clearBonus); state = 'clear'; stateT = 0;
        setStatus('Level clear');
        live.textContent = 'Level ' + level + ' complete, bonus ' + clearBonus + '.';
      }
    }
    /** Walk the selector one cell in direction index d (0=N 1=E 2=S 3=W). */
    function moveSel(d) {
      if (state === 'intro') { begin(); return; }
      if (state === 'over') { resetRun(); return; }
      if (state === 'paused') { resume(); return; }
      if (state !== 'play') return;
      selX = clamp(selX + R[d], 0, cols - 1); selY = clamp(selY + U[d], 0, rows - 1);
      live.textContent = 'Selector at column ' + (selX + 1) + ', row ' + (selY + 1) + '.';
    }
    /* ------------------------------ Drawing ------------------------------ */
    /**
     * Largest font size for `text` that stays inside wBudget and under hBudget. A portrait stage
     * is TALLER than it is wide, so a size derived from height alone balloons and runs off both
     * edges — the width budget is the cap, and the real font is re-measured as the size steps down.
     */
    function fitSize(text, weight, family, hBudget, wBudget, floor, capPx) {
      var s = Math.round(clamp(Math.min(hBudget, wBudget / 5), floor, capPx));
      ctx.font = weight + ' ' + s + 'px ' + family + ', system-ui, sans-serif';
      while (s > floor && ctx.measureText(text).width > wBudget) {
        s -= 1;
        ctx.font = weight + ' ' + s + 'px ' + family + ', system-ui, sans-serif';
      }
      return s;
    }
    function card(title, sub, color, hint) {
      ctx.fillStyle = hexA(C.bg, 0.74); ctx.fillRect(0, 0, cssW, cssH);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '900 ' + fitSize(title, 900, 'Orbitron', cssH * 0.11, cssW - 24, 16, 54) +
        'px Orbitron, system-ui, sans-serif';
      ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 28;
      ctx.fillText(title, cssW / 2, cssH * 0.40); ctx.shadowBlur = 0;
      /* A status line that is still too long at the smallest legible size is broken at its ' · '
         separators onto two rows instead of being shrunk into unreadable type; the title and the
         hint sit at fixed fractions so no row can land on another. */
      var parts = sub.split('  ·  '), i, sy2;
      if (parts.length > 2) { parts = [parts[0], parts.slice(1).join('  ·  ')]; } // reason, then score
      for (i = 0; i < parts.length && i < 2; i++) {
        ctx.font = '600 ' + fitSize(parts[i], 600, 'Rajdhani', cssH * 0.045, cssW - 20, 10, 20) +
          'px Rajdhani, system-ui, sans-serif';
        ctx.fillStyle = C.dim;
        sy2 = parts.length > 1 ? (i === 0 ? cssH * 0.49 : cssH * 0.57) : cssH * 0.49;
        ctx.fillText(parts[i], cssW / 2, sy2);
      }
      if (hint) {
        ctx.font = '600 ' + fitSize(hint, 600, 'Rajdhani', cssH * 0.042, cssW - 20, 10, 18) +
          'px Rajdhani, system-ui, sans-serif';
        ctx.fillText(hint, cssW / 2, cssH * (parts.length > 1 ? 0.67 : 0.60));
      }
    }
    function drawTile(t, now, dt) {
      var d, cx, cy, ex, ey, nx, ny, nb, age = Math.max(0, now - t.litT);
      var live = t.powered, col = live ? C.cyan : C.violet;
      if (t.blocked) { // void slab: dead, hatched
        cx = bx + t.x * cell; cy = by + t.y * cell;
        ctx.save();
        rr(cx + 2, cy + 2, cell - 4, cell - 4, cell * 0.18);
        ctx.fillStyle = 'rgba(255,255,255,.02)'; ctx.fill();
        ctx.strokeStyle = hexA(C.magenta, 0.16); ctx.lineWidth = 1; ctx.stroke();
        ctx.beginPath(); ctx.moveTo(cx + cell * 0.3, cy + cell * 0.3);
        ctx.lineTo(cx + cell * 0.7, cy + cell * 0.7); ctx.stroke();
        ctx.restore(); return;
      }
      cx = bx + (t.x + 0.5) * cell; cy = by + (t.y + 0.5) * cell;
      ctx.save();                                  // socket plate
      rr(bx + t.x * cell + 2, by + t.y * cell + 2, cell - 4, cell - 4, cell * 0.2);
      ctx.fillStyle = live ? hexA(C.cyan, 0.07) : 'rgba(255,255,255,.025)'; ctx.fill();
      ctx.strokeStyle = live ? hexA(C.cyan, 0.45) : hexA(C.dim, 0.13); ctx.lineWidth = 1; ctx.stroke();
      ctx.restore();
      var delta = (((t.angT - t.ang) % TAU) + TAU + Math.PI) % TAU - Math.PI;  // ease toward its facing
      t.ang += delta * Math.min(1, dt / SPIN_MS);
      ctx.save();
      ctx.translate(cx, cy); ctx.rotate(t.ang); ctx.lineCap = 'round';
      for (d = 0; d < 4; d++) {
        if (!(t.mask & (1 << d))) continue;
        ex = R[d] * cell * 0.5; ey = U[d] * cell * 0.5;
        ctx.strokeStyle = live ? col : hexA(C.violet, 0.5);
        ctx.lineWidth = Math.max(2, cell * 0.17);
        ctx.shadowColor = col; ctx.shadowBlur = live ? (reduced ? 8 : 16) : 0;
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(ex, ey); ctx.stroke();
      }
      ctx.shadowBlur = live ? (reduced ? 6 : 14) : 0;
      ctx.fillStyle = live ? col : hexA(C.violet, 0.75);
      ctx.beginPath(); ctx.arc(0, 0, Math.max(2, cell * 0.13), 0, TAU); ctx.fill();
      ctx.restore();
      if (live && !reduced && age < 420) {          // arrival flare on a freshly lit node
        var f = 1 - age / 420, r2 = cell * (0.2 + 0.5 * (1 - f));
        var gr = ctx.createRadialGradient(cx, cy, 0, cx, cy, r2);
        gr.addColorStop(0, hexA(C.acid, 0.5 * f)); gr.addColorStop(1, hexA(C.acid, 0));
        ctx.fillStyle = gr; ctx.fillRect(cx - r2, cy - r2, r2 * 2, r2 * 2);
      }
      if (live && !reduced) {                      // charge crawling outward, staggered by depth
        var ph = ((now / PULSE_MS) + t.depth * 0.11) % 1;
        for (d = 0; d < 4; d++) {
          if (!(t.mask & (1 << d))) continue;
          nx = t.x + R[d]; ny = t.y + U[d];
          nb = (nx >= 0 && ny >= 0 && nx < cols && ny < rows) ? grid[ny][nx] : null;
          if (!nb || !nb.powered || !(nb.mask & (1 << ((d + 2) & 3)))) continue;
          ctx.save(); ctx.shadowColor = C.acid; ctx.shadowBlur = 12; ctx.fillStyle = C.acid;
          ctx.beginPath();
          ctx.arc(cx + R[d] * cell * 0.5 * ph, cy + U[d] * cell * 0.5 * ph, Math.max(1.5, cell * 0.07), 0, TAU);
          ctx.fill(); ctx.restore();
        }
      }
      if (t.locked) {                              // sealed node: brass ring, cannot be turned
        ctx.save();
        ctx.strokeStyle = hexA(C.orange, 0.75); ctx.lineWidth = 2; ctx.shadowColor = C.orange;
        ctx.shadowBlur = reduced ? 4 : 10;
        ctx.beginPath(); ctx.arc(cx, cy, cell * 0.38, 0, TAU); ctx.stroke();
        ctx.shadowBlur = 0; ctx.fillStyle = C.orange;
        ctx.fillRect(cx - cell * 0.13, cy - cell * 0.03, cell * 0.26, cell * 0.07);
        ctx.strokeRect(cx - cell * 0.09, cy - cell * 0.12, cell * 0.18, cell * 0.15);
        ctx.restore();
      }
    }
    function draw(now, dt) {
      var x, y, i, g, fs, top, barW, barX, barY, frac, st, sc, pu, cx, cy, beat, gr, vig, sy;
      var hudL, hudC, hudR, hxL, hxR, avail, gap, total, ffs, widest, oneLine, hudFs;
      ctx.fillStyle = C.bg; ctx.fillRect(0, 0, cssW, cssH);
      ctx.save();
      rr(bx, by, bw, bh, Math.min(16, cell * 0.6));
      ctx.fillStyle = 'rgba(255,255,255,.02)'; ctx.fill();
      ctx.strokeStyle = hexA(C.cyan, 0.1); ctx.lineWidth = 1; ctx.beginPath();
      for (x = 1; x < cols; x++) { ctx.moveTo(bx + x * cell, by); ctx.lineTo(bx + x * cell, by + bh); }
      for (y = 1; y < rows; y++) { ctx.moveTo(bx, by + y * cell); ctx.lineTo(bx + bw, by + y * cell); }
      ctx.stroke(); ctx.restore();
      for (y = 0; y < rows; y++) for (x = 0; x < cols; x++) drawTile(grid[y][x], now, dt);
      // Core: the source. Always live, always breathing.
      cx = bx + (core.x + 0.5) * cell; cy = by + (core.y + 0.5) * cell;
      beat = reduced ? 1 : 0.9 + 0.1 * Math.sin(now / 260);
      ctx.save();
      gr = ctx.createRadialGradient(cx, cy, 0, cx, cy, cell * 0.8);
      gr.addColorStop(0, hexA(C.magenta, 0.5 * beat)); gr.addColorStop(1, hexA(C.magenta, 0));
      ctx.fillStyle = gr; ctx.fillRect(cx - cell, cy - cell, cell * 2, cell * 2);
      ctx.shadowColor = C.magenta; ctx.shadowBlur = reduced ? 12 : 26; ctx.fillStyle = C.magenta;
      ctx.beginPath(); ctx.arc(cx, cy, cell * 0.19 * beat, 0, TAU); ctx.fill();
      ctx.shadowBlur = 0; ctx.strokeStyle = hexA(C.ink, 0.5); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(cx, cy, cell * 0.3, 0, TAU); ctx.stroke();
      if (!reduced) { ctx.strokeStyle = hexA(C.magenta, 0.32);
        ctx.beginPath(); ctx.arc(cx, cy, cell * (0.36 + 0.12 * beat), 0, TAU); ctx.stroke(); }
      ctx.restore();
      if (state !== 'over' && state !== 'clear') {            // selector
        st = tile(selX, selY); sc = st && st.locked ? C.orange : C.acid;
        pu = reduced ? 1 : 0.55 + 0.25 * Math.sin(now / 300);
        ctx.save();
        ctx.strokeStyle = hexA(sc, pu); ctx.lineWidth = 2; ctx.shadowColor = sc;
        ctx.shadowBlur = reduced ? 4 : 12;
        rr(bx + selX * cell + 2, by + selY * cell + 2, cell - 4, cell - 4, cell * 0.2);
        ctx.stroke(); ctx.restore();
      }
      /* CRT polish: scanlines + vignette over the WORLD only — the HUD is painted
         after this so it is never darkened into illegibility. */
      if (!reduced) { ctx.fillStyle = 'rgba(0,0,0,.15)';
        for (sy = 0; sy < cssH; sy += 3) ctx.fillRect(0, sy, cssW, 1); }
      vig = ctx.createRadialGradient(cssW / 2, cssH / 2, Math.min(cssW, cssH) * 0.35,
        cssW / 2, cssH / 2, Math.max(cssW, cssH) * 0.75);
      vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(0,0,0,.55)');
      ctx.fillStyle = vig; ctx.fillRect(0, 0, cssW, cssH);
      /* HUD (above the CRT): score / level / best, the clock bar and the footer.
         A soft dark shadow keeps every glyph legible over the vignette. */
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,.95)'; ctx.shadowBlur = 5; ctx.shadowOffsetY = 1;
      fs = Math.round(clamp(Math.min(cssH * 0.042, cssW * 0.048), 11, 17));
      top = Math.max(14, by * 0.44);
      // Fit the three HUD cells instead of trusting fixed anchors: the row is budgeted against
      // the full stage width, and the type is stepped down one pixel at a time, re-measured with
      // the real font at each size, so the cells can never overprint however big the numbers get.
      hudL = 'SCORE ' + score;
      hudC = 'L' + level + ' ' + litCount + '/' + openCount;   // level, then nodes powered
      hudR = 'BEST ' + (bestEver || 0);
      hxL = 10; hxR = cssW - 10; avail = hxR - hxL; gap = 10;
      for (hudFs = fs; hudFs >= 9; hudFs--) {
        ctx.font = '700 ' + hudFs + 'px Rajdhani, system-ui, sans-serif';
        total = ctx.measureText(hudL).width + ctx.measureText(hudC).width +
          ctx.measureText(hudR).width;
        if (total + gap * 2 <= avail) break;
      }
      if (total + gap * 2 > avail) {          // still tight: the node count matters more than the level
        hudC = litCount + '/' + openCount;
        for (hudFs = fs; hudFs >= 9; hudFs--) {
          ctx.font = '700 ' + hudFs + 'px Rajdhani, system-ui, sans-serif';
          total = ctx.measureText(hudL).width + ctx.measureText(hudC).width +
            ctx.measureText(hudR).width;
          if (total + gap * 2 <= avail) break;
        }
      }
      fs = hudFs;
      ctx.font = '700 ' + fs + 'px Rajdhani, system-ui, sans-serif'; ctx.textBaseline = 'middle';
      ctx.textAlign = 'left'; ctx.fillStyle = C.ink; ctx.fillText(hudL, hxL, top);
      ctx.textAlign = 'center'; ctx.fillStyle = C.cyan; ctx.fillText(hudC, cssW / 2, top);
      ctx.textAlign = 'right'; ctx.fillStyle = C.ink; ctx.fillText(hudR, hxR, top);
      barW = Math.min(cssW * 0.7, bw); barX = (cssW - barW) / 2; barY = top + fs;
      frac = clamp(timeLeft / timeMax, 0, 1);
      rr(barX, barY, barW, 5, 2.5); ctx.fillStyle = 'rgba(5,6,15,.85)'; ctx.fill();
      rr(barX, barY, Math.max(2, barW * frac), 5, 2.5);
      ctx.fillStyle = frac > 0.35 ? C.acid : C.magenta; ctx.fill();
      ctx.textAlign = 'center'; ctx.font = '600 ' + Math.round(fs * 0.85) + 'px Rajdhani, system-ui, sans-serif';
      ctx.fillStyle = C.dim; ctx.fillText(Math.ceil(Math.max(0, timeLeft)) + 's', cssW / 2, barY + 15);
      // Footer, so the phone player knows both control schemes exist. Kept as segments so a
      // narrow stage wraps it instead of clipping the first and last words off both edges.
      ctx.textAlign = 'center'; ctx.fillStyle = C.dim;
      ffs = Math.round(clamp(Math.min(cssH * 0.031, cssW * 0.04), 9, 14));
      ctx.font = '600 ' + ffs + 'px Rajdhani, system-ui, sans-serif';
      widest = 0;
      for (i = 0; i < FOOTER.length; i++)
        widest = Math.max(widest, ctx.measureText(FOOTER[i]).width);
      if (widest > cssW - 16) ffs = Math.max(8, Math.floor(ffs * (cssW - 16) / widest));
      ctx.font = '600 ' + ffs + 'px Rajdhani, system-ui, sans-serif';
      oneLine = FOOTER.join('  ·  ');
      if (ctx.measureText(oneLine).width <= cssW - 12) ctx.fillText(oneLine, cssW / 2, cssH - 13);
      else for (i = 0; i < FOOTER.length; i++)
        ctx.fillText(FOOTER[i], cssW / 2, cssH - 13 - (FOOTER.length - 1 - i) * (ffs + 3));
      ctx.restore();
      /* Overlays */
      if (state === 'intro') card('CIRCUIT FLOW', 'Power the whole grid from the core', C.cyan,
        'TAP a tile or press SPACE to begin');
      else if (state === 'paused') card('PAUSED', litCount + ' of ' + openCount + ' nodes powered', C.cyan,
        'TAP or press SPACE to resume');
      else if (state === 'clear') card('NODE ' + level + ' ONLINE', 'bonus +' + clearBonus, C.acid,
        level >= TOTAL_LEVELS ? '' : 'next board incoming…');
      else if (state === 'over') card('RUN DEAD', overReason + '  ·  SCORE ' + score
        + (isRecord ? '  ·  NEW BEST' : ''), C.magenta, 'TAP or press SPACE to play again');
    }
    /* -------------------------- Single rAF loop -------------------------- */
    function frame(now) {
      if (destroyed) return;   // guard: destroy() can land between frames
      // The shell stamps its own 'Playing' onto the HUD as soon as start() resolves, which would
      // leave STATUS lying while the title card is still up. A rAF callback always runs after that
      // promise job, so re-asserting here is deterministic — and only ever happens once.
      if (!statusPrimed) { statusPrimed = true; setStatus(state === 'intro' ? 'Ready' : 'Playing'); }
      if (!last) last = now;
      var dt = Math.min(120, now - last); last = now;
      if (state === 'play' || state === 'clear') stateT += dt;
      if (state === 'play') {
        // The clock is the fail state the how-to promises: at 0s the run ends, it does not
        // keep running with a dead timer.
        if (timeLeft > 0) timeLeft = Math.max(0, timeLeft - dt / 1000);
        else { endRun('OUT OF TIME — the grid went dark'); if (destroyed) return; }
      }
      if (state === 'clear' && stateT > 1500) {
        if (level >= TOTAL_LEVELS) endRun('ALL ' + TOTAL_LEVELS + ' NODES BROUGHT ONLINE');
        else enterLevel(level + 1);
      }
      draw(now, dt);
      if (destroyed) return;   // the shell may tear us down from inside api.gameOver()
      rafId = requestAnimationFrame(frame);
    }
    /* ------------------- Input: keyboard + tap + swipe ------------------- */
    function onKeyDown(e) {
      if (destroyed || e.metaKey || e.ctrlKey || e.altKey) return;
      var a = document.activeElement;
      if (e.code === 'Space' || e.code === 'Enter' || e.key === ' ') {
        if (a && a !== canvas && /^(BUTTON|INPUT|SELECT|TEXTAREA|A|SUMMARY)$/.test(a.tagName)) return;
        e.preventDefault();
        if (over) resetRun();
        else if (state === 'clear') stateT = 1e9;   // skip the beat between boards
        else if (state === 'paused') resume();
        else if (state === 'intro') begin();
        else tapCell(selX, selY);
        return;
      }
      if (e.code === 'KeyP' || e.code === 'Escape') {
        e.preventDefault();
        if (state === 'play') pause(); else resume();
        return;
      }
      var d = KEYS[e.code] || KEYS[e.key];
      if (d !== undefined) { e.preventDefault(); moveSel(DIRS[d]); }
    }
    var sx = 0, sy = 0, swiping = false;
    function onPointerDown(e) {
      if (destroyed || (e.button !== undefined && e.button !== 0)) return;
      sx = e.clientX; sy = e.clientY; swiping = true;
      if (over) { resetRun(); swiping = false; return; }
      if (state === 'clear') stateT = 1e9;          // tap through the between-board beat
      if (state === 'intro') begin(); else resume();
      if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
    }
    function onPointerUp(e) {
      if (destroyed || !swiping) return;
      swiping = false;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) >= FLICK || Math.abs(dy) >= FLICK) {   // swipe: walk the selector
        moveSel(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0));
        return;
      }
      var r = canvas.getBoundingClientRect();
      var gx = Math.floor((e.clientX - r.left - bx) / cell), gy = Math.floor((e.clientY - r.top - by) / cell);
      if (gx < 0 || gy < 0 || gx >= cols || gy >= rows) return;   // HUD taps do nothing
      tapCell(gx, gy);
    }
    function onPointerCancel() { swiping = false; }
    function onResize() { if (!destroyed) resize(); }
    function onBlur() { if (!destroyed && state === 'play') pause(); }
    function onVisibility() { if (document.hidden) onBlur(); }
    // Every listener the game owns, in one table so teardown cannot miss one.
    var BIND = [[document, 'keydown', onKeyDown], [canvas, 'pointerdown', onPointerDown],
      [canvas, 'pointerup', onPointerUp], [canvas, 'pointercancel', onPointerCancel],
      [window, 'resize', onResize, { passive: true }], [window, 'orientationchange', onResize],
      [window, 'blur', onBlur], [document, 'visibilitychange', onVisibility]];
    BIND.forEach(function (b) { b[0].addEventListener(b[1], b[2], b[3]); });
    if (bestEver !== null) setBest(bestEver);
    enterLevel(1);   // the board exists before the first frame, so nothing is undefined on frame 1
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
    name: 'Circuit Flow',
    instructions:
      'Rotate every pipe tile until the whole grid is lit from the glowing core. Tap a tile to turn it ' +
      '90°; swipe (or use the ARROW KEYS) to move the selector and press SPACE to turn what it covers. ' +
      'Power floods through any face-to-face join, so one bad turn snuffs a whole branch. The orange ' +
      'sealed nodes are already correct — turning one is a short circuit and ends the run. Boards grow ' +
      'from 4x4 to 8x8 over 8 levels, adding void cells, decoy dead ends and locked nodes; the clock pays ' +
      'up to +20 per remaining second. Best score is saved on this device.',
    start: start
  };
})();
