/**
 * PIXEL RUSH — games/pacman.js — "Neon Pac", a grid maze chase.
 * Contract: window.PixelGame = { name, instructions, start(root, api) -> { destroy() } }
 * api = { setScore(n), setBest(n), gameOver(score) }. No imports, no deps, no assets:
 * one <canvas> + 2D ctx; every rAF id and listener dies in destroy().
 */
(function () {
  'use strict';
  /* -------------------------------- Tuning -------------------------------- */
  var NAME = 'Neon Pac';
  var STORE_KEY = 'pixelrush.pacman.best';   /* must match the shell's key: pixelrush.<slug>.best */
  var COLS = 21, ROWS = 21, LIVES_MAX = 3;      // the maze is square, so it letterboxes into any stage
  var P_PTS = 10, P_PTS_BIG = 50, FRUIT_BASE = 100, FRUIT_STEP = 50, FRUIT_CAP = 500;
  var EAT = [200, 400, 800, 1600];             // value per ghost inside one power pellet
  // The player is ALWAYS faster than any ghost, so every trap has an exit.
  var BASE_PLAYER = 6.4, PLAYER_STEP = 0.15, PLAYER_CAP = 7.3;
  var BASE_GHOST = 5.2, GHOST_STEP = 0.2, GHOST_CAP = 6.35, FRIGHT_SLOW = 3.1;
  var FRIGHT_BASE = 8, FRIGHT_STEP = 0.5, FRIGHT_MIN = 2.6;
  var RESPAWN_WAIT = 1.1, DEATH_MS = 1150, FRUIT_MS = 9, FRUIT_EVERY = 70, REL = [0, 3, 7, 12];
  var SPAWN_X = 9, SPAWN_Y = 14;               // player start, facing left
  var HOUSE = [[6, 10], [7, 10], [13, 10], [14, 10]];        // Blaze, Vector, Drift, Ember
  var DOOR = { x: 10, y: 10 }, HOUSE_Y = 10, TURN_TOL = 0.34, FLICK = 22;
  var PAC_R = 0.46, WALL_GAP = 0.5 + PAC_R, HIT_R2 = 0.32;     // body radius, wall stop, hit radius squared
  var DIRS = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
  var KEYS = { ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right' };
  function frightMax(l) { return Math.max(FRIGHT_MIN, FRIGHT_BASE - FRIGHT_STEP * (l - 1)); }
  // '#' wall, 'P' power pellet, 'o' ghost-house door. Every other tile starts with a pellet.
  var MAZE = [
    '#####################', '#P........#........P#', '#.###.###.#.###.###.#', '#.........#.........#',
    '#.###.###.#.###.###.#', '#.....#...#...#.....#', '#.#.#####...#####.#.#', '#.........#.........#',
    '#.###.###...###.###.#', '##.######...######.##', '##.##...#.o.#...##.##', '##.####...#...####.##',
    '#.........#.........#', '#.###.###...###.###.#', '#...................#', '#.###.###.#.###.###.#',
    '#.#.#.#.#.#.#.#.#.#.#', '#.#...#...#...#...#.#', '#.###.###...###.###.#', '#P..................#',
    '#####################'];
  // Four personalities, one each. BLAZE hunts your tile, VECTOR cuts you off ahead, the rest wander.
  var GHOSTS = [{ name: 'BLAZE', color: 'orange' }, { name: 'VECTOR', color: 'magenta', aim: 4 },
    { name: 'DRIFT', color: 'violet' }, { name: 'EMBER', color: 'acid' }];
  var FRUIT_SPOTS = [[10, 13], [10, 19]];
  var FAVOR = [[1, 1], [COLS - 2, 1], [1, ROWS - 2], [COLS - 2, ROWS - 2]];
  var FALLBACK = { bg: '#05060f', ink: '#f2f5ff', dim: '#a7b0d0', cyan: '#22e7ff', magenta: '#ff2fb9',
    acid: '#c8ff2e', violet: '#8b5cf6', orange: '#ff8a3d' };
  // `pac-` prefixed and scoped to the wrapper this file creates, so it cannot collide with the site CSS.
  var STYLES = '.pac{position:relative;width:100%;height:100%;overflow:hidden;user-select:none;touch-action:none;' +
    '-webkit-user-select:none;-webkit-tap-highlight-color:transparent;color:var(--ink,#f2f5ff)}' +
    '.pac canvas{display:block;width:100%;height:100%;touch-action:none;cursor:pointer;outline:none}' +
    '.pac__sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;clip:rect(0 0 0 0);overflow:hidden}' +
    '.pac__pad{position:absolute;left:2%;bottom:3%;display:grid;grid-template-columns:repeat(3,var(--pd,42px));' +
    'grid-template-rows:repeat(3,var(--pd,42px));gap:2px;opacity:.9}' +
    '.pac__pad b{width:var(--pd,42px);height:var(--pd,42px);display:flex;align-items:center;justify-content:center;' +
    'border:1px solid rgba(34,231,255,.55);border-radius:9px;background:rgba(5,6,15,.6);color:var(--cyan,#22e7ff);' +
    'font:700 18px/1 system-ui,sans-serif;padding:0;margin:0;touch-action:none;cursor:pointer}';
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function readBest() {
    try { var v = parseInt(window.localStorage.getItem(STORE_KEY), 10); return isFinite(v) && v > 0 ? v : 0; }
    catch (e) { return 0; } }                        // private mode / disabled storage
  function writeBest(n) { try { window.localStorage.setItem(STORE_KEY, String(n)); } catch (e) { /* ignore */ } }
  /** start(root, api) — build the game inside `root` and return { destroy }. */
  function start(root, api) {
    api = api || {};
    var setScore = typeof api.setScore === 'function' ? api.setScore : function () {};
    var setBest = typeof api.setBest === 'function' ? api.setBest : function () {};
    var overCb = typeof api.gameOver === 'function' ? api.gameOver : function () {};
    var mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    var reduced = !!(window.PX && window.PX.reduced) || !!(mq && mq.matches);
    var wrap = document.createElement('div'); wrap.className = 'pac';
    var canvas = document.createElement('canvas');
    canvas.setAttribute('tabindex', '0'); canvas.setAttribute('role', 'application');
    canvas.setAttribute('aria-label', 'Neon Pac maze. Arrow keys, WASD, swipe or the on-screen pad steer. Space pauses.');
    var live = document.createElement('div'); live.className = 'pac__sr'; live.setAttribute('aria-live', 'polite');
    var styleTag = document.createElement('style'); styleTag.textContent = STYLES;
    // Thumb-reachable D-pad as DOM, so it stays crisp and legible on a 390px phone.
    var pad = document.createElement('div'); pad.className = 'pac__pad'; pad.setAttribute('aria-hidden', 'true');
    [['up', '↑', 2], ['left', '←', 4], ['down', '↓', 8], ['right', '→', 6]].forEach(function (p) {
      var b = document.createElement('b'); b.textContent = p[1]; b.style.gridArea = p[2]; b.dataset.dir = p[0]; pad.appendChild(b);
    });
    wrap.appendChild(styleTag); wrap.appendChild(canvas); wrap.appendChild(live); wrap.appendChild(pad);
    root.appendChild(wrap);
    var ctx = canvas.getContext('2d');
    if (!ctx) { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); return { destroy: function () {} }; }
    var listeners = [];
    function on(t, type, fn) { t.addEventListener(type, fn); listeners.push([t, type, fn]); }
    /* ---- Sizing: crisp devicePixelRatio, capped at 2 for 3x phones ---- */
    var dpr = 1, cssW = 1, cssH = 1, cell = 10, bx = 0, by = 0;
    function resize() {
      var r = wrap.getBoundingClientRect();
      cssW = Math.max(1, Math.round(r.width)); cssH = Math.max(1, Math.round(r.height));
      dpr = clamp(window.devicePixelRatio || 1, 1, 2);
      canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
      canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Square maze: the short side caps the cell and it is centred on BOTH axes, so portrait phones
      // and landscape desktops both letterbox cleanly without stretch or overflow.
      cell = Math.max(4, Math.floor(Math.min(cssW * 0.96 / COLS, cssH * 0.80 / ROWS)));
      bx = Math.round((cssW - cell * COLS) / 2); by = Math.round(Math.max(cssH * 0.11, (cssH - cell * ROWS) / 2));
      pad.style.setProperty('--pd', Math.round(clamp(Math.min(cssW, cssH) * 0.13, 26, 54)) + 'px');
    }
    resize();
    var C = {};                                       // site tokens, with hard fallbacks
    Object.keys(FALLBACK).forEach(function (k) {
      var v = getComputedStyle(document.documentElement).getPropertyValue('--' + k); C[k] = (v && v.trim()) || FALLBACK[k];
    });
    function hexA(hex, a) {
      hex = (hex || '#fff').trim().replace('#', '');
      if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
      var n = parseInt(hex, 16);
      return isFinite(n) ? 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')' : 'rgba(255,255,255,' + a + ')';
    }
    function walkable(x, y) { return x >= 0 && y >= 0 && x < COLS && y < ROWS && MAZE[y].charAt(x) !== '#'; }
    /* ----------------------------- Game state ----------------------------- */
    var rafId = 0, destroyed = false, over = false;    // `over` latches api.gameOver()
    var state = 'ready';                              // ready | play | dying | over
    var paused = false, started = false, prevTime = 0, elapsed = 0, score = 0, best = readBest();
    var lives = LIVES_MAX, level = 1, pellets = 0, board = [], ghost = [], fruit = null, fruitT = 0, nextFruit = FRUIT_EVERY;
    var px = SPAWN_X, py = SPAWN_Y, ptx = SPAWN_X, pty = SPAWN_Y, dir = DIRS.left, want = null;
    var grace = 0, deathT = 0, frightT = 0, chainIdx = 0, flashAt = -1e9, isRecord = false;
    function nowMs() { return elapsed * 1000; }       // one clock, in ms, for every flash and beat
    function fillBoard() {                             // fresh pellet layer for the current level
      board = [];
      for (var y = 0; y < ROWS; y++) { board.push([]);
        for (var x = 0; x < COLS; x++) { var c = MAZE[y].charAt(x); board[y].push(c === '#' || c === 'o' ? 0 : (c === 'P' ? 2 : 1)); } }
    }
    function makeGhost(i) {
      return { i: i, name: GHOSTS[i].name, color: C[GHOSTS[i].color], home: HOUSE[i], x: HOUSE[i][0], y: HOUSE_Y,
        dir: DIRS.up, out: false, door: false, eaten: 0, wob: i * 1.6,
        wait: Math.max(0.4, (REL[i] - (level - 1) * 2.2) * Math.pow(0.86, level - 1)) };
    }
    function resetActors(keepScore) {
      px = SPAWN_X; py = SPAWN_Y; ptx = SPAWN_X; pty = SPAWN_Y; dir = DIRS.left; want = null; grace = 1.6;
      frightT = 0; chainIdx = 0; fruit = null; fruitT = 0; state = 'play'; paused = false;
      ghost = [0, 1, 2, 3].map(makeGhost);
      if (!keepScore) { score = 0; lives = LIVES_MAX; level = 1; pellets = 0; isRecord = false; setScore(0); }
      nextFruit = pellets + FRUIT_EVERY;    // after the reset, or a restart inherits the old threshold
    }
    function award(n) {
      score += n; setScore(score);
      if (score > best) { best = score; isRecord = true; writeBest(score); setBest(score); }
    }
    /* ---------------------------- Movement ---------------------------- */
    // Smooth, not tile-by-tile. A queued heading is only committed when the perpendicular axis is
    // lined up with a tile centre, and the axis we are NOT travelling along always drifts back onto
    // its centreline — without that, a wall stop followed by a turn leaves the new perpendicular
    // 0.46 off centre and the player is wedged for good. Wall stops halt the BODY at the face, which
    // keeps Math.round() on the player's own tile.
    function playerStep(dt) {
      var sp = Math.min(PLAYER_CAP, BASE_PLAYER + PLAYER_STEP * (level - 1)) * dt, tx = Math.round(px), ty = Math.round(py);
      var ahead = dir.x ? walkable(tx + dir.x, ty) : walkable(tx, ty + dir.y);
      if (want && walkable(tx + want.x, ty + want.y)) {
        var perp = dir.x ? py : px, along = dir.x ? px : py;
        if (Math.abs(perp - Math.round(perp)) <= TURN_TOL && (ahead || Math.abs(along - Math.round(along)) <= TURN_TOL)) {
          var k = Math.min(1, dt * 26);
          px += (Math.round(px) - px) * k; py += (Math.round(py) - py) * k;
          dir = want; want = null; tx = Math.round(px); ty = Math.round(py);
        }
      }
      var nx = px + dir.x * sp, ny = py + dir.y * sp, cx = Math.round(nx), cy = Math.round(ny);
      if (walkable(cx, cy)) { px = nx; py = ny; }
      else if (dir.x) px = dir.x > 0 ? cx - WALL_GAP : cx + WALL_GAP;
      else py = dir.y > 0 ? cy - WALL_GAP : cy + WALL_GAP;
      if (dir.x) py += (Math.round(py) - py) * Math.min(1, dt * 20); else px += (Math.round(px) - px) * Math.min(1, dt * 20);
      tx = Math.round(px); ty = Math.round(py);
      if (tx !== ptx || ty !== pty) { ptx = tx; pty = ty; eatAt(ptx, pty); }
    }
    function eatAt(x, y) {
      var v = board[y][x], left = false;
      if (!v) return;
      board[y][x] = 0; pellets++;
      if (v === 1) award(P_PTS);
      else { award(P_PTS_BIG); frightT = frightMax(level); chainIdx = 0; flashAt = nowMs();
        live.textContent = 'Power pellet. The ghosts are edible.'; }
      if (pellets >= nextFruit) { nextFruit = pellets + FRUIT_EVERY;
        fruit = FRUIT_SPOTS[(Math.random() * FRUIT_SPOTS.length) | 0]; fruitT = FRUIT_MS; }
      if (pellets % 25 === 0) live.textContent = 'Score ' + score + '.';
      for (var y = 0; y < ROWS && !left; y++) for (var x = 0; x < COLS; x++) if (board[y][x]) { left = true; break; }
      if (!left) { level++; fillBoard(); resetActors(true); award(level * 50); flashAt = nowMs();
        live.textContent = 'Level ' + level + '. The ghosts are faster.'; }
    }
    /* ------------------------------ Ghosts ------------------------------ */
    function ghostTarget(g) {
      var tx, ty, f;
      if (g.i === 0) { tx = Math.round(px); ty = Math.round(py); }
      else if (g.i === 1) { tx = Math.round(px + dir.x * GHOSTS[1].aim); ty = Math.round(py + dir.y * GHOSTS[1].aim); }
      else if (elapsed % 3 < 1.6) { f = FAVOR[(g.i * 3 + level) % 4]; tx = f[0]; ty = f[1]; }
      else { tx = 1 + ((Math.random() * (COLS - 2)) | 0); ty = 1 + ((Math.random() * (ROWS - 2)) | 0); }
      return { x: clamp(tx, 0, COLS - 1), y: clamp(ty, 0, ROWS - 1) };
    }
    function ghostSpeed() {
      var base = Math.min(GHOST_CAP, BASE_GHOST + GHOST_STEP * (level - 1));
      if (frightT > 0) return Math.min(base, FRIGHT_SLOW);   // frightened ghosts are slower: catchable
      return grace > 0 ? base * 0.55 : base;                 // nothing can touch you for 1.6s after a life
    }
    // Ghosts walk centre-to-centre: leftover distance is carried across as many junctions as it
    // covers, and a heading is only chosen when one is actually crossed.
    function ghostStep(g, dt) {
      if (g.eaten > 0) { g.eaten -= dt; if (g.eaten <= 0) placeInHouse(g); return; }
      if (!g.out) {                                          // bob in the house until released
        if (g.wait > 0) { g.wait -= dt; g.wob += dt * 4; g.x = g.home[0] + Math.sin(g.wob) * 0.4; return; }
        g.out = true; g.door = true; g.dir = DIRS.up; g.x = DOOR.x; g.y = HOUSE_Y;   // slide to the door
      }
      var rem = ghostSpeed() * dt, cx, cy, need, guard = 0;
      while (rem > 1e-4 && guard++ < 4) {
        cx = Math.round(g.x); cy = Math.round(g.y);
        need = g.dir.x ? (g.dir.x > 0 ? cx + 0.5 - g.x : g.x - (cx - 0.5))
                       : (g.dir.y > 0 ? cy + 0.5 - g.y : g.y - (cy - 0.5));
        if (need <= 1e-4) { chooseGhostDir(g); g.x += g.dir.x * rem; g.y += g.dir.y * rem; break; }
        if (need > rem) { g.x += g.dir.x * rem; g.y += g.dir.y * rem; break; }
        g.x = cx + g.dir.x * 0.5; g.y = cy + g.dir.y * 0.5;    // land dead on the junction
        rem -= need; chooseGhostDir(g);
      }
    }
    function canGhost(g, nx, ny) {
      if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) return false;
      var c = MAZE[ny].charAt(nx);
      if (c === '#') return false;
      if (c === 'o') return g.door;                         // only a releasing ghost may use the door
      return !(ny === HOUSE_Y && (nx >= 5 && nx <= 7 || nx >= 13 && nx <= 15)) || g.door;   // nor the house
    }
    function chooseGhostDir(g) {
      var t = ghostTarget(g), flee = frightT > 0 && g.i >= 2, bestD = Infinity, opts = [], d, k, v, nx, ny;
      for (k in DIRS) {
        v = DIRS[k];
        if (v.x === -g.dir.x && v.y === -g.dir.y) continue;   // never reverse — kills the corner jitter
        nx = Math.round(g.x) + v.x; ny = Math.round(g.y) + v.y;
        if (!canGhost(g, nx, ny)) continue;
        if (flee) { opts.push(v); continue; }                // wanderers bolt at random while scared
        d = (nx - t.x) * (nx - t.x) + (ny - t.y) * (ny - t.y);
        if (d < bestD) { bestD = d; opts = [v]; } else if (d === bestD) opts.push(v);
      }
      if (!opts.length) { g.dir = { x: -g.dir.x, y: -g.dir.y }; return; }   // boxed in: bounce
      g.dir = (opts.length > 1 && flee) ? opts[(Math.random() * opts.length) | 0] : opts[0];
      if (g.door && !(Math.round(g.x) === DOOR.x && Math.round(g.y) === DOOR.y)) g.door = false;
    }
    function placeInHouse(g) {
      g.x = g.home[0]; g.y = HOUSE_Y; g.dir = DIRS.up; g.out = false; g.door = false; g.wait = 1.6; g.wob = 0;
    }
    // Distance-based, not tile-based: forgiving, and immune to where a half-turn left the player.
    function checkHits() {
      var i, g, dx, dy;
      for (i = 0; i < ghost.length; i++) {
        g = ghost[i];
        if (g.eaten > 0 || !g.out || grace > 0) continue;    // in-house, mid-respawn or in grace: harmless
        dx = g.x - px; dy = g.y - py;
        if (dx * dx + dy * dy > HIT_R2) continue;
        if (!frightT > 0) {                                  // ghosts can only ever touch you head-on
          lives--; state = 'dying'; deathT = 0;
          live.textContent = lives > 0 ? lives + ' lives left.' : 'Out of lives.'; return;
        }
        award(EAT[Math.min(chainIdx, EAT.length - 1)]); chainIdx++;
        g.eaten = RESPAWN_WAIT; flashAt = nowMs();
        live.textContent = 'Ate ' + g.name + '. Score ' + score + '.';
      }
      if (fruit && fruitT > 0) {
        dx = fruit[0] - px; dy = fruit[1] - py;
        if (dx * dx + dy * dy <= HIT_R2) { award(Math.min(FRUIT_CAP, FRUIT_BASE + FRUIT_STEP * (level - 1)));
          fruit = null; flashAt = nowMs(); live.textContent = 'Bonus fruit. Score ' + score + '.'; }
      }
    }
    function endRun() {
      if (over) return;                                     // latch: gameOver fires exactly once per run
      over = true; state = 'over';
      if (score > best) { best = score; writeBest(best); setBest(score); }
      live.textContent = 'Game over. Final score ' + score + '.'; overCb(score);
    }
    /* ------------------------------ Drawing ------------------------------ */
    function roundRect(x, y, w, h, r) {
      ctx.beginPath();
      if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
      ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
    }
    // Shrink-to-fit: size from BOTH axes, then measure and step down until the string fits the stage.
    function fitFont(text, weight, k) {
      var fam = weight === 900 ? 'Orbitron, ' : 'Rajdhani, ', s = Math.max(8, Math.min(cssH * k, cssW * 0.085));
      ctx.font = weight + ' ' + Math.round(s) + 'px ' + fam + 'system-ui, sans-serif';
      while (s > 8 && ctx.measureText(text).width > cssW * 0.88) {
        s -= 1; ctx.font = weight + ' ' + Math.round(s) + 'px ' + fam + 'system-ui, sans-serif';
      }
      return s;
    }
    function label(text, x, y, k, weight, color, align) {
      fitFont(text, weight, k); ctx.textAlign = align || 'left'; ctx.fillStyle = color; ctx.fillText(text, x, y);
    }
    function orb(cx, cy, r, color, blur, fillA) {
      ctx.save(); ctx.shadowColor = color; ctx.shadowBlur = reduced ? blur * 0.4 : blur;
      ctx.fillStyle = fillA || color; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 6.2832); ctx.fill(); ctx.restore();
    }
    function draw(now) {
      var i, x, y, v, cx, cy, bw = cell * COLS, bh = cell * ROWS;
      ctx.fillStyle = C.bg; ctx.fillRect(0, 0, cssW, cssH);
      ctx.save(); roundRect(bx, by, bw, bh, Math.min(16, cell)); ctx.clip();
      ctx.fillStyle = 'rgba(255,255,255,.025)'; ctx.fillRect(bx, by, bw, bh);
      ctx.strokeStyle = hexA(C.cyan, 0.85); ctx.lineWidth = Math.max(1.4, cell * 0.11);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.shadowColor = hexA(C.cyan, 0.7); ctx.shadowBlur = reduced ? 6 : 14; ctx.beginPath();
      for (y = 0; y < ROWS; y++) for (x = 0; x < COLS; x++) {
        if (MAZE[y].charAt(x) !== '#') continue;
        if (x > 0 && MAZE[y].charAt(x - 1) === '#') continue;   // only stroke each wall's west face
        ctx.moveTo(bx + x * cell + cell * 0.5, by + y * cell);
        ctx.lineTo(bx + x * cell, by + y * cell); ctx.lineTo(bx + x * cell, by + (y + 1) * cell);
      }
      ctx.stroke(); ctx.restore();
      ctx.save();                                          // ghost-house door
      ctx.shadowColor = hexA(C.magenta, 0.8); ctx.shadowBlur = reduced ? 4 : 12;
      ctx.fillStyle = hexA(C.magenta, 0.55);
      ctx.fillRect(bx + DOOR.x * cell, by + DOOR.y * cell + cell * 0.36, cell, cell * 0.28); ctx.restore();
      for (y = 0; y < ROWS; y++) for (x = 0; x < COLS; x++) {
        v = board[y][x]; if (!v) continue;
        cx = bx + (x + 0.5) * cell; cy = by + (y + 0.5) * cell;
        if (v === 1) { ctx.fillStyle = hexA(C.ink, 0.82); ctx.beginPath(); ctx.arc(cx, cy, Math.max(1, cell * 0.09), 0, 6.2832); ctx.fill(); }
        else orb(cx, cy, cell * 0.3 * (reduced ? 1 : 0.82 + 0.18 * Math.sin(now / 190)), C.acid, 20);
      }
      if (fruit && fruitT > 0) {                           // bonus fruit: blinks out in its last 2s
        var fa = fruitT < 2 && !reduced ? 0.35 + 0.65 * Math.abs(Math.sin(now / 150)) : 1;
        cx = bx + (fruit[0] + 0.5) * cell; cy = by + (fruit[1] + 0.5) * cell;
        ctx.save(); ctx.globalAlpha = fa; ctx.shadowColor = C.orange; ctx.shadowBlur = reduced ? 8 : 22;
        ctx.fillStyle = C.orange; ctx.beginPath(); ctx.arc(cx, cy + cell * 0.08, cell * 0.3, 0, 6.2832); ctx.fill();
        ctx.shadowBlur = 0; ctx.strokeStyle = C.acid; ctx.lineWidth = Math.max(1.4, cell * 0.08);
        ctx.beginPath(); ctx.moveTo(cx, cy - cell * 0.2); ctx.lineTo(cx + cell * 0.12, cy - cell * 0.42); ctx.stroke();
        ctx.restore();
      }
      for (i = 0; i < ghost.length; i++) drawGhost(ghost[i], now);
      drawPac(now); crt();                                 // scanlines + vignette go over the WORLD only …
      drawHUD(now);                                        // … the HUD is drawn after them so text is never darkened
    }
    function drawPac(now) {
      var cx = bx + px * cell, cy = by + py * cell, ang = Math.atan2(dir.y, dir.x), p = 0, r = cell * PAC_R, col = C.cyan;
      if (state === 'dying') { p = clamp(deathT * 1000 / DEATH_MS, 0, 1);   // the jaw opens, body collapses
        if (p >= 0.99) return; r *= 1 - p * 0.5; if (p > 0.5) col = C.magenta; }
      var mouth = state === 'dying' ? p * Math.PI * 0.95 : (reduced ? 0.22 : 0.05 + 0.17 * Math.abs(Math.sin(now / 150)));
      ctx.save(); ctx.shadowColor = col; ctx.shadowBlur = reduced ? 10 : 26; ctx.fillStyle = col;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, r, ang + mouth, ang - mouth);
      ctx.closePath(); ctx.fill(); ctx.restore();
    }
    function drawGhost(g, now) {
      var cx = bx + g.x * cell, cy = by + g.y * cell, r = cell * 0.44, w, e, eo;
      if (g.eaten > 0) { orb(cx, cy, r * (g.eaten / RESPAWN_WAIT), C.ink, 12, hexA(C.ink, g.eaten / RESPAWN_WAIT * 0.9)); return; }
      // The frightened-flee flash in the last two seconds warns you the window is closing.
      var scared = frightT > 0, flash = scared && frightT < 2 && (Math.floor(now / 140) % 2 === 0);
      ctx.save(); ctx.shadowColor = scared ? '#7c4dff' : g.color; ctx.shadowBlur = reduced ? 6 : 16;
      ctx.fillStyle = scared ? (flash ? C.ink : '#2b1a4a') : (g.out ? g.color : hexA(g.color, 0.55));
      ctx.beginPath();
      ctx.arc(cx, cy - r * 0.1, r, Math.PI, 0);             // dome
      ctx.lineTo(cx + r, cy + r * 0.85);
      for (w = 0; w < 4; w++)                                // scalloped hem
        ctx.lineTo(cx + r - (w * 2 + 1) * (r / 4), cy + r * (w % 2 ? 0.45 : 0.85));
      ctx.lineTo(cx - r, cy + r * 0.85); ctx.closePath(); ctx.fill();
      ctx.shadowBlur = 0; ctx.fillStyle = scared ? (flash ? C.magenta : C.ink) : C.bg;
      eo = g.out ? g.dir : DIRS.up;                          // eyes look where they are going
      for (e = -1; e <= 1; e += 2) {
        ctx.beginPath();
        ctx.ellipse(cx + e * r * 0.36 + eo.x * r * 0.16, cy - r * 0.15 + eo.y * r * 0.16, r * 0.2, r * 0.26, 0, 0, 6.2832);
        ctx.fill();
      }
      ctx.restore();
    }
    function crt() {
      var i, v = ctx.createRadialGradient(cssW / 2, cssH / 2, Math.min(cssW, cssH) * 0.25,
        cssW / 2, cssH / 2, Math.max(cssW, cssH) * 0.75);
      ctx.save();
      if (!reduced) { ctx.fillStyle = 'rgba(0,0,0,.15)'; for (i = 0; i < cssH; i += 3) ctx.fillRect(0, i, cssW, 1); }
      v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,.5)');
      ctx.fillStyle = v; ctx.fillRect(0, 0, cssW, cssH); ctx.restore();
    }
    function drawHUD(now) {
      var w = cssW, top = Math.max(13, by * 0.42), i, pr = Math.max(3, Math.min(8, cell * 0.2)), lx;
      ctx.save(); ctx.textBaseline = 'middle';
      // A hard black drop shadow keeps every caption above 4.5:1 wherever it lands on the world.
      ctx.shadowColor = 'rgba(0,0,0,.95)'; ctx.shadowBlur = 5; ctx.shadowOffsetY = 1;
      label('SCORE ' + score, Math.max(8, bx), top, 0.05, 700, C.ink, 'left');
      label('BEST ' + best, Math.min(w - 8, bx + cell * COLS), top, 0.05, 700, C.dim, 'right');
      if (level > 1) label('LEVEL ' + level, w / 2, top, 0.045, 700, (now - flashAt) < 400 ? C.acid : C.dim, 'center');
      ctx.fillStyle = C.cyan; ctx.shadowColor = C.cyan; ctx.shadowBlur = reduced ? 0 : 10;
      for (i = 0; i < lives; i++) {                          // lives as pac pips
        lx = w / 2 + (i - (lives - 1) / 2) * pr * 2.8;
        ctx.beginPath(); ctx.moveTo(lx, by - pr * 1.6); ctx.arc(lx, by - pr * 1.6, pr, 0.5, 5.7832);
        ctx.closePath(); ctx.fill();
      }
      if (frightT > 0) {                                     // the clock on the power pellet
        var fw = Math.min(cssW * 0.6, cell * 12), fx = (w - fw) / 2, fy = by + cell * ROWS + pr * 1.4;
        ctx.shadowBlur = 0; ctx.fillStyle = 'rgba(5,6,15,.6)'; ctx.fillRect(fx, fy, fw, 5);
        ctx.fillStyle = frightT < 2 ? C.magenta : C.acid;
        ctx.fillRect(fx, fy, fw * clamp(frightT / frightMax(level), 0, 1), 5);
        label('EAT THEM', w / 2, fy + 16, 0.038, 700, C.dim, 'center');
      }
      ctx.restore();
      if (state === 'ready') card('READY', 'Arrow keys / WASD, swipe, or the pad', C.cyan, 'TAP or press a key to start');
      else if (paused && state !== 'over') card('PAUSED', 'Tap or press a key to resume', C.cyan, null);
      else if (state === 'over') card('GAME OVER', 'SCORE ' + score + (isRecord ? '  ·  NEW BEST' : ''), C.magenta, 'TAP or press SPACE to play again');
    }
    function card(title, sub, color, hint) {
      ctx.save(); ctx.fillStyle = hexA(C.bg, 0.76); ctx.fillRect(0, 0, cssW, cssH); ctx.textBaseline = 'middle';
      fitFont(title, 900, 0.13); ctx.textAlign = 'center';
      ctx.shadowColor = color; ctx.shadowBlur = 26; ctx.fillStyle = color; ctx.fillText(title, cssW / 2, cssH * 0.42);
      ctx.shadowBlur = 0; label(sub, cssW / 2, cssH * 0.52, 0.045, 600, C.dim, 'center');
      if (hint) label(hint, cssW / 2, cssH * 0.62, 0.04, 600, C.ink, 'center');
      ctx.restore();
    }
    /* -------------------------- Single rAF loop -------------------------- */
    function frame(now) {
      if (destroyed) return;                                 // destroy() may land between frames
      var dt = prevTime ? clamp((now - prevTime) / 1000, 0, 0.05) : 0;   // no teleport after a tab switch
      prevTime = now; elapsed += dt;
      if (!paused) update(dt);
      draw(nowMs());
      if (!destroyed) rafId = requestAnimationFrame(frame);  // re-check: gameOver() may destroy() us
    }
    function update(dt) {
      var i;
      if (grace > 0) grace -= dt;
      if (frightT > 0) { frightT -= dt; if (frightT <= 0) { frightT = 0; chainIdx = 0; } }
      if (fruitT > 0) { fruitT -= dt; if (fruitT <= 0) fruit = null; }
      if (state === 'dying') {                               // the world freezes while the arc collapses
        deathT += dt;
        if (deathT * 1000 >= DEATH_MS) { if (lives <= 0) endRun(); else resetActors(true); }
        return;
      }
      if (state !== 'play') return;
      playerStep(dt);
      for (i = 0; i < ghost.length; i++) ghostStep(ghost[i], dt);
      checkHits();
    }
    /* ---------------------- Input: keyboard, swipe, pad ---------------------- */
    function act(name) {                                     // the single entry point for every control
      if (destroyed || state === 'dying') return;
      if (state === 'over') { over = false; fillBoard(); resetActors(false); started = true;
        live.textContent = 'New run. Score 0. Three lives.'; return; }
      started = true; paused = false;
      if (state === 'ready') state = 'play';
      if (name) want = DIRS[name];
    }
    function onKeyDown(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === 'Space' || e.code === 'Enter' || e.key === ' ') {
        var a = document.activeElement;                      // never steal Space from a real control
        if (a && a !== canvas && /^(BUTTON|INPUT|SELECT|TEXTAREA|A|SUMMARY)$/.test(a.tagName)) return;
        e.preventDefault(); act(null); return;
      }
      var d = KEYS[e.code] || KEYS[e.key];
      if (d) { e.preventDefault(); act(d); }
    }
    var sx = 0, sy = 0, swiping = false;
    function onDown(e) {
      if (e.button !== undefined && e.button > 0) return;
      sx = e.clientX; sy = e.clientY; swiping = true; act(null);
      try { if (e.pointerId !== undefined) canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    }
    function onUp(e) {                                       // a FLICK-px drag anywhere on the board steers
      if (!swiping) return;
      swiping = false;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) < FLICK && Math.abs(dy) < FLICK) return;
      act(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
    }
    function onPadDown(e) {
      var b = e.target; if (!b || !b.dataset || !b.dataset.dir) return;
      e.preventDefault(); act(b.dataset.dir);
    }
    function onCancel() { swiping = false; }
    function onPause() { if (!destroyed && state !== 'over') paused = true; }
    function onResume() { if (!destroyed && !document.hidden && started) paused = false; }
    function onVis() { if (!destroyed) paused = document.hidden; }
    function onResize() { if (!destroyed) resize(); }
    function onMenu(e) { e.preventDefault(); }              // no right-click menu over the board
    on(canvas, 'pointerdown', onDown); on(canvas, 'pointerup', onUp); on(canvas, 'pointercancel', onCancel);
    on(pad, 'pointerdown', onPadDown); on(canvas, 'contextmenu', onMenu);
    on(document, 'keydown', onKeyDown); on(document, 'visibilitychange', onVis);
    on(window, 'blur', onPause); on(window, 'focus', onResume);
    on(window, 'resize', onResize); on(window, 'orientationchange', onResize);

    fillBoard(); resetActors(false); started = false; state = 'ready'; setBest(best); setScore(0);
    live.textContent = NAME + '. Three lives. The ghosts are ' + GHOSTS.map(function (g) { return g.name; }).join(', ') + '.';
    rafId = requestAnimationFrame(frame);
    /* ---- Teardown: nothing survives this ---- */
    return {
      destroy: function () {
        if (destroyed) return;
        destroyed = true; cancelAnimationFrame(rafId);
        for (var i = 0; i < listeners.length; i++) listeners[i][0].removeEventListener(listeners[i][1], listeners[i][2]);
        listeners.length = 0;
        var parent = wrap.parentNode;                        // drops canvas, pad, live region and <style> together
        if (parent && typeof parent.removeChild === 'function') parent.removeChild(wrap);
        else if (typeof wrap.remove === 'function') wrap.remove();
      }
    };
  }
  /* ---------------------- Public module contract ---------------------- */
  window.PixelGame = {
    name: NAME,
    instructions: 'Clear the maze: pellets are +10, power pellets turn the tables. Four ghosts hunt you — ' +
      'BLAZE chases your tile, VECTOR cuts you off four tiles ahead, DRIFT and EMBER wander the corridors. ' +
      'Every ghost is slower than you, so any trap has an exit. ARROW KEYS or WASD steer, and you may ' +
      'reverse into a corridor behind you. Swipe or use the on-screen pad on touch. SPACE pauses. Three ' +
      'lives, and each cleared level makes the ghosts faster.',
    start: start
  };
})();
