/**
 * PIXEL RUSH — games/rogue-shift.js — "Rogue Shift"
 * Contract (SPEC.md): window.PixelGame = { name, instructions, start(root, api) } where
 * api = { setScore(n), setBest(n), gameOver(score) } and start() returns { destroy() }.
 * Self-contained: no imports, no dependencies, no assets — one <canvas> + 2D ctx, and
 * every rAF id and listener created in start() is torn down in destroy().
 */
(function () {
  'use strict';
  /* -------------------------------- Tuning -------------------------------- */
  var STORE_KEY = 'pixelrush.rogue-shift.best'; // localStorage: all-time best score
  var COLS = 33, ROWS = 19;        // the whole floor is one screen — no scrolling
  var START_HP = 14, START_ATK = 2;
  var START_SHIFTS = 2;            // layout rerolls in the bank
  var KILL_BASE = 30, KILL_STEP = 10, LOOT_SCORE = 20, DESCEND_STEP = 150;
  var FLICK = 22;                  // px of drag that counts as a directional swipe
  var DIRS = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
  var KEYS = { ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right' };
  // Everything the spec does not name, prefixed `rs-` so it cannot collide
  var STYLES = '.rs{position:relative;width:100%;height:100%;overflow:hidden;touch-action:none;' +
    'user-select:none;-webkit-tap-highlight-color:transparent;' +
    'font-family:var(--font-body,"Rajdhani",system-ui,sans-serif);color:var(--ink,#f2f5ff)}' +
    '.rs canvas{display:block;width:100%;height:100%;outline:none}';
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function randInt(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
  function pick(a) { return a[randInt(0, a.length - 1)]; }
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
    var wrap = document.createElement('div'); wrap.className = 'rs';
    var canvas = document.createElement('canvas');
    canvas.setAttribute('tabindex', '0'); canvas.setAttribute('role', 'application');
    canvas.setAttribute('aria-label', 'Rogue Shift dungeon. Arrow keys or WASD to move and bump to attack, space to strike, E to shift.');
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
    var map = new Uint8Array(COLS * ROWS), rooms = [];
    var px = 0, py = 0, pHp = START_HP, pMaxHp = START_HP, pAtk = START_ATK, pDef = 0, pShifts = START_SHIFTS;
    var fx = 0, fy = 1;                 // facing — decides what SPACE strikes
    var enemies = [], items = [], stairs = { x: 0, y: 0 }, depth = 0;
    var log = [], score = 0, bestEver = readBest(), isRecord = false;
    var shakeUntil = 0, hurtUntil = 0;
    var paused = false, over = false, titled = true; // `titled`: the first build shows the title card
    var lastStatus = null;
    /* The shell owns "Playing" and "Game over"; this game has a pause state the
       shell cannot see (title card, auto-pause on blur), so report that too. */
    function syncStatus() {
      if (over) return;                       // never talk over the shell's game-over row
      var s = paused ? 'Paused' : 'Playing';
      if (s !== lastStatus) { lastStatus = s; setStatus(s); }
    }
    /* ----------------- Sizing (crisp devicePixelRatio) ----------------- */
    var dpr = 1, cssW = 1, cssH = 1, cell = 8, mx = 0, my = 0, hudH = 90;
    var pad = null, btnAtk = null, btnShift = null;
    // Touch-target sizes, in CSS px. The stage is 16:9 whatever the viewport, so
    // on a phone the box is only ~340x186: the controls have to be laid out from
    // what the map does NOT use, never from a fixed strip that can grow past the
    // box and swallow the playfield.
    var PAD_GAP = 5, PAD_MAX = 46, PAD_WANT = 22;
    var BTN_MAX = 42, BTN_MIN = 18, CELL_MIN = 3;
    function resize() {
      var r = wrap.getBoundingClientRect();
      cssW = Math.max(1, Math.round(r.width)); cssH = Math.max(1, Math.round(r.height));
      dpr = clamp(window.devicePixelRatio || 1, 1, 2); // cap 2 per contract
      canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
      canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var fs = Math.round(clamp(cssH * 0.042, 11, 18)), lh = fs + 4;
      hudH = clamp(cssH * 0.20, lh * 2 + 4, 150);            // two read-out lines
      hudH = Math.min(hudH, Math.max(0, cssH - ROWS * CELL_MIN)); // never squeeze out the map
      var avH = Math.max(ROWS * CELL_MIN, cssH - hudH);
      /* Biggest floor that still leaves a D-pad of at least PAD_WANT per key in
         the space beside it. Stepping the cell down costs map area, so the loop
         stops at the first size whose rails still hold a thumb. */
      var c = Math.floor(Math.min(avH / ROWS, (cssW - 8) / COLS));
      while (c > CELL_MIN && !railFits(c, avH)) c--;
      cell = Math.max(CELL_MIN, c);
      var mh = cell * ROWS;
      mx = Math.round((cssW - cell * COLS) / 2);
      my = Math.round(hudH + Math.max(0, avH - mh) / 2);
      layoutButtons();
    }
    /* Would a `cell`-sized floor still leave a rail wide enough for the D-pad
       (3 keys + 2 gaps) and the two circles (2 diameters + a gap) stacked? */
    function railFits(cell_, avH) {
      var rail = (cssW - cell_ * COLS) / 2 - 4;
      var regH = cssH - (hudH + Math.max(0, avH - cell_ * ROWS) / 2);
      return rail - 2 * PAD_GAP >= 3 * PAD_WANT && regH >= 4 * PAD_WANT + 3 * PAD_GAP;
    }
    /* Controls live in the leftover region around the map — the rails beside it
       on a 16:9 box, the strip under it when the map fills the width. Both are
       derived from the map rect, so a control can never cover a tile. */
    function layoutButtons() {
      var mh = cell * ROWS;
      var leftW = mx - 4, rightW = cssW - (mx + cell * COLS) - 4, footH = cssH - (my + mh);
      var regionH = cssH - my, cy = my + regionH / 2;
      // the key size is whatever the rail allows — never larger, so the D-pad
      // cannot spill out of its rail and onto the map
      var k = clamp((Math.min(leftW, regionH) - 2 * PAD_GAP) / 3, 6, PAD_MAX);
      var cx = Math.max(k * 1.5 + PAD_GAP, mx / 2);
      pad = {
        cx: cx, cy: cy, k: k, g: PAD_GAP,
        up: rect(cx - k / 2, cy - k * 1.5 - PAD_GAP, k, k),
        down: rect(cx - k / 2, cy + k * 0.5 + PAD_GAP, k, k),
        left: rect(cx - k * 1.5 - PAD_GAP, cy - k / 2, k, k),
        right: rect(cx + k * 0.5 + PAD_GAP, cy - k / 2, k, k)
      };
      // Two circles, never touching: stacked needs 2 diameters + a gap of height.
      var r, bx, by, rMax = (regionH - PAD_GAP) / 4 - 1;
      if (rightW >= BTN_MIN * 2 + PAD_GAP && rMax >= BTN_MIN) {
        r = clamp(Math.min(rightW / 2, rMax), BTN_MIN, BTN_MAX);
        bx = cssW - Math.max(r + 4, rightW / 2); by = cy;
        btnAtk = { x: bx, y: by - (r + PAD_GAP / 2), r: r };
        btnShift = { x: bx, y: by + (r + PAD_GAP / 2), r: r };
      } else if (rMax >= BTN_MIN) {                    // no right rail: stack under the map
        r = clamp(Math.min(footH - 6, rMax), BTN_MIN, BTN_MAX);
        bx = Math.min(cssW - r - 6, mx + cell * COLS - r); by = cy;
        btnAtk = { x: bx, y: by - (r + PAD_GAP / 2), r: r };
        btnShift = { x: bx, y: by + (r + PAD_GAP / 2), r: r };
      } else {                                          // last resort: side by side
        r = clamp((Math.min(cssW - 8, regionH - 8) - PAD_GAP) / 4, 6, BTN_MAX);
        var span3 = 4 * r + PAD_GAP;
        bx = Math.max(4, Math.min((cssW - span3) / 2, mx + cell * COLS - span3));
        by = Math.min(cssH - r - 2, my + regionH / 2);
        btnAtk = { x: bx + r, y: by, r: r };
        btnShift = { x: bx + r * 3 + PAD_GAP, y: by, r: r };   // 2r + gap apart
      }
    }
    function rect(x, y, w, h) { return { x: x, y: y, w: w, h: h }; }
    function inRect(pt, r) { return r && pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h; }
    function inCircle(pt, c) { var dx = pt.x - c.x, dy = pt.y - c.y; return dx * dx + dy * dy <= c.r * c.r; }
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
    function say(t) {
      log.push(t);
      if (log.length > 3) log.shift();
      live.textContent = t + ' HP ' + Math.max(0, pHp) + ' of ' + pMaxHp + '.';
    }
    function inBounds(x, y) { return x >= 0 && y >= 0 && x < COLS && y < ROWS; }
    /* ------------------------- Dungeon generation ------------------------- */
    function carve(x0, y0, x1, y1) {  // L-shaped corridor: across, then down
      var x, y;
      if (!inBounds(x0, y0) || !inBounds(x1, y1)) return;
      for (x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) map[y0 * COLS + x] = 0;
      for (y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) map[y * COLS + x1] = 0;
    }
    /* A room is a solid open rectangle. It has to be, not an L: the corridors
       below are driven from each room's CENTRE tile, so a room whose interior
       is still rock either swallows its own centre or leaves the corridor
       arriving on a tile the room cannot reach — which strands the stairs in
       a component the player can never walk into, and the run never descends. */
    function carveRoom(r) {
      var x, y;
      for (y = r.y; y < r.y + r.h; y++)
        for (x = r.x; x < r.x + r.w; x++)
          if (inBounds(x, y)) map[y * COLS + x] = 0;
    }
    function buildFloor() {
      map = new Uint8Array(COLS * ROWS);
      for (var i = 0; i < map.length; i++) map[i] = 1;        // solid rock
      rooms = [];
      var want = randInt(3, 5), tries = 0, guard = 0;
      while (rooms.length < want && tries++ < 400) {
        var w = randInt(5, 9), h = randInt(4, 6);
        var x = randInt(1, COLS - w - 2), y = randInt(1, ROWS - h - 2), ok = true;
        for (var j = 0; j < rooms.length; j++) {             // one tile of padding between rooms
          var r = rooms[j];
          if (x < r.x + r.w + 1 && x + w + 1 > r.x && y < r.y + r.h + 1 && y + h + 1 > r.y) { ok = false; break; }
        }
        if (!ok) continue;
        rooms.push({ x: x, y: y, w: w, h: h, cx: x + ((w / 2) | 0), cy: y + ((h / 2) | 0) });
      }
      while (guard++ < 12 && rooms.length > 1) {             // a 1-room map is not a floor
        var q = randInt(0, rooms.length - 1);
        if (rooms[q].w < 4 || rooms[q].h < 3) continue;
        rooms.splice(q, 1); break;
      }
      for (i = 0; i < rooms.length; i++) carveRoom(rooms[i]);
      for (i = 1; i < rooms.length; i++) {                    // L-corridor to the previous room
        var p = rooms[i - 1], c = rooms[i];
        carve(p.cx, p.cy, c.cx, p.cy); carve(c.cx, p.cy, c.cx, c.cy);
      }
      if (rooms.length > 2 && Math.random() < 0.7) {          // a loop makes kiting viable
        var a = pick(rooms), b = pick(rooms);
        if (a !== b) { carve(a.cx, a.cy, b.cx, a.cy); carve(b.cx, a.cy, b.cx, b.cy); }
      }
    }
    function walkable(x, y) { return inBounds(x, y) && map[y * COLS + x] === 0; }
    function nearestOpen(x, y) {  // expanding ring search: used when SHIFT re-rolls the walls
      if (walkable(x, y)) return { x: x, y: y };
      for (var r = 1; r < Math.max(COLS, ROWS); r++) for (var dy = -r; dy <= r; dy++) for (var dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (walkable(x + dx, y + dy)) return { x: x + dx, y: y + dy };
      }
      return { x: 1, y: 1 };
    }
    function openCells() {
      var out = [];
      for (var y = 0; y < ROWS; y++) for (var x = 0; x < COLS; x++) if (map[y * COLS + x] === 0) out.push({ x: x, y: y });
      return out;
    }
    function enemyAt(x, y) { for (var i = 0; i < enemies.length; i++) if (enemies[i].x === x && enemies[i].y === y) return enemies[i]; return null; }
    function itemAt(x, y) { for (var i = 0; i < items.length; i++) if (items[i].x === x && items[i].y === y) return items[i]; return null; }
    /* ----------------------------- Run setup ----------------------------- */
    function spawnFloor() {
      buildFloor();
      var cells = openCells();
      if (!cells.length) { px = 1; py = 1; return; }
      var entry = rooms.length ? rooms[0] : cells[0], exit = rooms.length > 1 ? rooms[rooms.length - 1] : null;
      px = entry.cx != null ? entry.cx : entry.x; py = entry.cy != null ? entry.cy : entry.y;
      if (exit) stairs = { x: exit.cx, y: exit.cy };
      else {                                        // degenerate one-room map: exit goes far away
        var far = cells[0];
        for (var q = 0; q < cells.length; q++)
          if (Math.abs(cells[q].x - px) + Math.abs(cells[q].y - py) > Math.abs(far.x - px) + Math.abs(far.y - py)) far = cells[q];
        stairs = { x: far.x, y: far.y };
      }
      enemies = []; items = [];
      var count = clamp(2 + depth * 2, 3, 15), tries = 0, i = 0, c;
      while (i < count && tries++ < 400) {           // never spawn on top of you, or stacked
        c = pick(cells);
        if (Math.abs(c.x - px) + Math.abs(c.y - py) < 9) continue;
        if (c.x === stairs.x && c.y === stairs.y) continue;
        if (enemyAt(c.x, c.y) || itemAt(c.x, c.y)) continue;
        i++;
        var fast = depth >= 3 && Math.random() < clamp((depth - 2) * 0.08, 0, 0.5);
        enemies.push({
          x: c.x, y: c.y, fast: fast,
          hp: 2 + Math.floor(depth * 0.8), max: 2 + Math.floor(depth * 0.8),
          dmg: clamp(1 + Math.floor(depth / 2), 1, 7), def: depth > 4 && Math.random() < 0.3 ? 1 : 0,
          g: fast ? 'S' : 'g', col: fast ? C.violet : C.magenta
        });
      }
      var drops = 1 + (depth >= 4 ? 1 : 0) + (Math.random() < 0.25 ? 1 : 0);
      for (i = 0; i < drops; i++) {
        var s = pick(cells);
        if ((s.x === stairs.x && s.y === stairs.y) || itemAt(s.x, s.y)) { i--; continue; }
        var r = Math.random();
        items.push({ x: s.x, y: s.y, kind: r < 0.34 ? 'atk' : r < 0.58 ? 'def' : r < 0.82 ? 'hp' : 'shift' });
      }
    }
    function resetRun() {
      depth = 0; pHp = pMaxHp = START_HP; pAtk = START_ATK; pDef = 0; pShifts = START_SHIFTS;
      fx = 0; fy = 1; log = []; score = 0; isRecord = false;
      over = false; paused = titled; titled = false; shakeUntil = 0; hurtUntil = 0;
      spawnFloor();
      say('Floor 1. Find the stairs and descend.');
      say('Bump to attack. SHIFT rerolls the layout.');
      setScore(0);
      if (bestEver !== null) setBest(bestEver);
    }
    function addScore(n) {
      score += n; setScore(score);
      if (bestEver === null || score > bestEver) { bestEver = score; isRecord = true; writeBest(score); setBest(score); }
    }
    /* ------------------------------ Turns ------------------------------ */
    function move(dx, dy) {
      if (over || destroyed) return;
      paused = false; fx = dx; fy = dy;
      var nx = px + dx, ny = py + dy, e = enemyAt(nx, ny);
      if (e) { strike(e); return; }                 // bumping an enemy is an attack
      if (!walkable(nx, ny)) { if (randInt(0, 2)) say('Rock blocks the way.'); enemyTurn(); return; }
      px = nx; py = ny;
      var it = itemAt(px, py);
      if (it) takeLoot(it);
      if (px === stairs.x && py === stairs.y) { descend(); return; }
      enemyTurn();
    }
    function strike(e) {
      var dmg = Math.max(1, pAtk - e.def) + (Math.random() < 0.18 ? 1 : 0);
      e.hp -= dmg; shakeUntil = performance.now() + (reduced ? 0 : 110);
      if (e.hp > 0) { say('You hit the ' + (e.fast ? 'stalker' : 'grunt') + ' for ' + dmg + '.'); enemyTurn(); return; }
      enemies.splice(enemies.indexOf(e), 1);
      addScore(KILL_BASE + KILL_STEP * depth);
      say('Kill! +' + (KILL_BASE + KILL_STEP * depth));
      enemyTurn();
    }
    function strikeAhead() {            // SPACE / the ATK round: hit whatever you are facing
      if (over || destroyed) return;
      paused = false;
      var e = enemyAt(px + fx, py + fy);
      if (e) { strike(e); return; }
      if (walkable(px + fx, py + fy)) { move(fx, fy); return; }
      say('You swing at empty air.'); enemyTurn();
    }
    function takeLoot(it) {
      items.splice(items.indexOf(it), 1);
      addScore(LOOT_SCORE);
      if (it.kind === 'atk') { pAtk++; say('LOOT +1 ATK. Your power is ' + pAtk + '.'); }
      else if (it.kind === 'def') { pDef++; say('LOOT +1 DEF. Your guard is ' + pDef + '.'); }
      else if (it.kind === 'hp') { pMaxHp += 3; pHp = Math.min(pMaxHp, pHp + 6); say('LOOT +3 MAX HP, and 6 healed.'); }
      else { pShifts++; say('LOOT +1 SHIFT. You carry ' + pShifts + '.'); }
    }
    function descend() {
      depth++;
      addScore(DESCEND_STEP * depth);
      pHp = Math.min(pMaxHp, pHp + 3);
      spawnFloor();
      say('+' + (DESCEND_STEP * depth) + '. Descended to floor ' + (depth + 1) + ' — deeper, and angrier.');
    }
    /** THE SHIFT: reroll rooms and corridors, then pull everything back onto open rock. */
    function doShift() {
      if (over || destroyed) return;
      paused = false;
      if (pShifts <= 0) { say('No shifts left. Find loot to earn one.'); enemyTurn(); return; }
      pShifts--;
      var wasStairs = { x: stairs.x, y: stairs.y };
      buildFloor();
      var p = nearestOpen(px, py); px = p.x; py = p.y;
      for (var i = 0; i < enemies.length; i++) { var a = nearestOpen(enemies[i].x, enemies[i].y); enemies[i].x = a.x; enemies[i].y = a.y; }
      for (i = 0; i < items.length; i++) { var b = nearestOpen(items[i].x, items[i].y); items[i].x = b.x; items[i].y = b.y; }
      var s = nearestOpen(wasStairs.x, wasStairs.y); stairs = s;   // the exit stays where you left it
      shakeUntil = performance.now() + (reduced ? 0 : 320);
      say('SHIFT! The rush rerolls the floor. Shifts left: ' + pShifts);
      enemyTurn();
    }
    function hurtPlayer(dmg) {
      dmg = Math.max(1, dmg - pDef);
      pHp -= dmg; hurtUntil = performance.now() + (reduced ? 0 : 200);
      shakeUntil = performance.now() + (reduced ? 0 : 160);
      say('You take ' + dmg + '. HP ' + Math.max(0, pHp) + '/' + pMaxHp + '.');
      if (pHp <= 0) die();
    }
    function stepToward(e, tx, ty) { // one greedy chase step, no diagonal into another monster
      var dx = Math.sign(tx - e.x), dy = Math.sign(ty - e.y);
      var opts = Math.abs(tx - e.x) >= Math.abs(ty - e.y)
        ? [[dx, 0], [0, dy]] : [[0, dy], [dx, 0]];
      if (Math.random() < 0.12) { var t = opts[0]; opts[0] = opts[1]; opts[1] = t; }
      for (var i = 0; i < 2; i++) {
        var nx = e.x + opts[i][0], ny = e.y + opts[i][1];
        if (!walkable(nx, ny)) continue;
        if (nx === px && ny === py) continue;             // handled by the attack pass
        if (enemyAt(nx, ny)) continue;
        e.x = nx; e.y = ny; return;
      }
    }
    function enemyTurn() {
      if (over || destroyed) return;
      for (var i = 0; i < enemies.length; i++) {
        var e = enemies[i];
        if (Math.abs(e.x - px) + Math.abs(e.y - py) <= 1) { hurtPlayer(e.dmg); if (over) return; continue; }
        stepToward(e, px, py);
        if (e.fast) stepToward(e, px, py);                // stalkers close two tiles a turn
        if (Math.abs(e.x - px) + Math.abs(e.y - py) <= 1) { hurtPlayer(e.dmg); if (over) return; }
      }
    }
    function die() {
      if (over || destroyed) return;   // api.gameOver() may only fire once per run
      pHp = 0; over = true; paused = false;
      say('You die on floor ' + (depth + 1) + '.');
      live.textContent = 'Dead. Final score ' + score + '.';
      gameOverCb(score);
    }
    /* HUD/card type is fitted, not guessed: shrink the size until the measured
       string fits the width it was given, so nothing ever runs off the canvas. */
    function fit(size, ok) {
      var s = Math.round(size);
      for (; s > 8; s--) if (ok(s)) return s;
      return 8;
    }
    function fitText(text, maxW, weight, family, want, min) {
      var s = Math.round(want);
      for (; s > min; s--) {
        ctx.font = weight + ' ' + s + 'px ' + family;
        if (ctx.measureText(text).width <= maxW) return s;
      }
      ctx.font = weight + ' ' + min + 'px ' + family;
      return min;
    }
    /** Centred overlay: big neon title, one dim line of sub-copy, optional hint. */
    function card(title, sub, color, hint) {
      var maxW = cssW - Math.max(12, cssW * 0.07), face = 'Rajdhani, system-ui, sans-serif';
      ctx.fillStyle = hexA(C.bg, 0.74); ctx.fillRect(0, 0, cssW, cssH);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      fitText(title, maxW, '900', 'Orbitron, system-ui, sans-serif', clamp(Math.min(cssH * 0.13, cssW * 0.14), 22, 60), 12);
      ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 26;
      ctx.fillText(title, cssW / 2, cssH * 0.42); ctx.shadowBlur = 0;
      fitText(sub, maxW, '600', face, clamp(Math.min(cssH * 0.045, cssW * 0.055), 12, 20), 10);
      ctx.fillStyle = C.dim; ctx.fillText(sub, cssW / 2, cssH * 0.51);
      if (hint) {
        fitText(hint, maxW, '600', face, clamp(Math.min(cssH * 0.045, cssW * 0.055), 12, 20), 10);
        ctx.fillText(hint, cssW / 2, cssH * 0.6);
      }
    }
    function glyph(ch, gx, gy, color, size, glow) {
      ctx.save();
      ctx.font = '700 ' + Math.round(size) + 'px "Courier New",ui-monospace,monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = color;
      if (glow) { ctx.shadowColor = color; ctx.shadowBlur = glow; }
      ctx.fillText(ch, gx, gy + size * 0.06);
      ctx.restore();
    }
    function drawButton(c, label, color, on) {
      ctx.save();
      ctx.beginPath(); ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
      ctx.fillStyle = hexA(color, on ? 0.34 : 0.12); ctx.fill();
      ctx.strokeStyle = hexA(color, on ? 1 : 0.65); ctx.lineWidth = 2;
      ctx.shadowColor = color; ctx.shadowBlur = on ? 22 : 10; ctx.stroke();
      ctx.shadowBlur = 0; ctx.fillStyle = color;
      ctx.font = '800 ' + Math.round(clamp(c.r * 0.42, 10, 17)) + 'px Rajdhani, system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(label, c.x, c.y + 1);
      ctx.restore();
    }
    function drawPad(on) {
      var keys = [['↑', pad.up], ['↓', pad.down], ['←', pad.left], ['→', pad.right]];
      for (var i = 0; i < 4; i++) {
        var r = keys[i][1], lit = on === keys[i][0], col = lit ? C.acid : C.cyan;
        rr(r.x, r.y, r.w, r.h, r.w * 0.28);
        ctx.fillStyle = hexA(col, lit ? 0.3 : 0.1); ctx.fill();
        ctx.strokeStyle = hexA(col, lit ? 1 : 0.55); ctx.lineWidth = 2;
        ctx.shadowColor = col; ctx.shadowBlur = lit ? 18 : 6; ctx.stroke(); ctx.shadowBlur = 0;
        ctx.fillStyle = lit ? C.acid : hexA(C.cyan, 0.85);
        ctx.font = '800 ' + Math.round(r.w * 0.5) + 'px Rajdhani, system-ui, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(keys[i][0], r.x + r.w / 2, r.y + r.h / 2 + 1);
      }
    }
    function draw(now) {
      var w = cssW, h = cssH, bw = cell * COLS, bh = cell * ROWS;
      ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);
      var sh = !reduced && now < shakeUntil ? (shakeUntil - now) / 300 * cell * 0.18 : 0;
      ctx.save();
      if (sh) ctx.translate(Math.sin(now / 22) * sh, Math.cos(now / 17) * sh);
      /* ---- map plate: rock blocks, floor specks, then every glyph on top ---- */
      rr(mx - 3, my - 3, bw + 6, bh + 6, 8); ctx.fillStyle = 'rgba(255,255,255,.03)'; ctx.fill();
      for (var y = 0; y < ROWS; y++) for (var x = 0; x < COLS; x++) {
        var sx = mx + x * cell, sy = my + y * cell, sp = Math.max(1, cell * 0.12);
        if (map[y * COLS + x]) {
          rr(sx + 1, sy + 1, cell - 2, cell - 2, Math.max(1, cell * 0.22));
          ctx.fillStyle = hexA(C.violet, 0.16); ctx.fill();
          ctx.strokeStyle = hexA(C.violet, 0.3); ctx.lineWidth = 1; ctx.stroke();
        } else if ((x + y) % 2 === 0) {
          ctx.fillStyle = hexA(C.cyan, 0.05); ctx.fillRect(sx + cell * 0.44, sy + cell * 0.44, sp, sp);
        }
      }
      var i2, e, it, beat = reduced ? 1 : 0.85 + 0.15 * Math.sin(now / 260);
      glyph('▼', mx + (stairs.x + 0.5) * cell, my + (stairs.y + 0.5) * cell, C.acid, cell * 0.8 * beat, 20);
      for (i2 = 0; i2 < items.length; i2++) {
        it = items[i2];
        glyph(it.kind === 'shift' ? '*' : '+', mx + (it.x + 0.5) * cell, my + (it.y + 0.5) * cell,
          it.kind === 'hp' ? C.acid : it.kind === 'shift' ? C.magenta : C.orange, cell * 0.85, 16);
      }
      for (i2 = 0; i2 < enemies.length; i2++) {
        e = enemies[i2];
        glyph(e.g, mx + (e.x + 0.5) * cell, my + (e.y + 0.5) * cell, e.col, cell * 0.9, 18);
        if (e.hp < e.max) {              // damage pip above a wounded monster
          ctx.fillStyle = hexA(C.ink, 0.8);
          ctx.fillRect(mx + e.x * cell + cell * 0.2, my + e.y * cell + cell * 0.06, cell * 0.6 * (e.hp / e.max), 2);
        }
      }
      var hurt = !reduced && now < hurtUntil;
      glyph('@', mx + (px + 0.5) * cell, my + (py + 0.5) * cell, hurt ? C.magenta : C.cyan, cell * 1.05, 24);
      ctx.save();                       // visor dot shows the facing
      ctx.fillStyle = C.bg; ctx.beginPath();
      ctx.arc(mx + (px + 0.5 + fx * 0.22) * cell - fy * cell * 0.16,
        my + (py + 0.5 + fy * 0.22) * cell + fx * cell * 0.16, Math.max(1, cell * 0.1), 0, Math.PI * 2);
      ctx.fill(); ctx.restore();
      ctx.restore();
      /* ---- CRT polish: scanlines + vignette, applied to the WORLD only ----
         Drawn before the HUD so the readouts and touch controls stay bright. */
      if (!reduced) { ctx.fillStyle = 'rgba(0,0,0,.16)';
        for (var sl = 0; sl < h; sl += 3) ctx.fillRect(0, sl, w, 1); }
      var vig = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75);
      vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(0,0,0,.55)');
      ctx.fillStyle = vig; ctx.fillRect(0, 0, w, h);
      /* ---- HUD: score / depth / hp / stats / log ---- */
      var fs = Math.round(clamp(h * 0.042, 11, 18)), lh = fs + 4, pad2 = Math.max(8, w * 0.03), top = fs + 2;
      var half = w / 2 - pad2 - 8;
      var scoreS = 'SCORE ' + score, bestS = 'BEST ' + (bestEver || 0), floorS = 'FLOOR ' + (depth + 1);
      ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      // Line 1 is laid out from measured text, so a narrow canvas shrinks the
      // type instead of letting SCORE, FLOOR and BEST run into each other.
      fs = fit(fs, function (s) {
        ctx.font = '700 ' + s + 'px Rajdhani, system-ui, sans-serif';
        return ctx.measureText(scoreS).width <= half && ctx.measureText(bestS).width <= half &&
          ctx.measureText(floorS).width <= half * 1.4;
      });
      ctx.font = '700 ' + fs + 'px Rajdhani, system-ui, sans-serif';
      ctx.fillStyle = C.ink; ctx.fillText(scoreS, pad2, top);
      ctx.textAlign = 'right'; ctx.fillStyle = C.dim; ctx.fillText(bestS, w - pad2, top);
      ctx.textAlign = 'center'; ctx.fillStyle = C.magenta; ctx.fillText(floorS, w / 2, top);
      top += lh + 2;
      // Line 2: HP bar + HP count on the left, ATK/DEF/shifts on the right. The
      // bar gives up width (then the type size) before the two items can touch.
      var hpS = 'HP ' + Math.max(0, pHp) + '/' + pMaxHp;
      var atkS = 'ATK ' + pAtk + '  DEF ' + pDef + '  ✦' + pShifts;
      var avail = w - 2 * pad2, barW = 0;
      var f2 = fs;
      for (; f2 >= 9; f2--) {
        ctx.font = '700 ' + f2 + 'px Rajdhani, system-ui, sans-serif';
        var hw = ctx.measureText(hpS).width, aw = ctx.measureText(atkS).width;
        var b = Math.min(w * 0.42, 150, avail - hw - aw - 18);
        if (b >= f2 * 1.6) { barW = b; break; }
        barW = 0;
        if (hw + aw + 14 <= avail) break;   // no room for a bar: two text items still fit
      }
      f2 = Math.max(9, f2);
      var frac = clamp(pHp / pMaxHp, 0, 1);
      if (barW > 0) {
        ctx.fillStyle = hexA(C.ink, 0.14); rr(pad2, top - f2 * 0.5, barW, f2, f2 * 0.4); ctx.fill();
        ctx.fillStyle = frac > 0.55 ? C.acid : frac > 0.25 ? C.orange : C.magenta;
        ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = reduced ? 0 : 10;
        rr(pad2, top - f2 * 0.5, Math.max(2, barW * frac), f2, f2 * 0.4); ctx.fill();
        ctx.shadowBlur = 0;
      }
      ctx.font = '700 ' + f2 + 'px Rajdhani, system-ui, sans-serif';
      ctx.textAlign = 'left'; ctx.fillStyle = C.dim;
      ctx.fillText(hpS, pad2 + (barW > 0 ? barW + 8 : 0), top);
      ctx.textAlign = 'right'; ctx.fillStyle = C.cyan;
      ctx.fillText(atkS, w - pad2, top);
      top += lh + 2;
      // The log is the longest text on the canvas, so its size is capped by the
      // width too and every line is fitted to the room left of the right margin.
      ctx.textAlign = 'left';
      var logWant = Math.min(h * 0.034, w * 0.038), logW = w - pad2 - 4;
      for (i2 = log.length - 1; i2 >= 0; i2--) {
        if (top > my - cell * 0.6) break;     // the log never draws over the map
        ctx.fillStyle = i2 === log.length - 1 ? hexA(C.orange, 0.95) : hexA(C.dim, 0.75);
        fitText(log[i2], logW, '600', 'Rajdhani, system-ui, sans-serif', logWant, 9);
        ctx.fillText(log[i2], pad2, top);
        top += lh - 2;
      }
      /* ---- touch controls (always drawn, so desktop players see the map too) ---- */
      drawPad(pressed);
      drawButton(btnAtk, 'ATK', C.magenta, pressed === 'ATK');
      drawButton(btnShift, '✦' + pShifts, C.violet, pressed === 'SHIFT');
      /* ---- state card last: title / paused / round over sit above everything ---- */
      if (over) card('GAME OVER', 'SCORE ' + score + '  ·  FLOOR ' + (depth + 1) + (isRecord ? '  ·  NEW BEST' : ''), C.magenta, 'TAP, SPACE or RESTART to run again');
      else if (paused) card(depth ? 'PAUSED' : 'ROGUE SHIFT', depth ? 'Tap or press a key to resume' : 'Shift the floor. Grab loot. Find the stairs.', C.cyan, depth ? null : 'TAP, ARROWS or WASD to begin');
    }
    /* -------------------------- Single rAF loop -------------------------- */
    var pressed = null;
    function frame(now) {
      if (destroyed) return;   // guard: destroy() can land between frames
      if (pressed && now - pressedAt > 220) pressed = null;   // visual press release
      syncStatus();
      draw(now);
      if (!destroyed) rafId = requestAnimationFrame(frame);   // destroy() may land during draw
    }
    /* ------------------- Input: keyboard + pointer ------------------- */
    var sx = 0, sy = 0, swiping = false, btnId = 0, pressedAt = 0;
    function press(id) { pressed = id; pressedAt = performance.now(); }
    function actDir(name) {
      if (over) { resetRun(); return; }
      move(DIRS[name].x, DIRS[name].y);
    }
    function doRestart() { if (over) { resetRun(); return true; } return false; }
    function onKeyDown(e) {
      if (destroyed || e.metaKey || e.ctrlKey || e.altKey) return;
      var a = document.activeElement;
      if (e.code === 'Space' || e.code === 'Enter') {
        if (a && a !== canvas && /^(BUTTON|INPUT|SELECT|TEXTAREA|A|SUMMARY)$/.test(a.tagName)) return;
        e.preventDefault();
        if (doRestart()) return;
        paused = false;
        if (e.code === 'Space') strikeAhead();   // Enter only clears the pause / start card
        return;
      }
      if (e.code === 'KeyE' || e.code === 'KeyX' || e.code === 'KeyQ') { e.preventDefault(); if (doRestart()) return; paused = false; doShift(); return; }
      if (e.code === 'KeyR') { e.preventDefault(); resetRun(); return; }
      var d = KEYS[e.code] || KEYS[e.key];
      if (d) { e.preventDefault(); actDir(d); }
    }
    function local(e) {
      var r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }
    function onPointerDown(e) {
      if (destroyed || (e.button !== undefined && e.button !== 0)) return;
      if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
      var pt = local(e);
      btnId = 0;
      if (inRect(pt, pad.up)) { btnId = 1; press('↑'); }
      else if (inRect(pt, pad.down)) { btnId = 2; press('↓'); }
      else if (inRect(pt, pad.left)) { btnId = 3; press('←'); }
      else if (inRect(pt, pad.right)) { btnId = 4; press('→'); }
      else if (inCircle(pt, btnAtk)) { btnId = 5; press('ATK'); }
      else if (inCircle(pt, btnShift)) { btnId = 6; press('SHIFT'); }
      else { sx = e.clientX; sy = e.clientY; swiping = true; }
      e.preventDefault();
    }
    function onPointerUp(e) {
      if (destroyed) return;
      var id = btnId; btnId = 0; swiping = false;
      if (id) {                                   // a control was pressed: act once, on release
        if (doRestart()) return;
        if (id === 1) move(0, -1); else if (id === 2) move(0, 1);
        else if (id === 3) move(-1, 0); else if (id === 4) move(1, 0);
        else if (id === 5) strikeAhead(); else doShift();
        return;
      }
      if (over) { resetRun(); return; }          // tap anywhere restarts a dead run
      if (paused) { paused = false; return; }    // any touch starts / resumes the run
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) < FLICK && Math.abs(dy) < FLICK) return;  // a flick on the map steers
      move(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : -1) : 0, Math.abs(dx) > Math.abs(dy) ? 0 : (dy > 0 ? 1 : -1));
    }
    function onPointerCancel() { swiping = false; btnId = 0; pressed = null; }
    function onResize() { if (!destroyed) resize(); }
    function onBlur() { if (!destroyed && !over) paused = true; pressed = null; }   // auto-pause on focus loss
    function onVisibility() { if (document.hidden) onBlur(); }
    // Every listener the game owns, in one table so teardown cannot miss one.
    var BIND = [[document, 'keydown', onKeyDown], [canvas, 'pointerdown', onPointerDown],
      [canvas, 'pointerup', onPointerUp], [canvas, 'pointercancel', onPointerCancel],
      [canvas, 'contextmenu', function (e) { e.preventDefault(); }],
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
    name: 'Rogue Shift',
    instructions:
      'ARROW KEYS or WASD to step one tile — bump a monster to attack it. SPACE strikes the tile you ' +
      'face, E (or the ✦ button) burns a SHIFT to reroll every room and corridor while you stay put. ' +
      'Each turn the monsters move, so every tap costs you something. Grab + and * drops for ATK, DEF, ' +
      'HP and extra shifts, then stand on ▼ to descend — deeper floors pack more monsters and hit ' +
      'harder. On touch use the on-screen D-pad, ATK and ✦, or flick across the map. R restarts.',
    start: start
  };
})();
