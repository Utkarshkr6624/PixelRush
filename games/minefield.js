/**
 * PIXEL RUSH — games/minefield.js — "Minefield"
 * Contract (GAME-CONTRACT.md): window.PixelGame = { name, instructions, start(root, api) }
 * where api = { setScore(n), setBest(n), gameOver(score) }; start() returns { destroy() }.
 * Self-contained: no imports, no dependencies, no assets — one <canvas> + 2D ctx, and every
 * rAF id, timer and listener created in start() is torn down in destroy().
 */
(function () {
  'use strict';
  /* -------------------------------- Tuning -------------------------------- */
  var STORE_KEY = 'pixelrush.minefield.best';
  var COLS = 12, ROWS = 12;     // square board on a roomy stage; shrink ROWS on a short one (resize)
  var CELLS = COLS * ROWS;
  var COLS_MAX = 12, ROWS_MAX = 12;
  var MIN_CELL = 22;            // a cell smaller than this is not tappable with a thumb
  var MIN_COLS = 6, MIN_ROWS = 4;   // floor for the shrunken board on a cramped stage
  var DENSITY_0 = 0.10;         // mine share on the first board …
  var DENSITY_STEP = 0.012;     // … plus this much per cleared board …
  var DENSITY_MAX = 0.30;       // … capped here, so the endgame stays solvable
  var SAFE_RADIUS = 2;          // first click opens this (5x5) neighbourhood: never a mine
  var REVEAL_PTS = 2;           // score per safe cell uncovered …
  var FLAG_PTS = 5;             // … and per flag planted
  var CHORD_MULT = 3;           // chorded cells are worth this instead of REVEAL_PTS
  var CLEAR_PTS = 100;          // board-clear bonus = CLEAR_PTS * level …
  var MINE_PTS = 20;            // … + MINE_PTS per mine on that board …
  var PAR_SECONDS = 200;        // … + a speed bonus of (PAR - elapsed) * 2
  var SPEED_PTS = 2;
  var LONG_PRESS_MS = 420;      // hold this long on a cell to flag it
  var PRESS_SLOP = 12;          // px of drift that still counts as a press
  var HIDDEN = 0, OPEN = 1, FLAG = 2;
  var KEYS = { ArrowUp: 'u', ArrowDown: 'd', ArrowLeft: 'l', ArrowRight: 'r', KeyW: 'u', KeyS: 'd', KeyA: 'l', KeyD: 'r' };
  // Everything the spec does not name, prefixed `mf-` so it cannot collide with the site
  var STYLES = '.mf{position:relative;width:100%;height:100%;overflow:hidden;touch-action:none;' +
    'user-select:none;-webkit-tap-highlight-color:transparent;' +
    'font-family:var(--font-body,"Rajdhani",system-ui,sans-serif);color:var(--ink,#f2f5ff)}' +
    '.mf canvas{display:block;width:100%;height:100%;outline:none}';
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
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
    var wrap = document.createElement('div'); wrap.className = 'mf';
    var canvas = document.createElement('canvas');
    canvas.setAttribute('tabindex', '0'); canvas.setAttribute('role', 'application');
    canvas.setAttribute('aria-label', 'Minefield board. Tap to reveal, long-press or FLAG button to flag, space reveals, F flags, arrows move.');
    var live = document.createElement('div'); // screen-reader announcements
    live.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0)';
    live.setAttribute('aria-live', 'polite');
    wrap.appendChild(canvas); wrap.appendChild(live);
    var styleTag = document.createElement('style');
    styleTag.textContent = STYLES; wrap.appendChild(styleTag); root.appendChild(wrap); // one <style>, scoped to .mf
    var ctx = canvas.getContext('2d');
    if (!ctx) { root.removeChild(wrap); return { destroy: function () {} }; }
    var rafId = 0, pressTimer = 0, destroyed = false;
    var reduced = !!(window.PX && window.PX.reduced) ||
      !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    /* ------------------------------ State ------------------------------ */
    var mine = [], num = [], cell3 = [];        // mine flags, adjacent counts, HIDDEN/OPEN/FLAG
    var level = 0, score = 0, minesTotal = 0, flagsLeft = 0;
    var openSafe = 0, started = false, over = false, paused = false, flagMode = false;
    var elapsed = 0, bestEver = readBest(), isRecord = false;
    var cursor = { x: 0, y: 0 }, boom = null;  // boom = { x, y, t } of the fatal mine
    /* ----------------- Sizing (crisp devicePixelRatio) ----------------- */
    var dpr = 1, cssW = 1, cssH = 1, cell = 10, bx = 0, by = 0, hudH = 40, btnH = 56, btnY = 0;
    var flagBtn = { x: 0, y: 0, w: 0, h: 0 }, restartBtn = { x: 0, y: 0, w: 0, h: 0 };
    /** Pick the largest grid whose cells stay thumb-sized in the space available. */
    function fitGrid(availW, availH) {
      var full = Math.floor(Math.min(availW / COLS_MAX, availH / ROWS_MAX));
      if (full >= MIN_CELL) return { cols: COLS_MAX, rows: ROWS_MAX, cell: full };
      /* A 12x12 board cannot hold a 22 px cell in a portrait stage, and letting
         the cell shrink to fit made the whole board a 96 px square of 8 px
         tiles. Height is the scarce axis there, so hold the cell at thumb size,
         keep as many of the 12 columns as the width allows, and drop ROWS. */
      var cols = clamp(Math.floor(availW / MIN_CELL), MIN_COLS, COLS_MAX);
      var rows = clamp(Math.floor(availH / MIN_CELL), MIN_ROWS, ROWS_MAX);
      // last resort on a very cramped stage: shrink the cell just enough to fit
      var cell = Math.max(6, Math.min(MIN_CELL, Math.floor(availW / cols), Math.floor(availH / rows)));
      return { cols: cols, rows: rows, cell: cell };
    }
    function resize() {
      var r = wrap.getBoundingClientRect();
      cssW = Math.max(1, Math.round(r.width)); cssH = Math.max(1, Math.round(r.height));
      dpr = clamp(window.devicePixelRatio || 1, 1, 2); // cap DPR: 2 is plenty and fill-rate safe
      canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
      canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      /* The shell's stage is a fixed 16/9 box, so on a portrait phone it is
         short and wide. Squeeze the chrome to its minimum there, and if a
         12x12 board still cannot give every cell a thumb-sized target, drop
         rows (never columns) until it can. */
      var short = cssH < 320;
      hudH = short ? clamp(cssH * 0.14, 26, 32) : clamp(cssH * 0.11, 30, 54);
      btnH = short ? clamp(cssH * 0.15, 34, 46) : clamp(cssH * 0.14, 46, 76);
      var gap = short ? 6 : 14;
      var pad = 10, bw2 = (cssW - pad * 3) / 2;
      var availW = Math.max(24, cssW - pad * 2);
      var availH = Math.max(24, cssH - hudH - btnH - gap);
      var g = fitGrid(availW, availH);
      if (g.cols !== COLS || g.rows !== ROWS) {
        /* Resizing mid-run must not reshuffle the mine layout under the player,
           so a live run keeps the grid it was generated on. */
        if (!started) {
          COLS = g.cols; ROWS = g.rows; CELLS = COLS * ROWS;
          cursor.x = 0; cursor.y = 0;
          newBoard();
        } else {
          g = { cols: COLS, rows: ROWS, cell: Math.max(8, Math.floor(Math.min(availW / COLS, availH / ROWS))) };
        }
      }
      cell = g.cell;
      var bw = cell * COLS, bh = cell * ROWS;
      bx = Math.round((cssW - bw) / 2);
      by = Math.round(hudH + (availH - bh) / 2);
      btnY = Math.round(cssH - btnH - 6);
      flagBtn = { x: pad, y: btnY, w: bw2, h: btnH };
      restartBtn = { x: pad * 2 + bw2, y: btnY, w: bw2, h: btnH };
    }
    resize();
    function token(n, fb) { // pull a site custom property, with a hard fallback
      var v = getComputedStyle(document.documentElement).getPropertyValue(n);
      return (v && v.trim()) || fb;
    }
    var C = { bg: token('--bg', '#05060f'), ink: token('--ink', '#f2f5ff'), dim: token('--ink-dim', '#a7b0d0'),
      cyan: token('--cyan', '#22e7ff'), magenta: token('--magenta', '#ff2fb9'), acid: token('--acid', '#c8ff2e'),
      orange: token('--orange', '#ff8a3d'), violet: token('--violet', '#8b5cf6') };
    // Classic minesweeper number ramp: distinct hue per count so it reads at a glance.
    var NUMC = ['', C.cyan, C.acid, C.orange, C.magenta, C.violet, C.ink, C.ink, C.ink];
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
    /* ---------------------------- Game logic ---------------------------- */
    function density() { return Math.min(DENSITY_MAX, DENSITY_0 + DENSITY_STEP * (level - 1)); }
    function plannedMines() { return clamp(Math.round(CELLS * density()), 4, Math.floor(CELLS * 0.4)); }
    function inBoard(x, y) { return x >= 0 && y >= 0 && x < COLS && y < ROWS; }
    function idx(x, y) { return y * COLS + x; }
    /**
     * Lay the mines. Called on the first reveal, with a keep-out box around that cell, so the
     * opening move can never be fatal and always opens a readable pocket.
     */
    function plant(safeX, safeY) {
      var total = plannedMines();
      var pool = [];
      for (var y = 0; y < ROWS; y++) for (var x = 0; x < COLS; x++) {
        if (safeX != null && Math.abs(x - safeX) <= SAFE_RADIUS && Math.abs(y - safeY) <= SAFE_RADIUS) continue;
        if (cell3[idx(x, y)] === FLAG) continue;   // never plant under a flag the player already set
        pool.push(idx(x, y));
      }
      var k = Math.min(total, pool.length);
      for (var i = 0; i < k; i++) { // partial Fisher-Yates, so the mines are uniform
        var j = i + Math.floor(Math.random() * (pool.length - i));
        var t = pool[i]; pool[i] = pool[j]; pool[j] = t;
        mine[pool[i]] = true;
      }
      for (var m = 0; m < CELLS; m++) { // precompute adjacency once per board
        var cx = m % COLS, cy = (m / COLS) | 0, c = 0;
        for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          var nx = cx + dx, ny = cy + dy;
          if (inBoard(nx, ny) && mine[idx(nx, ny)]) c++;
        }
        num[m] = c;
      }
      minesTotal = k; flagsLeft = k; openSafe = 0;
    }
    function blank() {
      mine = []; num = []; cell3 = [];
      for (var i = 0; i < CELLS; i++) { mine[i] = false; num[i] = 0; cell3[i] = HIDDEN; }
    }
    function pushScore() {
      setScore(score);
      if (bestEver === null || score > bestEver) {
        bestEver = score; isRecord = true; writeBest(score); setBest(score);
      }
    }
    function fmtTime(s) {
      s = Math.floor(s);
      return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
    }
    function newBoard() {
      blank(); started = false; boom = null; elapsed = 0;
      flagsLeft = plannedMines(); // shown before the mines actually exist
    }
    function resetRun() {
      level = 1; score = 0; isRecord = false; over = false; paused = false; flagMode = false;
      cursor.x = 0; cursor.y = 0; newBoard();
      pushScore();
      if (bestEver !== null) setBest(bestEver);
      setStatus('Playing');
      live.textContent = 'New run. Level 1, score 0.';
    }
    function openCell(x, y, mult) {
      if (!inBoard(x, y) || cell3[idx(x, y)] !== HIDDEN) return 0;
      var n = 0;
      cell3[idx(x, y)] = OPEN; openSafe++; n++;
      score += REVEAL_PTS * (mult || 1);
      if (num[idx(x, y)] === 0) {           // flood fill the empty region, iteratively
        var stack = [idx(x, y)];
        while (stack.length) {
          var m = stack.pop(), mx = m % COLS, my = (m / COLS) | 0;
          for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            var nx = mx + dx, ny = my + dy;
            if (!inBoard(nx, ny)) continue;
            var j = idx(nx, ny);
            if (cell3[j] !== HIDDEN || mine[j]) continue;
            cell3[j] = OPEN; openSafe++; n++;
            score += REVEAL_PTS * (mult || 1);
            if (num[j] === 0) stack.push(j);  // only empty cells continue the cascade
          }
        }
      }
      return n;
    }
    /** Tap / space on a cell: reveal, chord, or toggle a flag depending on the mode. */
    function press(x, y) {
      if (over || paused) return;
      var m = idx(x, y), st = cell3[m];
      if (flagMode || st === FLAG) { if (st !== OPEN) toggleFlag(x, y); return; }
      if (!started) { started = true; plant(x, y); }   // first-move guarantee
      if (cell3[m] === OPEN) { chord(x, y); return; }
      if (mine[m]) { detonate(x, y); return; }
      var got = openCell(x, y, 1);
      if (got) pushScore();
      if (openSafe >= CELLS - minesTotal) clearBoard();
    }
    function toggleFlag(x, y) {
      if (over || paused) return;
      // Flagging is a board action: before the first reveal there are no mines
      // to reason about, so flags would be free points and would shove the mines
      // out of the cells plant() keeps clear.
      if (!started) return;
      var m = idx(x, y);
      if (cell3[m] === OPEN) return;
      if (cell3[m] === FLAG) { cell3[m] = HIDDEN; flagsLeft++; }
      else { cell3[m] = FLAG; flagsLeft--; score += FLAG_PTS; }
      pushScore();
      live.textContent = (cell3[m] === FLAG ? 'Flag. ' : 'Unflag. ') + flagsLeft + ' flags left.';
    }
    function flaggedAround(x, y) {
      var c = 0;
      for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        var nx = x + dx, ny = y + dy;
        if (inBoard(nx, ny) && cell3[idx(nx, ny)] === FLAG) c++;
      }
      return c;
    }
    /** Chording: an open number with the right flag count opens its untouched neighbours. */
    function chord(x, y) {
      var m = idx(x, y);
      if (num[m] === 0 || flaggedAround(x, y) !== num[m]) return;
      var opened = 0, hit = false;
      for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        var nx = x + dx, ny = y + dy;
        if (!inBoard(nx, ny)) continue;
        var j = idx(nx, ny);
        if (cell3[j] !== HIDDEN) continue;
        if (mine[j]) { hit = true; break; }
        opened += openCell(nx, ny, CHORD_MULT);
      }
      if (opened) pushScore();
      if (hit) detonate(x + dx, y + dy);  // dx/dy point at the mine the loop stopped on
      else if (openSafe >= CELLS - minesTotal) clearBoard();
    }
    function detonate(x, y) {
      if (over) return;
      over = true; flagMode = false; boom = { x: x, y: y, t: performance.now() };
      live.textContent = 'Boom. Final score ' + score + '.';
      gameOverCb(score); // exactly once per run: `over` latches before the call
    }
    function clearBoard() {
      score += CLEAR_PTS * Math.max(1, level) + minesTotal * MINE_PTS +
        Math.max(0, PAR_SECONDS - Math.floor(elapsed)) * SPEED_PTS;
      level++;
      pushScore();
      flagMode = false; newBoard();
      live.textContent = 'Board cleared. Level ' + level + '. Score ' + score + '.';
    }
    /* ------------------------- Input: pointer + keys ------------------------- */
    function hit(r, x, y) { return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h; }
    function cellAt(cx, cy) {
      var x = Math.floor((cx - bx) / cell), y = Math.floor((cy - by) / cell);
      return inBoard(x, y) ? { x: x, y: y } : null;
    }
    function local(e) {
      var r = canvas.getBoundingClientRect();
      return { x: (e.clientX - r.left) * (cssW / Math.max(1, r.width)),
               y: (e.clientY - r.top) * (cssH / Math.max(1, r.height)) };
    }
    function clearPress() { if (pressTimer) { clearTimeout(pressTimer); pressTimer = 0; } }
    function resume() { // unpause, stop the clock jump, and tell the site HUD
      paused = false; last = performance.now();
      if (!over) setStatus('Playing');
    }
    function onPointerDown(e) {
      if (e.button !== undefined && e.button > 1) return;  // left / touch only; right goes to contextmenu
      var p = local(e), c = cellAt(p.x, p.y);
      if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
      if (hit(flagBtn, p.x, p.y)) { resume(); flagMode = !flagMode; return; }
      if (hit(restartBtn, p.x, p.y)) { resetRun(); return; }
      if (over) { resetRun(); return; }
      if (!c) { resume(); return; }
      resume();
      cursor.x = c.x; cursor.y = c.y; keyMode = false;
      longPressed = false; pressPid = e.pointerId;
      if (cell3[idx(c.x, c.y)] === HIDDEN && !flagMode) {  // hold to flag, tap to reveal
        var px = e.clientX, py = e.clientY;
        clearPress();
        pressTimer = setTimeout(function () {
          pressTimer = 0;
          if (destroyed || over || cell3[idx(c.x, c.y)] !== HIDDEN) return;
          longPressed = true;             // the coming pointerup must NOT also act on this cell
          toggleFlag(c.x, c.y);
        }, LONG_PRESS_MS);
        pressMove = function (ev) {
          if (ev.pointerId !== pressPid) return;
          if (Math.abs(ev.clientX - px) > PRESS_SLOP || Math.abs(ev.clientY - py) > PRESS_SLOP) clearPress();
        };
      }
    }
    function onPointerMove(e) { if (pressMove) pressMove(e); }
    function onPointerUp(e) {
      clearPress(); pressMove = null;
      if (e.button !== undefined && e.button !== 0) return;
      if (longPressed) { longPressed = false; return; }
      var p = local(e);
      if (over || hit(flagBtn, p.x, p.y) || hit(restartBtn, p.x, p.y)) return;
      var c = cellAt(p.x, p.y);
      if (c) press(c.x, c.y);
    }
    function onPointerCancel() { clearPress(); pressMove = null; longPressed = false; }
    function onContextMenu(e) {
      if (destroyed) return;
      e.preventDefault();
      var p = local(e), c = cellAt(p.x, p.y);
      resume();
      if (over) { resetRun(); return; }
      if (c) { cursor.x = c.x; cursor.y = c.y; keyMode = false; if (cell3[idx(c.x, c.y)] !== OPEN) toggleFlag(c.x, c.y); }
    }
    function onKeyDown(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var d = KEYS[e.code] || KEYS[e.key];
      if (d) {
        var a = document.activeElement;
        if (a && a !== canvas && /^(BUTTON|INPUT|SELECT|TEXTAREA|A|SUMMARY)$/.test(a.tagName)) return;
        e.preventDefault(); keyMode = true; resume();
        if (over) { resetRun(); return; }
        cursor.x = (cursor.x + (d === 'l' ? -1 : d === 'r' ? 1 : 0) + COLS) % COLS;
        cursor.y = (cursor.y + (d === 'u' ? -1 : d === 'd' ? 1 : 0) + ROWS) % ROWS;
        return;
      }
      if (e.code === 'Space' || e.code === 'Enter' || e.key === ' ') {
        var b = document.activeElement;
        if (b && b !== canvas && /^(BUTTON|INPUT|SELECT|TEXTAREA|A|SUMMARY)$/.test(b.tagName)) return;
        e.preventDefault(); resume();
        if (over) resetRun(); else press(cursor.x, cursor.y);
        return;
      }
    }
    /**
     * R and F are also bound by the site shell on `document` (restart / fullscreen).
     * The shell registers first, so a plain bubble-phase handler can never win:
     * F went fullscreen instead of flagging and R tore the whole cabinet down and
     * re-mounted it. Capture phase runs before the shell's bubble listener on the
     * same node, and stopPropagation() keeps that listener from ever seeing the key.
     */
    function onKeyCapture(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var t = e.target; // never steal R/F from a real form control
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      var isF = e.code === 'KeyF' || e.key === 'f' || e.key === 'F';
      var isR = e.code === 'KeyR' || e.key === 'r' || e.key === 'R';
      if (!isF && !isR) return;
      e.preventDefault(); e.stopPropagation();
      if (destroyed) return;
      if (isF) { resume(); if (!over) flagMode = !flagMode; }
      else resetRun();
    }
    var pressMove = null, keyMode = false, longPressed = false, pressPid = -1;
    function onResize() { if (!destroyed) resize(); }
    function onBlur() { if (!destroyed && !over) { paused = true; setStatus('Paused'); } } // auto-pause on focus loss
    function onVisibility() { if (document.hidden) onBlur(); }
    // Every listener the game owns, in one table so teardown cannot miss one.
    var BIND = [[document, 'keydown', onKeyDown], [document, 'keydown', onKeyCapture, true],
      [canvas, 'pointerdown', onPointerDown],
      [canvas, 'pointermove', onPointerMove], [canvas, 'pointerup', onPointerUp],
      [canvas, 'pointercancel', onPointerCancel], [canvas, 'contextmenu', onContextMenu],
      [window, 'resize', onResize, { passive: true }], [window, 'orientationchange', onResize],
      [window, 'blur', onBlur], [document, 'visibilitychange', onVisibility]];
    BIND.forEach(function (b) { b[0].addEventListener(b[1], b[2], b[3]); });
    /* ------------------------------ Render ------------------------------ */
    function drawFlag(x, y, col) {
      var s = cell * 0.5, cx = x + cell / 2, cy = y + cell / 2;
      ctx.save();
      ctx.shadowColor = col; ctx.shadowBlur = reduced ? 0 : 12; ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(cx, cy - s * 0.5); ctx.lineTo(cx + s * 0.5, cy - s * 0.18);
      ctx.lineTo(cx + s * 0.5, cy + s * 0.2); ctx.lineTo(cx, cy + s * 0.08);
      ctx.closePath(); ctx.fill();
      ctx.fillRect(cx - s * 0.42, cy - s * 0.5, s * 0.12, s);   // pole
      ctx.restore();
    }
    function drawMine(x, y, now) {
      var cx = x + cell / 2, cy = y + cell / 2, r = cell * 0.28, col = C.orange;
      if (boom && boom.x === Math.round((cx - bx) / cell - 0.5) && boom.y === Math.round((cy - by) / cell - 0.5)) {
        var age = reduced ? 1 : (now - boom.t) / 700;
        if (age <= 1) { // shockwave ring from the fatal cell
          var rad = cell * (0.4 + age * 4);
          ctx.save(); ctx.globalAlpha = 1 - age;
          ctx.strokeStyle = C.magenta; ctx.lineWidth = 3; ctx.shadowColor = C.magenta; ctx.shadowBlur = 20;
          ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
        }
      }
      ctx.save(); ctx.shadowColor = col; ctx.shadowBlur = reduced ? 0 : 18; ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = col; ctx.lineWidth = Math.max(1.5, cell * 0.07);
      for (var i = 0; i < 4; i++) { // spikes
        var a = i * Math.PI / 4;
        ctx.beginPath();
        ctx.moveTo(cx - Math.cos(a) * r * 1.9, cy - Math.sin(a) * r * 1.9);
        ctx.lineTo(cx + Math.cos(a) * r * 1.9, cy + Math.sin(a) * r * 1.9);
        ctx.stroke();
      }
      ctx.restore();
    }
    function button(r, label, hot, hotCol) {
      ctx.save();
      rr(r.x, r.y, r.w, r.h, Math.min(14, r.h * 0.3));
      ctx.fillStyle = hot ? hexA(hotCol, 0.16) : 'rgba(255,255,255,.04)';
      ctx.fill();
      ctx.strokeStyle = hexA(hot ? hotCol : C.dim, hot ? 0.95 : 0.4);
      ctx.lineWidth = 2; ctx.shadowColor = hexA(hotCol, 0.8); ctx.shadowBlur = hot && !reduced ? 20 : 0;
      ctx.stroke(); ctx.shadowBlur = 0;
      ctx.fillStyle = hot ? hotCol : C.dim;
      // Height alone balloons the label on a tall portrait stage, so cap by button width too.
      ctx.font = '700 ' + Math.round(clamp(Math.min(r.h * 0.34, r.w * 0.13), 10, 20)) +
        'px Rajdhani, system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(label, r.x + r.w / 2, r.y + r.h / 2 + 1);
      ctx.restore();
    }
    /** Greedy word wrap of `str` into lines that each fit `maxW` at the font already set. */
    function wrapTo(str, font, maxW) {
      ctx.font = font;
      var words = String(str).split(' '), lines = [], cur = '';
      for (var i = 0; i < words.length; i++) {
        var t = cur ? cur + ' ' + words[i] : words[i];
        if (cur && ctx.measureText(t).width > maxW) { lines.push(cur); cur = words[i]; }
        else cur = t;
      }
      if (cur) lines.push(cur);
      return lines;
    }
    /**
     * Shrink `size` by 1px steps down to a still-legible floor, then wrap whatever will not
     * fit on one line. A tall portrait stage makes cssH the LARGER dimension, so height-only
     * sizing runs the title and the long body copy clean off both edges; width has to cap it.
     * Shrinking all the way down to fit one line would make the copy unreadable, so below
     * the floor we wrap instead of clipping.
     */
    function blockText(str, weight, family, size, maxW, floor) {
      var s = size;
      while (s > floor && wrapTo(str, weight + ' ' + Math.round(s) + 'px ' + family, maxW).length > 1) s -= 1;
      var font = weight + ' ' + Math.round(s) + 'px ' + family;
      return { size: Math.round(s), lh: Math.round(s) * 1.25, lines: wrapTo(str, font, maxW) };
    }
    function card(title, sub, color, hint) {
      ctx.fillStyle = hexA(C.bg, 0.76); ctx.fillRect(0, 0, cssW, cssH);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      var maxW = cssW * 0.86;
      var tf = clamp(Math.min(cssH * 0.12, cssW * 0.14), 16, 56);
      while (tf > 16) { // measure at the size being tested, not the one it started from
        ctx.font = '900 ' + Math.round(tf) + 'px Orbitron, system-ui, sans-serif';
        if (ctx.measureText(title).width <= maxW) break;
        tf -= 1;
      }
      var body = blockText(sub, '600', 'Rajdhani, system-ui, sans-serif',
        clamp(Math.min(cssH * 0.045, cssW * 0.055), 13, 20), maxW, 13);
      var hb = hint ? blockText(hint, '600', 'Rajdhani, system-ui, sans-serif', body.size, maxW, 13) : null;
      /* Stack title / body / hint and centre the group. Pinning each to a fixed fraction of
         cssH looked fine while every string was one line; the moment the body wraps on a
         narrow stage, the second line runs straight into the title. */
      var gap1 = tf * 0.5, gap2 = hb ? Math.max(cssH * 0.045, body.lh) : 0;
      var total = tf + gap1 + body.lines.length * body.lh + (hb ? gap2 + hb.lines.length * hb.lh : 0);
      var y = (cssH - total) / 2 + tf / 2;
      ctx.font = '900 ' + Math.round(tf) + 'px Orbitron, system-ui, sans-serif'; // blockText left the body font set
      ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 26;
      ctx.fillText(title, cssW / 2, y); ctx.shadowBlur = 0;
      y += tf / 2 + gap1 + body.lh / 2;
      ctx.font = '600 ' + body.size + 'px Rajdhani, system-ui, sans-serif';
      ctx.fillStyle = C.dim;
      for (var i = 0; i < body.lines.length; i++) ctx.fillText(body.lines[i], cssW / 2, y + i * body.lh);
      if (!hb) return;
      y += (body.lines.length - 1) * body.lh + body.lh / 2 + gap2 + hb.lh / 2;
      ctx.font = '600 ' + hb.size + 'px Rajdhani, system-ui, sans-serif';
      for (var j = 0; j < hb.lines.length; j++) ctx.fillText(hb.lines[j], cssW / 2, y + j * hb.lh);
    }
    function draw(now) {
      var w = cssW, h = cssH, bw = cell * COLS, bh = cell * ROWS;
      ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);
      ctx.save();
      rr(bx, by, bw, bh, Math.min(16, cell * 0.5));
      ctx.fillStyle = 'rgba(255,255,255,.03)'; ctx.fill(); ctx.clip();
      var pad = Math.max(1, cell * 0.07);
      for (var y = 0; y < ROWS; y++) for (var x = 0; x < COLS; x++) {
        var m = idx(x, y), st = cell3[m], px = bx + x * cell, py = by + y * cell;
        if (st === HIDDEN || st === FLAG) {        // closed cell: a dim neon tile (flags sit on one)
          rr(px + pad, py + pad, cell - pad * 2, cell - pad * 2, cell * 0.22);
          ctx.fillStyle = 'rgba(139,92,246,.12)'; ctx.fill();
          ctx.strokeStyle = hexA(C.violet, 0.4); ctx.lineWidth = 1;
          ctx.stroke();
        } else if (mine[m] && over) {
          drawMine(px, py, now);                   // dead run: every mine is shown
        } else if (st === OPEN) {
          ctx.fillStyle = num[m] ? 'rgba(255,255,255,.05)' : 'rgba(34,231,255,.05)';
          ctx.fillRect(px, py, cell, cell);
          if (num[m]) {
            ctx.fillStyle = NUMC[num[m]];
            ctx.font = '800 ' + Math.round(cell * 0.62) + 'px Orbitron, system-ui, sans-serif';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.shadowColor = NUMC[num[m]]; ctx.shadowBlur = reduced ? 0 : 10;
            ctx.fillText(String(num[m]), px + cell / 2, py + cell / 2 + cell * 0.03);
            ctx.shadowBlur = 0;
          }
        }
        if (st === FLAG) drawFlag(px, py, mine[m] ? C.orange : C.magenta);
        if (over && st === FLAG && !mine[m]) {     // flag planted on a safe cell
          ctx.strokeStyle = C.magenta; ctx.lineWidth = Math.max(1.5, cell * 0.08);
          ctx.beginPath();
          ctx.moveTo(px + cell * 0.3, py + cell * 0.3); ctx.lineTo(px + cell * 0.7, py + cell * 0.7);
          ctx.moveTo(px + cell * 0.7, py + cell * 0.3); ctx.lineTo(px + cell * 0.3, py + cell * 0.7);
          ctx.stroke();
        }
      }
      ctx.restore();
      ctx.save(); rr(bx, by, bw, bh, Math.min(16, cell * 0.5));
      ctx.strokeStyle = hexA(C.cyan, 0.3); ctx.lineWidth = 2;
      ctx.shadowColor = hexA(C.cyan, 0.6); ctx.shadowBlur = reduced ? 0 : 14; ctx.stroke(); ctx.restore();
      if (started && !over) {                     // keyboard cursor / last-touched cell
        var beat = reduced ? 1 : 0.75 + 0.25 * Math.sin(now / 260);
        var cx = bx + cursor.x * cell, cy = by + cursor.y * cell;
        rr(cx + 1, cy + 1, cell - 2, cell - 2, cell * 0.22);
        ctx.strokeStyle = hexA(C.acid, (keyMode ? 0.95 : 0.45) * beat);
        ctx.lineWidth = keyMode ? 3 : 2;
        ctx.shadowColor = hexA(C.acid, 0.8); ctx.shadowBlur = reduced ? 0 : 16; ctx.stroke();
      }
      if (!reduced) {                             // CRT polish, over the world layer only
        ctx.fillStyle = 'rgba(0,0,0,.15)';
        for (var sy = 0; sy < h; sy += 3) ctx.fillRect(0, sy, w, 1);
      }
      var vig = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75);
      vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(0,0,0,.5)');
      ctx.fillStyle = vig; ctx.fillRect(0, 0, w, h);
      /* HUD — drawn above the CRT overlay so the readouts stay at full contrast.
         A dark backing plate plus a matching shadow keeps them legible over any world pixel. */
      ctx.fillStyle = 'rgba(5,6,15,.72)'; ctx.fillRect(0, 0, w, hudH);
      var fs = Math.round(clamp(Math.min(h * 0.042, w * 0.06), 10, 17));
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,.9)'; ctx.shadowBlur = 4;
      ctx.font = '700 ' + fs + 'px Rajdhani, system-ui, sans-serif';
      ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      ctx.fillStyle = flagsLeft < 0 ? C.magenta : C.ink;
      ctx.fillText('FLAGS ' + flagsLeft, 10, hudH * 0.5 - fs * 0.55);
      ctx.textAlign = 'center'; ctx.fillStyle = C.cyan;
      ctx.fillText('TIME ' + fmtTime(elapsed), w / 2, hudH * 0.5 - fs * 0.55);
      ctx.textAlign = 'right'; ctx.fillStyle = C.ink;
      ctx.fillText('SCORE ' + score, w - 10, hudH * 0.5 - fs * 0.55);
      ctx.font = '600 ' + Math.round(fs * 0.8) + 'px Rajdhani, system-ui, sans-serif';
      ctx.textAlign = 'left'; ctx.fillStyle = C.dim;
      ctx.fillText('LV ' + level + ' · ' + Math.round(density() * 100) + '% MINES', 10, hudH * 0.5 + fs * 0.6);
      ctx.textAlign = 'right'; ctx.fillStyle = isRecord ? C.acid : C.dim;
      ctx.fillText('BEST ' + (bestEver || 0), w - 10, hudH * 0.5 + fs * 0.6);
      ctx.restore();
      // Thumb-zone controls: the FLAG mode toggle and a restart, always reachable.
      button(flagBtn, flagMode ? 'FLAG: ON' : 'FLAG: OFF', flagMode, C.magenta);
      button(restartBtn, 'RESTART', false, C.cyan);
      if (over) card('GAME OVER', 'SCORE ' + score + (isRecord ? '  ·  NEW BEST' : '') +
        '  ·  LEVEL ' + level, C.magenta, 'TAP or press SPACE to play again');
      else if (paused) card('PAUSED', started ? 'Tap or press a key to resume' : 'Tap a cell or press SPACE to start', C.cyan, null);
      else if (!started) card('MINEFIELD', 'Clear every safe cell. ' + plannedMines() +
        ' mines on this board.', C.cyan, 'TAP to open · hold to flag');
    }
    /* -------------------------- Single rAF loop -------------------------- */
    var last = performance.now();
    function frame(now) {
      if (destroyed) return;   // guard: destroy() can land between frames
      var dt = (now - last) / 1000; last = now;
      if (started && !over && !paused) elapsed += Math.min(1, Math.max(0, dt));
      draw(now);
      rafId = requestAnimationFrame(frame);
    }
    resetRun();
    rafId = requestAnimationFrame(frame);
    return {
      destroy: function () {
        if (destroyed) return;
        destroyed = true; cancelAnimationFrame(rafId); clearPress();
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
    name: 'Minefield',
    instructions:
      'Tap or click a cell to open it, hold to flag (or use the FLAG button; right-click also flags). ' +
      'Your first move is always safe and opens a clear pocket. Open a number whose adjacent flag count ' +
      'matches to chord it. Clear every safe cell to level up — the mine density rises each board. ' +
      'Arrows move the cursor, SPACE opens, F flags, R restarts. Best score is saved on this device.',
    start: start
  };
})();
