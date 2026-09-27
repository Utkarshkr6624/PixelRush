/**
 * PIXEL RUSH — games/blockfall.js
 * Game module #2: "Blockfall"
 *
 * Contract (SPEC.md §"games/reaction.js contract"):
 *   window.PixelGame = { name, instructions, start(root, api) -> { destroy() } }
 *   api = { setScore(n), setBest(n), gameOver(score) }
 *
 * Self-contained: no imports, no dependencies, no assets. Everything is drawn on
 * a single <canvas> 2D context; all styling the spec does not name is injected
 * from this file (see STYLE BLOCK below).
 *
 * Rule: every rAF id and every event listener created in start() is torn down
 * in destroy(). Nothing survives the shell navigating away.
 */
(function () {
  'use strict';

  /* --- Tuning --- */
  var STORE_KEY = 'pixelrush.blockfall.best'; // localStorage: highest score
  var COLS = 10, ROWS = 20;      // the well
  var BASE_MS = 820, MIN_MS = 70; // ms per row at level 1 … and at the speed cap
  var LINES_PER_LEVEL = 10;
  var DAS = 160, ARR = 42, SOFT_MS = 45; // auto-shift delay / repeat, soft-drop step
  var LINE_SCORE = [0, 100, 300, 500, 800]; // 1/2/3/4 lines, before the level multiplier
  var DROP_SCORE = 2;            // points per row soft- or hard-dropped

  /* --- Pieces: 4x4 boxes, pre-spun into 4 rotation states. TYPE maps a letter
     to a number (the well is a typed array); TINT[number] is its colour. --- */
  var KEYS = ['I', 'J', 'L', 'O', 'S', 'T', 'Z'];
  var TYPE = { I: 1, J: 2, L: 3, O: 4, S: 5, T: 6, Z: 7 };
  var TINT = ['', 'cyan', 'violet', 'orange', 'acid', 'magenta', 'cyan', 'magenta'];
  var BASE = {
    I: [[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]], J: [[1,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]],
    L: [[0,0,1,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]], O: [[0,1,1,0],[0,1,1,0],[0,0,0,0],[0,0,0,0]],
    S: [[0,0,1,1],[0,1,1,0],[0,0,0,0],[0,0,0,0]], T: [[0,1,0,0],[1,1,1,0],[0,0,0,0],[0,0,0,0]],
    Z: [[1,1,0,0],[0,1,1,0],[0,0,0,0],[0,0,0,0]]
  };
  var ROT = {};
  (function spin() {
    for (var n = 0; n < KEYS.length; n++) {
      var k = KEYS[n], states = [BASE[k]], m, i, j;
      for (var r = 1; r < 4; r++) {
        m = [[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]];
        for (i = 0; i < 4; i++) for (j = 0; j < 4; j++) m[j][3 - i] = states[r - 1][i][j];
        states.push(m);
      }
      ROT[k] = states;
    }
  })();

  /* --- STYLE BLOCK: everything the spec does not name, injected by this file.
     Prefixed `bf-` so it can never collide with base.css / games.css, and every
     rule is scoped to the wrapper this file creates. --- */
  var STYLES = [
    '.bf{position:relative;width:100%;height:100%;overflow:hidden;',
    'font-family:var(--font-body,"Rajdhani",system-ui,sans-serif);color:var(--ink,#f2f5ff);}',
    '.bf canvas{display:block;width:100%;height:100%;touch-action:none;',
    'cursor:pointer;-webkit-tap-highlight-color:transparent;}',
    '.bf__sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;',
    'clip:rect(0 0 0 0);white-space:nowrap;border:0;}',
    '@media (prefers-reduced-motion:reduce){.bf canvas{transition:none;}}'
  ].join('\n');

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function token(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return (v && v.trim()) || fallback;
  }
  /** #rrggbb (or #rgb) + alpha -> rgba() string. */
  function hexA(hex, a) {
    hex = (hex || '#ffffff').trim().replace('#', '');
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    var n = parseInt(hex, 16);
    if (!isFinite(n)) return 'rgba(255,255,255,' + a + ')';
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  function readBest() {
    try {
      var v = parseInt(window.localStorage.getItem(STORE_KEY), 10);
      return isFinite(v) && v > 0 ? v : null;
    } catch (e) { return null; } // private mode / disabled storage
  }
  function writeBest(n) { try { window.localStorage.setItem(STORE_KEY, String(n)); } catch (e) { /* ignore */ } }

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

    /* --- DOM --- */
    var wrap = document.createElement('div');
    wrap.className = 'bf';
    var canvas = document.createElement('canvas');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('tabindex', '0');
    canvas.setAttribute('aria-label',
      'Blockfall playing field. Arrows or WASD to move and rotate, down to soft drop, ' +
      'space to hard drop, C to hold, P to pause. On touch: swipe to move, tap to rotate.');
    var live = document.createElement('div');
    live.className = 'bf__sr';
    live.setAttribute('aria-live', 'polite');
    wrap.appendChild(canvas);
    wrap.appendChild(live);
    root.appendChild(wrap);
    var styleTag = document.createElement('style');
    styleTag.textContent = STYLES;
    wrap.appendChild(styleTag);
    var ctx = canvas.getContext('2d');
    if (!ctx) { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); return { destroy: function () {} }; }

    /* --- Sizing: crisp devicePixelRatio, and a fit that never distorts --- */
    var dpr = 1, cssW = 0, cssH = 0;
    var L = {}; // layout: cell = px, ox/oy = board origin, px/pw = side panel
    function onResize() { if (!destroyed) resize(); }
    function resize() {
      var pad = 10, aw, ah, cell, bw, bh, spare, pw, fs, u, r;
      /* The shell sizes the canvas with CSS, so the element's own client box is
         the authoritative size. Measuring the wrapper instead picked up a
         pre-layout rect and left the backing store ~1.5% short of the CSS box,
         which made the browser upscale the bitmap. */
      cssW = canvas.clientWidth || 0; cssH = canvas.clientHeight || 0;
      if (!cssW || !cssH) { r = wrap.getBoundingClientRect(); cssW = r.width; cssH = r.height; }
      cssW = Math.max(1, Math.round(cssW));
      cssH = Math.max(1, Math.round(cssH));
      dpr = clamp(window.devicePixelRatio || 1, 1, 3); // cap DPR: fill-rate win on 3x phones
      canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      /* The well is height-bound (20 rows in a 16:9 stage), so the spare width
         goes to the side panel: it widens instead of sitting as dead black
         space, and the pair stays centred. Never stretched, only letterboxed. */
      aw = Math.max(20, cssW - pad * 2); ah = Math.max(20, cssH - pad * 2);
      cell = clamp(Math.floor(Math.min(aw / (COLS + 3.2), ah / ROWS)), 2, 48);
      bw = cell * COLS; bh = cell * ROWS;
      spare = Math.max(0, aw - bw);
      pw = clamp(spare * 0.55, cell * 3.2, cell * 6.5);
      pw = Math.max(0, Math.min(pw, spare));
      L.cell = cell; L.bw = bw; L.bh = bh;
      L.ox = pad + Math.max(0, (aw - bw - pw) / 2);
      L.oy = pad + Math.max(0, (ah - bh) / 2);
      L.px = L.ox + bw; L.pw = pw;
      /* Side-panel type and thumbnails, both floored so they stay readable on
         a phone. `fs` drives every vertical gap below — `u` must never be, or
         the four stat lines collide once `u` hits its floor. */
      L.fs = clamp(Math.min(cell * 0.72, pw * 0.17), 11, 18);
      L.u = Math.max(3, Math.min(Math.floor(cell * 0.6), Math.floor(pw * 0.13)));
    }
    resize();
    /* Re-measure when the shell finishes laying the stage out: the first rect
       can be a few px short of the final size. */
    var ro = null;
    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(function () { onResize(); });
      ro.observe(wrap); ro.observe(canvas);
    }

    /* --- Colours, pulled from the site tokens --- */
    var C = {
      bg: token('--bg', '#05060f'), ink: token('--ink', '#f2f5ff'), dim: token('--ink-dim', '#a7b0d0'),
      mute: token('--ink-mute', '#6b7599'), cyan: token('--cyan', '#22e7ff'), magenta: token('--magenta', '#ff2fb9'),
      acid: token('--acid', '#c8ff2e'), orange: token('--orange', '#ff8a3d'), violet: token('--violet', '#8b5cf6')
    };
    var reduced = !!(window.PX && window.PX.reduced) ||
      (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

    /* --- State --- */
    var grid, cur, next = null, hold = null, canHold = true, bag = [], listeners = [];
    var score = 0, lines = 0, level = 1, bestEver = readBest();
    var dropAcc = 0, das = 0, last = 0, over = false, ended = false, paused = false;
    var rafId = 0, destroyed = false, sw = null, flashUntil = 0, flashText = '';
    var held = { left: false, right: false, down: false };
    function on(el, type, fn, opts) {
      el.addEventListener(type, fn, opts);
      listeners.push([el, type, fn, opts]); // every one is undone in destroy()
    }

    /* --- Piece plumbing --- */
    function newBag() { // 7-bag: no droughts, no long streaks
      var i, j, t;
      bag = KEYS.slice();
      for (i = bag.length - 1; i > 0; i--) { j = Math.floor(Math.random() * (i + 1)); t = bag[i]; bag[i] = bag[j]; bag[j] = t; }
    }
    function pullPiece() {
      if (!bag.length) newBag();
      return { k: bag.pop(), r: 0, x: 3, y: 0 };
    }
    function cells(p) {
      var m = ROT[p.k][p.r], out = [], x, y;
      for (y = 0; y < 4; y++) for (x = 0; x < 4; x++) if (m[y][x]) out.push([p.x + x, p.y + y]);
      return out;
    }
    function fits(p, dx, dy, dr) {
      var q = { k: p.k, r: (dr === undefined ? p.r : (p.r + dr + 4) % 4), x: p.x + (dx || 0), y: p.y + (dy || 0) };
      var list = cells(q), i, cx, cy;
      for (i = 0; i < list.length; i++) {
        cx = list[i][0]; cy = list[i][1];
        if (cx < 0 || cx >= COLS || cy >= ROWS) return false;
        if (cy >= 0 && grid[cy * COLS + cx]) return false;
      }
      return true;
    }
    /* A paused run accepts no mutations at all: `update()` returning early is
       not enough on its own, because an explicit drop/rotate/hold still ran
       and scored behind the PAUSED overlay. The guards live here, at the
       mutation, so every input path (key, pointer, held auto-shift) inherits
       them. */
    function move(dx, dy) {
      if (over || paused || !fits(cur, dx, dy)) return false;
      cur.x += dx; cur.y += dy; return true;
    }
    function rotate(dir) { if (over || paused) return; if (fits(cur, 0, 0, dir)) cur.r = (cur.r + dir + 4) % 4; }
    function ghostY() { var d = 0; while (fits(cur, 0, d + 1)) d++; return cur.y + d; }
    function spawn() {
      cur = pullPiece(); next = pullPiece();
      canHold = true; dropAcc = 0; das = 0;
      if (!fits(cur, 0, 0)) endRun(); // topped out: no room for a new piece
    }
    function hardDrop() {
      var d = 0;
      if (over || paused) return;
      while (fits(cur, 0, d + 1)) d++;
      if (d > 0) { cur.y += d; score += d * DROP_SCORE; syncScore(); }
      lockPiece();
    }
    function doHold() {
      var prev;
      if (over || paused || !canHold) return;
      canHold = false; prev = hold;
      hold = { k: cur.k, r: 0, x: 3, y: 0 };
      cur = prev || pullPiece();
      cur.r = 0; cur.x = 3; cur.y = 0;
      next = pullPiece(); dropAcc = 0; das = 0;
      if (!fits(cur, 0, 0)) endRun();
    }
    function lockPiece() {
      var list = cells(cur), i, x, y;
      for (i = 0; i < list.length; i++) {
        x = list[i][0]; y = list[i][1];
        if (y >= 0 && y < ROWS) grid[y * COLS + x] = TYPE[cur.k];
      }
      clearLines();
      if (!over) spawn();
    }
    function clearLines() {
      var cleared = 0, x, y, xx, yy, full;
      for (y = ROWS - 1; y >= 0; y--) {
        full = true;
        for (x = 0; x < COLS; x++) if (!grid[y * COLS + x]) { full = false; break; }
        if (!full) continue;
        cleared++;
        for (yy = y; yy > 0; yy--) for (xx = 0; xx < COLS; xx++) grid[yy * COLS + xx] = grid[(yy - 1) * COLS + xx];
        for (x = 0; x < COLS; x++) grid[x] = 0; // the stack above falls down
        y++; // re-test the row that just moved into place
      }
      if (!cleared) return;
      if (cleared > 4) cleared = 4;       // a single lock can never really clear more
      lines += cleared;
      level = 1 + Math.floor(lines / LINES_PER_LEVEL); // one level = one speed step, per 10 lines
      var gain = LINE_SCORE[cleared] * level;
      score += gain; syncScore();
      flashText = (cleared > 1 ? cleared + 'x LINE' : 'LINE CLEAR') + ' +' + gain;
      flashUntil = performance.now() + (reduced ? 300 : 800);
      live.textContent = flashText + '. Level ' + level + ', score ' + score + '.';
    }
    function syncScore() {
      setScore(score);
      if (bestEver === null || score > bestEver) { bestEver = score; writeBest(score); setBest(score); }
    }
    function resetRun() {
      grid = new Uint8Array(COLS * ROWS);
      bag = []; hold = null; canHold = true; over = false; ended = false; paused = false;
      score = 0; lines = 0; level = 1; dropAcc = 0; das = 0;
      held.left = held.right = held.down = false;
      setScore(0);
      setStatus('Playing');
      spawn();
      live.textContent = 'New run. Level 1, score 0.';
    }
    function endRun() {
      if (ended) return; // exactly one gameOver() per run
      ended = true; over = true;
      held.left = held.right = held.down = false;
      if (bestEver === null || score > bestEver) { bestEver = score; writeBest(score); setBest(score); }
      live.textContent = 'Game over. Score ' + score + ', ' + lines + ' lines, level ' + level + '.';
      setStatus('Game over');
      gameOverCb(score);
    }

    /* --- Simulation step --- */
    function update(dt) {
      if (paused || over) return;
      // Auto-shift: the first step in a new direction is instant, then DAS
      // delays it once and ARR paces the repeats.
      var dir = held.left && !held.right ? -1 : (held.right && !held.left ? 1 : 0);
      if (dir !== das) { das = dir; if (dir) move(dir, 0); das = DAS; }
      else if (dir) { das -= dt; while (das <= 0) { move(dir, 0); das += ARR; } }
      var period = Math.max(MIN_MS, BASE_MS - (level - 1) * (BASE_MS - MIN_MS) / 14);
      if (held.down) period = SOFT_MS;
      dropAcc += dt;
      while (dropAcc >= period) {
        dropAcc -= period;
        if (move(0, 1)) { if (held.down) { score += DROP_SCORE; syncScore(); } }
        else { lockPiece(); return; }
      }
    }

    /* --- Rendering --- */
    function block(px, py, size, color, alpha, glow) {
      var inner = size - 4;
      if (glow) { ctx.shadowColor = hexA(color, alpha); ctx.shadowBlur = size * 0.5; }
      ctx.fillStyle = hexA(color, alpha);
      ctx.fillRect(px + 2, py + 2, inner, inner);
      if (glow) { // lit cells get a bright top bevel, settled ones stay flat
        ctx.fillStyle = hexA(color, Math.min(1, alpha + 0.3));
        ctx.fillRect(px + 2, py + 2, inner, Math.max(1, size * 0.16));
        ctx.shadowBlur = 0;
      }
    }
    function mini(p, cx, cy, u) { // side-panel thumbnail, always the spawn orientation
      var m, x, y;
      if (!p) return;
      m = ROT[p.k][0];
      for (y = 0; y < 4; y++) for (x = 0; x < 4; x++) {
        if (m[y][x]) block(cx - u * 2 + x * u, cy - u * 2 + y * u, u, C[TINT[TYPE[p.k]]], 0.85, true);
      }
    }
    function label(text, x, y, align, color, size) {
      ctx.font = '600 ' + size + 'px Rajdhani, system-ui, sans-serif';
      ctx.textAlign = align; ctx.textBaseline = 'middle'; ctx.fillStyle = color;
      ctx.fillText(text, x, y);
    }
    function rule(x1, y1, x2, y2) {
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }
    function draw(now) {
      var w = cssW, h = cssH, cell = L.cell, i, x, y, id, list, gy;
      ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);

      /* Well + faint grid */
      ctx.save();
      ctx.shadowColor = hexA(C.cyan, 0.5); ctx.shadowBlur = 24;
      ctx.fillStyle = 'rgba(255,255,255,.03)'; ctx.fillRect(L.ox, L.oy, L.bw, L.bh);
      ctx.shadowBlur = 0; ctx.strokeStyle = hexA(C.cyan, 0.35); ctx.lineWidth = 2;
      ctx.strokeRect(L.ox + 1, L.oy + 1, L.bw - 2, L.bh - 2);
      ctx.strokeStyle = 'rgba(255,255,255,.06)'; ctx.lineWidth = 1;
      for (x = 1; x < COLS; x++) rule(L.ox + x * cell + .5, L.oy, L.ox + x * cell + .5, L.oy + L.bh);
      for (y = 1; y < ROWS; y++) rule(L.ox, L.oy + y * cell + .5, L.ox + L.bw, L.oy + y * cell + .5);
      ctx.restore();

      /* Settled stack, then the ghost, then the live piece on top of them */
      for (y = 0; y < ROWS; y++) for (x = 0; x < COLS; x++) {
        id = grid[y * COLS + x];
        if (id) block(L.ox + x * cell, L.oy + y * cell, cell, C[TINT[id]], 0.55, false);
      }
      if (!over && cur) {
        gy = ghostY() - cur.y;
        for (var pass = 0; pass < 2; pass++) {
          var off = pass ? 0 : gy, alpha = pass ? 0.92 : 0.14;
          for (i = 0, list = cells(cur); i < list.length; i++) {
            x = list[i][0]; y = list[i][1] + off;
            if (y >= 0 && y < ROWS) block(L.ox + x * cell, L.oy + y * cell, cell, C[TINT[TYPE[cur.k]]], alpha, !!pass);
          }
        }
      }

      /* Side panel: NEXT, HOLD, then the readouts. Every vertical step is a
         multiple of `fs`, so the lines can never overlap however small `u` is. */
      var P = L.px + L.pw / 2, u = L.u, fs = L.fs, py = L.oy + fs;
      var stats = ['LEVEL ' + level, 'LINES ' + lines, String(score), 'BEST ' + (bestEver || 0)];
      var cols = [C.acid, C.dim, C.cyan, C.mute], szs = [fs, fs, fs * 1.3, fs * 0.85];
      label('NEXT', P, py, 'center', C.mute, fs);
      py += fs * 0.7 + u * 2; mini(next, P, py, u);
      py += u * 2 + fs * 0.8; label('HOLD', P, py, 'center', C.mute, fs);
      py += fs * 0.55;
      ctx.strokeStyle = hexA(hold ? C[TINT[TYPE[hold.k]]] : C.mute, 0.4); ctx.lineWidth = 1;
      ctx.strokeRect(P - L.pw * 0.4, py, L.pw * 0.8, u * 4.2);
      if (hold) mini(hold, P, py + u * 2.1, u);
      py += u * 4.2 + fs * 1.0;
      ctx.save(); ctx.shadowColor = hexA(C.cyan, 0.6); ctx.shadowBlur = 16;
      for (i = 0; i < stats.length; i++) label(stats[i], P, py + i * fs * 1.5, 'center', cols[i], szs[i]);
      ctx.restore();

      /* Clear toast — held steady instead of fading when motion is reduced */
      if (now < flashUntil) {
        ctx.save();
        ctx.globalAlpha = reduced ? 1 : clamp((flashUntil - now) / 260, 0, 1);
        ctx.shadowColor = hexA(C.acid, 0.9); ctx.shadowBlur = 26;
        label(flashText, L.ox + L.bw / 2, L.oy + L.bh * 0.4, 'center', C.acid, Math.max(14, cell * 1.1));
        ctx.restore();
      }

      /* CRT polish: scanlines + vignette, both static, so reduced-motion is safe */
      ctx.fillStyle = 'rgba(0,0,0,.16)';
      for (y = 0; y < h; y += 3) ctx.fillRect(0, y, w, 1);
      var vig = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.25, w / 2, h / 2, Math.max(w, h) * 0.75);
      vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(0,0,0,.72)');
      ctx.fillStyle = vig; ctx.fillRect(0, 0, w, h);

      /* Overlays last, so no decoration can hide them */
      if (over) overlay('GAME OVER', 'SCORE ' + score + ' · ' + lines + ' LINES · LEVEL ' + level,
                        C.magenta, 'Tap the field or press R to play again');
      else if (paused) overlay('PAUSED', 'Tap the field or press P to resume', C.cyan, null);
    }
    function overlay(title, sub, color, hint) {
      var big = Math.max(20, Math.round(cssH * 0.13));
      ctx.fillStyle = 'rgba(5,6,15,.82)'; ctx.fillRect(0, 0, cssW, cssH);
      ctx.save();
      ctx.shadowColor = hexA(color, 0.9); ctx.shadowBlur = 32;
      label(title, cssW / 2, cssH * 0.42, 'center', color, big);
      ctx.restore();
      label(sub, cssW / 2, cssH * 0.42 + big * 0.95, 'center', C.dim, Math.max(12, Math.round(cssH * 0.05)));
      /* the "play again" affordance belongs to the game-over overlay only —
         on a paused-but-alive run it told the player to throw their run away */
      if (hint) label(hint, cssW / 2, cssH * 0.82, 'center', C.mute, Math.max(11, Math.round(cssH * 0.042)));
    }

    /* --- Single rAF loop --- */
    function frame(now) {
      if (destroyed) return; // the shell may have torn us down mid-frame
      var dt = last ? Math.min(now - last, 100) : 16;
      last = now;
      update(dt);
      if (destroyed) return;
      draw(now);
      if (!destroyed) rafId = requestAnimationFrame(frame);
    }

    /* --- Input: keyboard + pointer --- */
    var KEYMAP = {
      ArrowLeft: 'left', ArrowRight: 'right', ArrowDown: 'down', ArrowUp: 'cw',
      KeyA: 'left', KeyD: 'right', KeyS: 'down', KeyW: 'cw', KeyX: 'cw', KeyZ: 'ccw',
      KeyC: 'hold', ShiftLeft: 'hold', ShiftRight: 'hold', Space: 'drop', ' ': 'drop',
      KeyP: 'pause', Escape: 'pause', KeyR: 'restart'
    };
    function press(name) {
      if (name === 'pause') { togglePause(); return; }   // always live, even when over/paused
      if (over) { if (name === 'restart') resetRun(); return; }
      /* While paused, nothing but R does anything — and crucially the
         held-direction flags are not set here, or a key still down at the
         moment of resume would auto-shift the frozen piece. */
      if (paused) { if (name === 'restart') resetRun(); return; }
      if (name === 'left' || name === 'right' || name === 'down') { held[name] = true; das = 0; return; }
      if (name === 'cw') rotate(1);
      else if (name === 'ccw') rotate(-1);
      else if (name === 'drop') hardDrop();
      else if (name === 'hold') doHold();
      else if (name === 'restart') resetRun();
    }
    function onKeyDown(e) {
      var a = document.activeElement, name;
      if (e.repeat) return; // our own DAS handles auto-repeat
      // Never steal keys from a control the shell may have focused.
      if (a && a !== canvas && /^(BUTTON|INPUT|SELECT|TEXTAREA|A|SUMMARY)$/.test(a.tagName)) return;
      name = KEYMAP[e.code] || KEYMAP[e.key];
      if (!name) return;
      e.preventDefault();
      press(name);
    }
    function onKeyUp(e) {
      var name = KEYMAP[e.code] || KEYMAP[e.key];
      if (name in held) held[name] = false;
    }
    function togglePause(force) {
      if (over) return;
      paused = (force === undefined) ? !paused : !!force;
      held.left = held.right = held.down = false;
      setStatus(paused ? 'Paused' : 'Playing');
      if (paused) live.textContent = 'Paused. Score ' + score + ', level ' + level + '.';
    }
    // Swipe moves the piece, a long swipe hard drops, a tap rotates — that is
    // the whole touch story, and it works anywhere on the field.
    function onDown(e) {
      if (e.button !== undefined && e.button !== 0) return;
      if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
      /* preventDefault() below suppresses the browser's own focus handling, so
         focus the canvas explicitly. Without this, a click on the field left
         document.activeElement on whatever HUD button was used before it and
         the keydown guard kept swallowing every game key. */
      try { if (canvas.focus) canvas.focus({ preventScroll: true }); } catch (err) { /* ignore */ }
      /* The hard-drop threshold is measured against the travel accumulated
         since the gesture began. `sw.y` is rebased on every move, so a
         one-move delta can never add up: on a 186px-tall phone canvas a flick
         arrives as many small moves and the old per-move test never fired. */
      sw = { x: e.clientX, y: e.clientY, id: e.pointerId, moved: false, resumed: false,
             drop: 0, dropAt: Math.max(40, cssH * 0.4) };
      if (over) resetRun();
      else if (paused) { sw.resumed = true; togglePause(false); } // tap resumes, as advertised
      e.preventDefault();
    }
    function onMove(e) {
      var dx, dy;
      if (!sw || e.pointerId !== sw.id || over) return;
      dx = e.clientX - sw.x; dy = e.clientY - sw.y;
      sw.drop += dy > 0 ? dy : 0; // total downward travel, not the last frame's slice
      if (Math.abs(dx) < 22 && Math.abs(dy) < 22) return;
      if (sw.drop >= sw.dropAt) { hardDrop(); sw.drop = 0; }
      else if (Math.abs(dx) > Math.abs(dy)) move(dx > 0 ? 1 : -1, 0);
      else if (dy > 0) move(0, 1);
      sw.moved = true; sw.x = e.clientX; sw.y = e.clientY;
    }
    function onUp(e) {
      if (!sw || e.pointerId !== sw.id) return;
      /* a tap that only resumed the run must not also rotate the piece */
      if (!sw.moved && !sw.resumed && !over) rotate(1);
      sw = null;
    }
    function onBlur() { togglePause(true); }
    function onFocus() { if (paused) togglePause(false); }

    on(canvas, 'pointerdown', onDown);
    on(canvas, 'pointermove', onMove);
    on(canvas, 'pointerup', onUp);
    on(canvas, 'pointercancel', onUp);
    on(document, 'keydown', onKeyDown);
    on(document, 'keyup', onKeyUp);
    on(window, 'resize', onResize, { passive: true });
    on(window, 'orientationchange', onResize);
    on(window, 'blur', onBlur);
    on(window, 'focus', onFocus);
    on(document, 'visibilitychange', function () { if (document.hidden) togglePause(true); });

    /* --- Boot --- */
    if (bestEver !== null) setBest(bestEver);
    setScore(0);
    resetRun();
    rafId = requestAnimationFrame(frame);

    /* --- Teardown --- */
    return {
      destroy: function () {
        var i, rec, parent;
        if (destroyed) return;
        destroyed = true;
        cancelAnimationFrame(rafId);
        if (ro) { ro.disconnect(); ro = null; }
        for (i = 0; i < listeners.length; i++) {
          rec = listeners[i];
          rec[0].removeEventListener(rec[1], rec[2], rec[3]);
        }
        listeners.length = 0;
        held.left = held.right = held.down = false;
        sw = null;
        parent = wrap.parentNode;
        if (parent && typeof parent.removeChild === 'function') parent.removeChild(wrap); // canvas + <style> together
        else if (typeof wrap.remove === 'function') wrap.remove();
      }
    };
  }

  /* --- Public module contract --- */
  window.PixelGame = {
    name: 'Blockfall',
    instructions:
      'Stack the falling tetrominoes to fill horizontal lines. Left/right (or A/D) moves, ' +
      'up (or W/X) rotates, down (or S) soft drops, SPACE hard drops, C holds the piece. ' +
      'The field speeds up every 10 lines. Score: 100/300/500/800 for clearing 1/2/3/4 lines ' +
      'at once, times your level, plus 2 per row dropped. You lose when a piece cannot spawn.',
    start: start
  };
})();
