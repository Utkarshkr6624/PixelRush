/**
 * PIXEL RUSH — games/snake.js — "Snake Neon"
 * Contract (SPEC.md): window.PixelGame = { name, instructions, start(root, api) } where
 * api = { setScore(n), setBest(n), gameOver(score) } and start() returns { destroy() }.
 * Self-contained: no imports, no dependencies, no assets — one <canvas> + 2D ctx, and
 * every rAF id and listener created in start() is torn down in destroy().
 */
(function () {
  'use strict';
  /* -------------------------------- Tuning -------------------------------- */
  var STORE_KEY = 'pixelrush.snake.best'; // localStorage: all-time best score
  var COLS = 21, ROWS = 21;      // square playfield, so it fits any aspect ratio
  var BASE_STEP = 132;           // ms per cell at level 0 …
  var STEP_FALLOFF = 7;          // … minus this per level, …
  var MIN_STEP = 64;             // … down to this floor so it stays playable
  var FOOD_PER_LEVEL = 3;        // speed up every N pellets
  var FOOD_POINTS = 10;          // score per pellet …
  var LEVEL_BONUS = 25;          // … plus a bonus per speed tier gained
  var TRAIL_MAX = 16;            // recent head cells kept for the glow trail
  var BOARD_FILL = 0.94;         // board as a fraction of the shortest side
  var FLICK = 24;                // px of swipe needed to steer
  var REG_KEY = '__pixelrush_snake_live'; // window handle to the live instance (see start)
  var DIRS = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
  var KEYS = { ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right' };
  // Everything the spec does not name, prefixed `sn-` so it cannot collide with
  var STYLES = '.sn{position:relative;width:100%;height:100%;overflow:hidden;touch-action:none;' +
    'user-select:none;-webkit-tap-highlight-color:transparent;' +
    'font-family:var(--font-body,"Rajdhani",system-ui,sans-serif);color:var(--ink,#f2f5ff)}' +
    '.sn canvas{display:block;width:100%;height:100%;outline:none}';
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function randInt(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
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
    /* One board only. The shell mounts asynchronously, so a double-clicked RESTART
       can leave two starts in flight — the first is never handed to the shell and so
       never destroyed. Retire the current board first. The handle sits on `window`
       because the shell re-injects this file for the second start (fresh closure). */
    var prev = window[REG_KEY];
    if (prev && typeof prev.destroy === 'function') { try { prev.destroy(); } catch (e) { /* never block a start */ } }
    Array.prototype.slice.call(root.querySelectorAll('.sn')).forEach(function (node) {
      if (node.parentNode) node.parentNode.removeChild(node);
    });
    var setScore   = typeof api.setScore === 'function'  ? api.setScore  : function () {};
    var setBest    = typeof api.setBest === 'function'   ? api.setBest   : function () {};
    var gameOverCb = typeof api.gameOver === 'function' ? api.gameOver : function () {};
    /* -------------------------------- DOM -------------------------------- */
    var wrap = document.createElement('div'); wrap.className = 'sn';
    var canvas = document.createElement('canvas');
    canvas.setAttribute('tabindex', '0'); canvas.setAttribute('role', 'application');
    canvas.setAttribute('aria-label', 'Snake Neon board. Arrow keys or WASD to turn; swipe on touch.');
    var live = document.createElement('div'); // screen-reader announcements
    live.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0)';
    live.setAttribute('aria-live', 'polite');
    wrap.appendChild(canvas); wrap.appendChild(live);
    var styleTag = document.createElement('style');
    styleTag.textContent = STYLES; wrap.appendChild(styleTag); root.appendChild(wrap); // one <style>, scoped to .sn
    var ctx = canvas.getContext('2d');
    if (!ctx) { root.removeChild(wrap); return { destroy: function () {} }; }
    var rafId = 0, destroyed = false;
    var reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    var snake = [];               // [{x,y}] — head first
    var dir = { x: 1, y: 0 }, queue = [], food = { x: 0, y: 0 }, trail = [];
    var acc = 0, last = 0;        // fixed-timestep accumulator
    var score = 0, foodEaten = 0, level = 0, bestEver = readBest();
    var booted = false, started = false, isRecord = false, paused = false, flashAt = -1e9; // 1st run waits for a tap
    // `started` = the player has engaged THIS run (a turn or a tap). The pause card
    // keys off it, not off the score: `foodEaten` is still 0 for the first stretch.
    var over = false;   // hard guard: api.gameOver() may fire exactly once per run
    /* ----------------- Sizing (crisp devicePixelRatio) ----------------- */
    var dpr = 1, cssW = 1, cssH = 1, cell = 10, bx = 0, by = 0;
    function resize() {
      var r = wrap.getBoundingClientRect();
      cssW = Math.max(1, Math.round(r.width)); cssH = Math.max(1, Math.round(r.height));
      dpr = clamp(window.devicePixelRatio || 1, 1, 3); // cap DPR: fill-rate win on 3x phones
      canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
      canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Letterbox the square board into whatever aspect ratio the stage has. The grid
      // stays square, so the short side caps it; fill nearly all of that side so the
      // board is not squeezed down to a strip on a short, wide (phone) stage.
      cell = Math.max(4, Math.floor(Math.min(cssW, cssH) * BOARD_FILL / COLS));
      bx = Math.round((cssW - cell * COLS) / 2); by = Math.round((cssH - cell * ROWS) / 2);
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
    function mix(a, b, t) { // blend two #rrggbb colours — the body gradient
      var A = parseInt(a.replace('#', ''), 16), B = parseInt(b.replace('#', ''), 16), o = '';
      for (var i = 16; i >= 0; i -= 8) o += (i === 8 ? ',' : '') + Math.round(((A >> i) & 255) + (((B >> i) & 255) - ((A >> i) & 255)) * t);
      return 'rgb(' + o + ')';
    }
    function rr(x, y, w, h, r) { // rounded-rect path, with a pre-roundRect fallback
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h); }
    /* ---------------------------- Game logic ---------------------------- */
    function occupied(x, y, limit) { for (var i = 0; i < limit; i++)
      if (snake[i].x === x && snake[i].y === y) return true; return false; }
    function placeFood() {             // pick a uniformly random free cell
      var free = [];
      for (var y = 0; y < ROWS; y++) for (var x = 0; x < COLS; x++) {
        if (!occupied(x, y, snake.length)) free.push({ x: x, y: y });
      }
      if (!free.length) return false;   // board full — the run was perfect
      food = free[randInt(0, free.length - 1)];
      return true;
    }
    function resetRun() {
      snake = [];
      for (var i = 4; i >= 0; i--) snake.push({ x: 6 + i, y: 10 }); // head at x:10
      dir = { x: 1, y: 0 }; queue.length = 0; trail.length = 0;
      score = 0; foodEaten = 0; level = 0; acc = 0; last = performance.now();
      isRecord = false; over = false; paused = !booted; booted = true; started = false;
      placeFood(); setScore(0);
      if (bestEver !== null) setBest(bestEver);
      live.textContent = 'New run. Score 0.';
    }
    /** Queue a turn, rejecting any 180° reversal against the pending direction. */
    function turn(d) {
      if (destroyed || over) return;
      paused = false; started = true;
      var prev = queue.length ? queue[queue.length - 1] : dir;
      if (d.x === -prev.x && d.y === -prev.y) return; // no instant reverse
      if (d.x === prev.x && d.y === prev.y) return;    // already heading there
      if (queue.length < 2) queue.push(d);              // buffered, so fast corners land
    }
    function step() {
      if (queue.length) dir = queue.shift();
      var h = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
      // Walls WRAP: leave one edge, slide in on the other. No wall deaths.
      if (h.x < 0) h.x = COLS - 1; else if (h.x >= COLS) h.x = 0;
      if (h.y < 0) h.y = ROWS - 1; else if (h.y >= ROWS) h.y = 0;
      var grow = (h.x === food.x && h.y === food.y);
      // The tail vacates its cell on a normal step, so moving into it stays legal.
      if (occupied(h.x, h.y, grow ? snake.length : snake.length - 1)) { die(false); return; }
      snake.unshift(h);
      if (!grow) snake.pop();
      trail.unshift({ x: h.x, y: h.y, t: performance.now() });
      if (trail.length > TRAIL_MAX) trail.length = TRAIL_MAX;
      if (!grow) return;
      foodEaten++; score += FOOD_POINTS;
      var lvl = Math.floor(foodEaten / FOOD_PER_LEVEL);
      if (lvl > level) { level = lvl; score += LEVEL_BONUS; flashAt = performance.now(); }
      setScore(score);
      live.textContent = 'Score ' + score + '. Length ' + snake.length + '.';
      if (bestEver === null || score > bestEver) {
        bestEver = score; isRecord = true; writeBest(score); setBest(score);
      }
      if (!placeFood()) die(true);  // board full: nothing left to dodge
    }
    function die(perfect) {
      if (over || destroyed) return;   // api.gameOver() may only fire once per run
      live.textContent = (perfect ? 'Board filled. ' : 'Ran into yourself. ') + 'Final score ' + score + '.';
      over = true; paused = false; gameOverCb(score);
    }
    /** Centred overlay: big neon title, one dim line of sub-copy, optional hint. */
    function card(title, sub, color, hint) {
      ctx.fillStyle = hexA(C.bg, 0.72); ctx.fillRect(0, 0, cssW, cssH);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '900 ' + Math.round(clamp(cssH * 0.14, 22, 64)) + 'px Orbitron, system-ui, sans-serif';
      ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 28;
      ctx.fillText(title, cssW / 2, cssH * 0.42); ctx.shadowBlur = 0;
      ctx.font = '600 ' + Math.round(clamp(cssH * 0.05, 12, 22)) + 'px Rajdhani, system-ui, sans-serif';
      ctx.fillStyle = C.dim; ctx.fillText(sub, cssW / 2, cssH * 0.5);
      if (hint) ctx.fillText(hint, cssW / 2, cssH * 0.61);   // e.g. the restart affordance
    }
    function draw(now) {
      var w = cssW, h = cssH, bw = cell * COLS, bh = cell * ROWS, r = Math.min(18, cell);
      ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);
      // Playfield plate + grid, with the fading head-trail clipped inside it.
      ctx.save();
      rr(bx, by, bw, bh, r); ctx.fillStyle = 'rgba(255,255,255,.03)'; ctx.fill(); ctx.clip();
      ctx.strokeStyle = hexA(C.cyan, 0.07); ctx.lineWidth = 1; ctx.beginPath();
      for (var g = 1; g < COLS; g++) { ctx.moveTo(bx + g * cell, by); ctx.lineTo(bx + g * cell, by + bh); }
      for (var k = 1; k < ROWS; k++) { ctx.moveTo(bx, by + k * cell); ctx.lineTo(bx + bw, by + k * cell); }
      ctx.stroke();
      for (var t = 0; !reduced && t < trail.length; t++) {   // decorative bloom trail
        var age = (now - trail[t].t) / 420;
        if (age > 1) break;
        var tx = bx + (trail[t].x + 0.5) * cell, ty = by + (trail[t].y + 0.5) * cell;
        var gr = ctx.createRadialGradient(tx, ty, 0, tx, ty, cell);
        gr.addColorStop(0, hexA(C.magenta, 0.2 * (1 - age))); gr.addColorStop(1, hexA(C.magenta, 0));
        ctx.fillStyle = gr; ctx.fillRect(tx - cell, ty - cell, cell * 2, cell * 2);
      }
      ctx.restore();
      ctx.save(); rr(bx, by, bw, bh, r);  // neon frame around the plate
      ctx.strokeStyle = hexA(C.cyan, 0.28); ctx.lineWidth = 2; ctx.shadowColor = hexA(C.cyan, 0.6);
      ctx.shadowBlur = 16; ctx.stroke(); ctx.restore();
      if (food) {  // acid orb, pulsing, hard glow
        var beat = reduced ? 1 : 0.85 + 0.15 * Math.sin(now / 240);
        var fx = bx + (food.x + 0.5) * cell, fy = by + (food.y + 0.5) * cell;
        ctx.save(); ctx.shadowColor = hexA(C.acid, 0.95); ctx.shadowBlur = 24; ctx.fillStyle = C.acid;
        ctx.beginPath(); ctx.arc(fx, fy, cell * 0.3 * beat, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      }
      var n = snake.length;   // body: dim violet tail -> bright cyan head, soft glow
      for (var i = n - 1; i >= 0; i--) {
        var p = n > 1 ? i / (n - 1) : 0, head = i === 0, pd = cell * (head ? 0.1 : 0.16);
        ctx.save();
        ctx.shadowColor = head ? C.cyan : C.violet;
        ctx.shadowBlur = (head ? 22 : 12) * (reduced ? 0.4 : 1);
        ctx.fillStyle = head ? C.cyan : mix(C.cyan, C.violet, Math.pow(p, 0.7));
        ctx.globalAlpha = head ? 1 : 1 - p * 0.5;
        rr(bx + snake[i].x * cell + pd, by + snake[i].y * cell + pd, cell - pd * 2, cell - pd * 2, cell * 0.28);
        ctx.fill(); ctx.restore();
      }
      // Head: a distinct acid core plus a visor that looks where it is going.
      var hx = bx + snake[0].x * cell, hy = by + snake[0].y * cell, cp = cell * 0.2, o = cell * 0.15;
      var ex = hx + cell * (0.5 + dir.x * 0.18), ey = hy + cell * (0.5 + dir.y * 0.18);
      ctx.save();
      ctx.shadowColor = C.acid; ctx.shadowBlur = 26; ctx.fillStyle = hexA(C.acid, 0.92);
      rr(hx + cp, hy + cp, cell - cp * 2, cell - cp * 2, cell * 0.3); ctx.fill();
      ctx.shadowBlur = 0; ctx.fillStyle = C.bg; ctx.beginPath();
      ctx.arc(ex - dir.y * o, ey - dir.x * o, cell * 0.075, 0, Math.PI * 2);
      ctx.arc(ex + dir.y * o, ey + dir.x * o, cell * 0.075, 0, Math.PI * 2);
      ctx.fill(); ctx.restore();
      // CRT polish: scanlines + vignette over the WORLD only — the HUD is drawn
      // after this so its text is not darkened into illegibility.
      if (!reduced) { ctx.fillStyle = 'rgba(0,0,0,.16)';
        for (var sy = 0; sy < h; sy += 3) ctx.fillRect(0, sy, w, 1); }
      var vig = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75);
      vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(0,0,0,.55)');
      ctx.fillStyle = vig; ctx.fillRect(0, 0, w, h);
      // HUD (above the CRT overlay): score, level (flaring on a speed-up), best.
      // A dark shadow keeps the text legible wherever it lands on the world.
      var fs = Math.round(clamp(h * 0.045, 11, 18)), top = Math.max(14, by * 0.5);
      ctx.save();
      ctx.font = '700 ' + fs + 'px Rajdhani, system-ui, sans-serif';
      ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      ctx.shadowColor = 'rgba(0,0,0,.9)'; ctx.shadowBlur = 4; ctx.shadowOffsetY = 1;
      ctx.fillStyle = C.ink; ctx.fillText('SCORE ' + score, Math.max(10, bx), top);
      ctx.textAlign = 'right'; ctx.fillStyle = C.dim; ctx.fillText('BEST ' + (bestEver || 0), Math.min(w - 10, bx + bw), top);
      if (level > 0) {
        ctx.textAlign = 'center'; ctx.fillStyle = now - flashAt < 260 ? C.acid : C.orange;
        ctx.fillText('LEVEL ' + level, w / 2, top);
      }
      ctx.restore();
      // `started`, not `foodEaten`: READY is the "no input yet" state, so a pause
      // before the first orb still reads PAUSED.
      if (paused && !over) card(started ? 'PAUSED' : 'READY', started ? 'Tap or press a key to resume' : 'Tap, swipe or press a key to start', C.cyan, null);
      if (over) card('GAME OVER', 'SCORE ' + score + (isRecord ? '  ·  NEW BEST' : ''), C.magenta, 'TAP or press SPACE to play again');
    }
    /* -------------------------- Single rAF loop -------------------------- */
    function frame(now) {
      if (destroyed) return;   // guard: destroy() can land between frames
      var dt = Math.min(200, now - last); // clamp so a backgrounded tab can't fast-forward
      last = now;
      if (!paused && !over) {
        acc += dt;
        var sm = Math.max(MIN_STEP, BASE_STEP - STEP_FALLOFF * level), guard = 0;
        while (acc >= sm && !over && !destroyed && guard++ < 4) { acc -= sm; step(); }
        if (over) acc = 0;
      }
      draw(now);
      rafId = requestAnimationFrame(frame);
    }
    /* ------------------- Input: keyboard + swipe ------------------- */
    // Turns steer a live run and are ignored once it is dead: restarting is
    // Space / tap / PLAY AGAIN, so an arrow key cannot slip a new run in behind
    // the shell's still-visible ROUND OVER card.
    function act(d) { if (!over) turn(d); }
    function onKeyDown(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === 'Space' || e.code === 'Enter' || e.key === ' ') {  // pause / restart
        // Never steal Space/Enter from a real control; the arrows always steer.
        var a = document.activeElement;
        if (a && a !== canvas && /^(BUTTON|INPUT|SELECT|TEXTAREA|A|SUMMARY)$/.test(a.tagName)) return;
        e.preventDefault();
        if (over) resetRun(); else paused = !paused;
        return;
      }
      var d = KEYS[e.code] || KEYS[e.key];
      if (d) { e.preventDefault(); act(DIRS[d]); }
    }
    var sx = 0, sy = 0, swiping = false;
    function onPointerDown(e) {
      if (e.button !== undefined && e.button !== 0) return;
      sx = e.clientX; sy = e.clientY; swiping = true;
      if (over) resetRun(); else { paused = false; started = true; } // tap: restart a dead run, else start/resume
      if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
    }
    function onPointerUp(e) { // a FLICK-px drag anywhere on the board steers
      if (!swiping) return;
      swiping = false;
      var dx = e.clientX - sx, dy = e.clientY - sy;   // swipe, not tap: taps only unpause
      if (Math.abs(dx) < FLICK && Math.abs(dy) < FLICK) return;
      act(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? DIRS.right : DIRS.left) : (dy > 0 ? DIRS.down : DIRS.up));
    }
    function onPointerCancel() { swiping = false; }
    function onResize() { if (!destroyed) resize(); }
    function onBlur() { if (!destroyed && !over) paused = true; }   // auto-pause on focus loss
    function onVisibility() { if (document.hidden) onBlur(); }
    // Every listener the game owns, in one table so teardown cannot miss one.
    var BIND = [[document, 'keydown', onKeyDown], [canvas, 'pointerdown', onPointerDown],
      [canvas, 'pointerup', onPointerUp], [canvas, 'pointercancel', onPointerCancel],
      [window, 'resize', onResize, { passive: true }], [window, 'orientationchange', onResize],
      [window, 'blur', onBlur], [document, 'visibilitychange', onVisibility]];
    BIND.forEach(function (b) { b[0].addEventListener(b[1], b[2], b[3]); });
    var instance = {
      destroy: function () {
        if (destroyed) return;
        destroyed = true; cancelAnimationFrame(rafId);
        BIND.forEach(function (b) { b[0].removeEventListener(b[1], b[2], b[3]); });
        if (window[REG_KEY] === instance) window[REG_KEY] = null;
        var parent = wrap.parentNode;
        // Removing the wrapper drops the canvas, the live region and the <style> together.
        if (parent && typeof parent.removeChild === 'function') parent.removeChild(wrap);
        else if (typeof wrap.remove === 'function') wrap.remove();
      }
    };
    window[REG_KEY] = instance;
    resetRun(); rafId = requestAnimationFrame(frame);
    return instance;
  }

  /* ---------------------- Public module contract ---------------------- */
  window.PixelGame = {
    name: 'Snake Neon',
    instructions:
      'Steer with ARROW KEYS or WASD — no instant 180° reversals, so brake before you turn back ' +
      'on yourself. The walls WRAP: leave one edge and you slide in on the other, so the only ' +
      'thing that can kill you is your own tail. Eat the acid orbs for +10 and the snake grows; ' +
      'every 3 orbs raises a level, shaves 7ms off the step and pays a +25 bonus. Swipe to steer ' +
      'on touch. SPACE pauses. Best score is saved on this device.',
    start: start
  };
})();
