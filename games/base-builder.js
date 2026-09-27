/**
 * PIXEL RUSH — games/base-builder.js — "Base Builder"
 * Contract (GAME-CONTRACT.md): window.PixelGame = { name, instructions, start(root, api) }
 * with api = { setScore(n), setBest(n), gameOver(score) }; start() returns { destroy() }.
 * Self-contained: no imports, no dependencies, no assets — one <canvas> + 2D ctx. Every
 * listener, timer and rAF id created in start() is torn down in destroy().
 *
 * The loop: every building you place pays rent from the day it lands, but only earns
 * its upkeep back as its population fills. Rent climbs superlinearly from day 8.
 * Reach DAY 30 alive and you win; let credits hit zero and the run is over.
 */
(function () {
  'use strict';
  /* -------------------------------- Tuning -------------------------------- */
  var STORE_KEY = 'pixelrush.base-builder.best'; // localStorage: all-time best score
  var HINT_KEY  = 'pixelrush.base-builder.hint';  // localStorage: has the goal card been seen
  var COLS = 6, ROWS = 6, CELLS = COLS * ROWS;
  var MAX_LV = 3, MAX_POP = 3;    // level cap; population cap scales with level
  var WIN_DAY = 30, WIN_BONUS = 30; // survive this long and the base holds; bonus to the score
  var START_CREDITS = 90, REFUND = 0.5;
  var DAY_BASE = 2600, DAY_FALLOFF = 26, DAY_MIN = 1000; // ms per day, shrinking as you grow
  var RENT_GRACE = 8, RENT_EXP = 1.5, RENT_K = 9.2;  // days of free grace, then a steep curve
  var DROP_EVERY = 3, DROP_A = 6, DROP_B = 2.5;      // supply drop cadence
  var UP_EXP = 1.65; // upkeep is superlinear in level, but slower than income, so upgrades pay
  /* Building types. `base` is income/day at full population, level 1. `up` is
     upkeep/day at level 1 (scaled by lv^UP_EXP). Every type nets positive from the
     moment it lands, so placing a building is always an immediate, visible gain. */
  var TYPES = [
    { short: 'HAB', name: 'HABITAT',    base: 3,  up: 1, cost: 8,  w: 0.86, h: 0.34, token: '--cyan',    fb: '#22e7ff' },
    { short: 'FRM', name: 'FARM',       base: 7,  up: 2, cost: 14, w: 0.94, h: 0.28, token: '--acid',     fb: '#c8ff2e' },
    { short: 'FAB', name: 'FABRICATOR', base: 13, up: 4, cost: 24, w: 0.74, h: 0.42, token: '--orange',   fb: '#ff8a3d' },
    { short: 'NEX', name: 'RUSH CORE',  base: 24, up: 7, cost: 42, w: 0.50, h: 0.56, token: '--magenta',  fb: '#ff2fb9' }
  ];
  var STYLES = '.bb{position:relative;width:100%;height:100%;overflow:hidden;touch-action:none;' +
    'user-select:none;-webkit-tap-highlight-color:transparent;' +
    'font-family:var(--font-body,"Rajdhani",system-ui,sans-serif);color:var(--ink,#f2f5ff)}' +
    '.bb canvas{display:block;width:100%;height:100%;outline:none}';
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function signed(n) { return (n >= 0 ? '+' : '') + n; }
  /** Daily base tax. Flat through the grace period, then superlinear — the difficulty ramp. */
  function rent(d) { return Math.round(RENT_K * Math.pow(Math.max(0, d - RENT_GRACE), RENT_EXP)); }
  /** Income per day. Starts at half value and climbs as workers move in. */
  function incomeOf(b) {
    var t = TYPES[b.type], cap = MAX_POP * b.lv;
    return Math.round(t.base * b.lv * (0.5 + 0.5 * b.pop / cap));
  }
  function upkeepOf(b) { return Math.round(TYPES[b.type].up * Math.pow(b.lv, UP_EXP)); }
  function buildCost(t, lv) { return t.cost + Math.round(t.cost * 0.8 * (lv - 1)); }
  function dayMs(d) { return Math.max(DAY_MIN, DAY_BASE - DAY_FALLOFF * d); }
  function readLS(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function writeLS(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  function readBest() {
    var v = parseInt(readLS(STORE_KEY), 10);
    return isFinite(v) && v > 0 ? v : null; // private mode returns null
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
    /* -------------------------------- DOM -------------------------------- */
    var wrap = document.createElement('div'); wrap.className = 'bb';
    var canvas = document.createElement('canvas');
    canvas.setAttribute('tabindex', '0'); canvas.setAttribute('role', 'application');
    canvas.setAttribute('aria-label',
      'Base Builder. Survive to day 30. Tap a cell then tap a card to build, or use arrow keys and 1 to 4.');
    var live = document.createElement('div'); // screen-reader announcements
    live.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0)';
    live.setAttribute('aria-live', 'polite');
    wrap.appendChild(canvas); wrap.appendChild(live);
    var styleTag = document.createElement('style');
    styleTag.textContent = STYLES; wrap.appendChild(styleTag); root.appendChild(wrap); // scoped to .bb
    var ctx = canvas.getContext('2d');
    if (!ctx) { root.removeChild(wrap); return { destroy: function () {} }; }
    var rafId = 0, destroyed = false;
    var reduced = !!(window.PX && window.PX.reduced) || !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    /* ----------------------------- Game state ----------------------------- */
    var grid = [];        // CELLS slots, each null or {type,lv,pop,invest,born}
    var day = 0, credits = 0, score = 0, peak = 0, gross = 0, upkeep = 0, tax = 0;
    var sel = 14, palOpen = false, booted = false, paused = false, over = false, won = false;
    var firstBuild = false, isRecord = false, bestEver = readBest(), acc = 0, last = 0;
    var msg = '', msgAt = -1e9, shakeAt = -1e9;
    var floats = [];      // rising "+9 CR/DAY" tags anchored to a cell
    var firstEver = readLS(HINT_KEY) === null; // full goal card only on the very first run
    // The run boots *paused*, so `booted` alone cannot gate the intro card — `intro`
    // is its own flag, cleared by the first tap or keypress.
    var intro = firstEver;
    /* ---- HUD status: the shell also drives #game-status, but it cannot know
       about this game's own paused/ready states, so we report them ourselves. */
    var setStatusApi = typeof api.setStatus === 'function' ? api.setStatus : null;
    var statusText = null;
    function setStatusNow(t) { if (setStatusApi && t !== statusText) { statusText = t; setStatusApi(t); } }
    function syncStatus() {
      setStatusNow(over ? (won ? 'Base secured' : 'Game over')
        : intro ? 'Ready' : paused ? 'Paused' : 'Playing');
    }
    /* ----------------- Sizing (crisp devicePixelRatio) ----------------- */
    /* The shell pins the stage to 16/9, so on a phone the canvas is only ~200 px
       tall. Every band below is a *fraction* of cssH with a small floor: fixed
       74/92/48 px bands used to swallow the whole canvas and left a 6 px grid. */
    var dpr = 1, cssW = 1, cssH = 1, cell = 10, gx = 0, gy = 0;
    var hudH = 90, botH = 60, palH = 120, palTop = 0, compact = false, warmup = 0;
    var LEGEND_W = 176, legendW = 0;
    function resize() {
      var r = wrap.getBoundingClientRect();
      cssW = Math.max(1, Math.round(r.width)); cssH = Math.max(1, Math.round(r.height));
      dpr = clamp(window.devicePixelRatio || 1, 1, 2); // cap DPR: 2 is plenty and phone-safe
      canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
      canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      compact = cssH < 260 || cssW < 420;
      // A phone stage is ~200 px tall, so the HUD takes a bigger share there.
      hudH = Math.round(clamp(cssH * (compact ? 0.27 : 0.17), 46, compact ? 96 : 92));
      palH = Math.round(clamp(cssH * (compact ? 0.19 : 0.16), 40, 120));
      // On a phone there is no room for a bottom bar: the pause chip docks in the
      // HUD gutter instead and the whole saved band goes to the board.
      botH = compact ? 0 : Math.round(clamp(cssH * 0.075, 24, 44));
      palTop = cssH - botH - palH;                       // palette band's top edge
      var band = Math.max(24, palTop - hudH);
      // On a wide stage the 6x6 is square and leaves the right third empty, so the
      // spare width carries the building ledger instead of dead black.
      legendW = (!compact && cssW > 700) ? LEGEND_W : 0;
      var availW = cssW - legendW;
      // Grid takes the band between HUD and palette; square, centred, never overflowing.
      cell = Math.max(6, Math.floor(Math.min(availW - 12, band) / COLS));
      var gw = cell * COLS, gh = cell * ROWS;
      gx = Math.round((availW - gw) / 2); gy = Math.round(hudH + (band - gh) / 2);
    }
    resize();
    function token(n, fb) { // pull a site custom property, with a hard fallback
      var v = getComputedStyle(document.documentElement).getPropertyValue(n);
      return (v && v.trim()) || fb; }
    var C = { bg: token('--bg', '#05060f'), ink: token('--ink', '#f2f5ff'), dim: token('--ink-dim', '#a7b0d0'),
      cyan: token('--cyan', '#22e7ff'), magenta: token('--magenta', '#ff2fb9'), acid: token('--acid', '#c8ff2e'),
      orange: token('--orange', '#ff8a3d'), violet: token('--violet', '#8b5cf6') };
    TYPES.forEach(function (t) { t.color = token(t.token, t.fb); });
    function hexA(hex, a) { // #rrggbb + alpha -> rgba()
      hex = (hex || '#fff').trim().replace('#', ''); var n = parseInt(hex, 16);
      return isFinite(n) ? 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')'
        : 'rgba(255,255,255,' + a + ')'; }
    function rr(x, y, w, h, r) { // rounded-rect path, with a pre-roundRect fallback
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
    }
    function text(str, x, y, size, color, align, weight) {
      ctx.font = (weight || 700) + ' ' + size + 'px Rajdhani, system-ui, sans-serif';
      ctx.textAlign = align || 'left'; ctx.textBaseline = 'middle';
      ctx.fillStyle = color; ctx.fillText(str, x, y);
    }
    /* ---------------------------- Game logic ---------------------------- */
    function recompute() {
      gross = 0; upkeep = 0;
      for (var i = 0; i < CELLS; i++) if (grid[i]) { gross += incomeOf(grid[i]); upkeep += upkeepOf(grid[i]); }
      tax = rent(day);
      if (day > 0 && gross > peak) peak = gross; // peak income starts counting once a day has passed
    }
    function updateScore() {
      score = day + peak + (won ? WIN_BONUS : 0); setScore(score);
      if (bestEver === null || score > bestEver) {
        bestEver = score; isRecord = true; writeLS(score); setBest(score);
      }
    }
    function say(s) { msg = s; msgAt = performance.now(); }
    function bump() { recompute(); updateScore(); }
    /** Rise-and-fade tag over a cell, so a build is never a silent state change. */
    function floatCell(i, s, color) {
      floats.push({ i: i, s: s, c: color, t0: performance.now() });
      if (floats.length > 12) floats.shift();
    }
    function resetRun() {
      grid = []; for (var i = 0; i < CELLS; i++) grid[i] = null;
      grid[14] = { type: 0, lv: 1, pop: 1, invest: buildCost(TYPES[0], 1), born: performance.now() };
      day = 0; credits = START_CREDITS; peak = 0; score = 0; isRecord = false; over = false; won = false;
      firstBuild = false; sel = 14; palOpen = false; acc = 0; last = performance.now();
      floats.length = 0;
      paused = false; booted = true; bump();
      if (bestEver !== null) setBest(bestEver);
      say('BUILD A HABITAT TO BEGIN');
      live.textContent = 'New run. Credits ' + START_CREDITS + ', day 1. Goal: survive to day ' + WIN_DAY + '.';
    }
    /** Advance one day: population grows, the ledger settles, rent bites. */
    function doDay() {
      day++;
      for (var i = 0; i < CELLS; i++) { var b = grid[i]; if (b && b.pop < MAX_POP * b.lv) b.pop++; }
      recompute();
      var net = gross - upkeep - tax;
      var drop = (day % DROP_EVERY === 0) ? DROP_A + Math.floor(day * DROP_B) : 0;
      var before = credits;
      credits += net + drop;
      bump();
      // Spell the day's arithmetic out: this is the line that makes the economy readable.
      say('DAY ' + day + '  ·  INC ' + gross + '  −  UPKEEP ' + upkeep + '  −  RENT ' + tax +
        (drop ? '  +  DROP ' + drop : '') + '  =  ' + signed(credits - before) + ' CR');
      if (compact) say('D' + day + '  ' + gross + '−' + upkeep + '−' + tax +
        (drop ? '+' + drop : '') + ' = ' + signed(credits - before));
      live.textContent = 'Day ' + day + '. Credits ' + credits + '. Income ' + gross +
        ', upkeep ' + upkeep + ', rent ' + tax + '.';
      if (net < 0 && day < WIN_DAY) shakeAt = performance.now();
      if (day >= WIN_DAY) { won = true; holdTheBase(); return; }
      if (credits < 0) bankrupt();
    }
    function holdTheBase() {
      if (over || destroyed) return;   // api.gameOver() may only fire once per run
      over = true; won = true; paused = false; palOpen = false;
      updateScore();
      live.textContent = 'Base secured on day ' + day + '. Final score ' + score + '.';
      gameOverCb(score);
    }
    function bankrupt() {
      if (over || destroyed) return;
      over = true; paused = false; palOpen = false; shakeAt = performance.now();
      live.textContent = 'Bankrupt on day ' + day + '. Final score ' + score + '.';
      gameOverCb(score);
    }
    /** Palette action: 0-3 build a type, 4 upgrade the selected cell, 5 demolish it. */
    function act(a) {
      if (destroyed || over || !booted) return;
      if (!palOpen) palOpen = true;
      var b = grid[sel], t = TYPES[a];
      if (a < 4) {
        var cost = buildCost(t, 1);
        if (b) { say('CELL OCCUPIED'); shakeAt = performance.now(); return; }
        if (credits < cost) { say('NEED ' + cost + ' CR'); shakeAt = performance.now(); return; }
        credits -= cost;
        // Starts with one worker in, so it earns from the very first day it exists.
        grid[sel] = { type: a, lv: 1, pop: 1, invest: cost, born: performance.now() };
        firstBuild = true; writeLS(HINT_KEY, '1');
        var inc = incomeOf(grid[sel]), up = upkeepOf(grid[sel]);
        floatCell(sel, signed(inc - up) + '/D', hexA(t.color, 0.95));
        say(t.name + '  +' + inc + ' CR/DAY  −' + up + ' UPKEEP');
      } else if (a === 4) {
        if (!b) { say('NOTHING HERE'); return; }
        if (b.lv >= MAX_LV) { say('MAX LEVEL'); return; }
        var up2 = buildCost(TYPES[b.type], b.lv + 1);
        if (credits < up2) { say('NEED ' + up2 + ' CR'); shakeAt = performance.now(); return; }
        credits -= up2; b.invest += up2; b.lv++;
        var dInc = incomeOf(b) - incomeOf({ type: b.type, lv: b.lv - 1, pop: b.pop, invest: 0 });
        var dUp = upkeepOf(b) - Math.round(TYPES[b.type].up * Math.pow(b.lv - 1, UP_EXP));
        floatCell(sel, 'LV ' + b.lv, hexA(C.violet, 0.95));
        floatCell(sel, signed(dInc - dUp) + '/D', hexA(C.violet, 0.8));
        say('UPGRADED TO L' + b.lv + '  ' + signed(dInc) + ' CR/DAY  ' + signed(-dUp) + ' UPKEEP');
      } else {
        if (!b) { say('NOTHING HERE'); return; }
        var back = Math.round(b.invest * REFUND); credits += back; grid[sel] = null;
        floatCell(sel, '+' + back + ' CR', hexA(C.orange, 0.95));
        say('SALVAGED  +' + back + ' CR');
      }
      bump();
    }
    /* ----------------------------- Palette ------------------------------ */
    /* Cards live inside the reserved strip at the BOTTOM of the stage. They used
       to be laid out from y=0 (palH - 16 - h), which put them straight through
       the HUD on every size and pushed the board off a phone entirely. */
    function palLayout() {
      var pad = 6, gap = 6, cols = 6, btns = [];
      var w = (cssW - pad * 2 - gap * (cols - 1)) / cols;
      var h = Math.max(20, Math.min(compact ? 40 : 68, palH - 8));
      var y = palTop + Math.max(2, (palH - h) / 2);
      for (var i = 0; i < 6; i++) btns.push({ x: pad + i * (w + gap), y: y, w: w, h: h, i: i });
      return btns;
    }
    function hit(r, x, y) { return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h; }
    /** Pause chip: bottom-right bar on roomy stages, HUD gutter on a phone.
        The compact chip is wide enough for the word PAUSE at 9 px — at 26 px the
        label overflowed the box and ran into the SCORE readout. */
    function pauseBtn() {
      if (compact) return { x: cssW - 48, y: 5, w: 42, h: 20 };
      var h = Math.max(20, botH - 12);
      return { x: cssW - 64, y: cssH - botH + Math.max(3, (botH - h) / 2), w: 54, h: h };
    }
    function cellRect(i) { return { x: gx + (i % COLS) * cell, y: gy + Math.floor(i / COLS) * cell }; }
    /* ---------------- Building ledger (wide stages only) ----------------
       The four building types, what each one earns and costs, plus the rent
       curve — the numbers you need to make every placement decision, sitting
       next to the board instead of buried in the instructions panel. */
    function drawLegend() {
      if (!legendW) return;
      var x = cssW - legendW + 8, w = legendW - 16, y0 = hudH + 4, h = palTop - hudH - 8;
      var f = Math.round(clamp(w * 0.085, 9, 12));
      var rowH = Math.min(30, Math.max(18, (h - 92) / 4));
      ctx.save();
      rr(x, y0, w, h, 10);
      ctx.fillStyle = 'rgba(3,4,10,.55)'; ctx.fill();
      ctx.strokeStyle = hexA(C.cyan, 0.22); ctx.lineWidth = 1; ctx.stroke();
      ctx.shadowColor = 'rgba(0,0,0,.85)'; ctx.shadowBlur = 4;
      var y = y0 + 4 + f;
      text('BUILDING LEDGER', x + 8, y, f, C.dim, 'left', 800);
      y += f + 8;
      for (var i = 0; i < TYPES.length; i++) {
        var t = TYPES[i], cy = y + rowH / 2;
        ctx.fillStyle = hexA(t.color, 0.85);
        ctx.fillRect(x + 8, cy - rowH * 0.32, 3, rowH * 0.64);
        text(t.short, x + 16, cy, f + 1, C.ink, 'left', 800);
        text('+' + t.base, x + w - 46, cy, f + 1, C.acid, 'right', 800);
        text('−' + t.up, x + w - 8, cy, f + 1, C.magenta, 'right', 800);
        y += rowH;
      }
      y += 6;
      ctx.strokeStyle = hexA(C.cyan, 0.18); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x + 8, y - 3); ctx.lineTo(x + w - 8, y - 3); ctx.stroke();
      var ry = y + f + 2;
      text('RENT NOW', x + 8, ry, f, C.dim, 'left', 700);
      text(String(tax), x + w - 8, ry, f + 2, C.magenta, 'right', 800);
      ry += f + 5;
      text('NEXT DAY', x + 8, ry, f, C.dim, 'left', 700);
      text(String(rent(day + 1)), x + w - 8, ry, f + 1, C.orange, 'right', 800);
      ry += f + 7;
      ctx.beginPath(); ctx.moveTo(x + 8, ry - 3); ctx.lineTo(x + w - 8, ry - 3); ctx.stroke();
      ry += f + 2;
      text('GOAL', x + 8, ry, f, C.dim, 'left', 700);
      text('DAY ' + WIN_DAY, x + w - 8, ry, f + 1, C.acid, 'right', 800);
      ctx.restore();
    }
    /* -------------------------- Single rAF loop -------------------------- */
    function drawBuilding(i, b, now) {
      var x = gx + (i % COLS) * cell, y = gy + Math.floor(i / COLS) * cell;
      var col = TYPES[b.type].color, t = TYPES[b.type];
      var p = 3;
      // Body proportions differ per type so the board is readable at a glance:
      // a wide low habitat, a flat farm, a tall fabricator, a narrow rush core.
      var bw = (cell - p * 2) * t.w, bh = cell * t.h * (1 + 0.10 * (b.lv - 1));
      var bx = x + (cell - bw) / 2, by = y + cell - p - bh;
      var fresh = now - b.born < 700 && !reduced;   // newly-placed buildings pop
      var grow = fresh ? 1 + 0.22 * (1 - (now - b.born) / 700) : 1;
      ctx.save();
      ctx.shadowColor = col; ctx.shadowBlur = (reduced ? 4 : 12) * (fresh ? 2 : 1);
      ctx.fillStyle = hexA(col, fresh ? 0.55 : 0.24);
      ctx.strokeStyle = hexA(col, 0.95); ctx.lineWidth = 1.5;
      var gh2 = bh * grow;
      rr(bx, y + cell - p - gh2, bw, gh2, Math.max(2, cell * 0.10));
      ctx.fill(); ctx.stroke();
      ctx.shadowBlur = 0;
      if (b.type === 3) { // rush core: a lit crown so the endgame building is unmistakable
        ctx.fillStyle = hexA(col, 0.95);
        ctx.beginPath(); ctx.arc(x + cell / 2, y + cell - p - gh2 - 3, Math.max(2, cell * 0.09), 0, 6.2832); ctx.fill();
      }
      if (b.type === 1) { // farm: furrow rows
        ctx.fillStyle = hexA(col, 0.55);
        for (var f = 1; f <= 2; f++) ctx.fillRect(bx + 2, y + cell - p - gh2 * (f / 3), bw - 4, 1);
      }
      if (b.type === 2) { // fabricator: a stack vent
        ctx.fillStyle = hexA(col, 0.8);
        ctx.fillRect(bx + bw * 0.6, y + cell - p - gh2 - Math.max(3, cell * 0.14), Math.max(2, bw * 0.18), Math.max(3, cell * 0.14));
      }
      // Population: lit windows. Level: pip row along the roof.
      for (var wI = 0; wI < MAX_POP * b.lv; wI++) {
        var wxp = wI % MAX_POP;
        ctx.fillStyle = wI < b.pop ? hexA(col, 0.95) : 'rgba(255,255,255,.14)';
        ctx.fillRect(bx + 3 + wxp * ((bw - 6) / MAX_POP), y + cell - p - gh2 * 0.55,
          Math.max(1, (bw - 6) / MAX_POP - 2), Math.max(1, gh2 * 0.26));
      }
      for (var l = 0; l < b.lv; l++) { ctx.fillStyle = hexA(col, 0.95); ctx.fillRect(bx + 3 + l * 6, y + cell - p - 3, 4, 2); }
      ctx.restore();
    }
    function drawCell(i, now) {
      var b = grid[i], x = gx + (i % COLS) * cell, y = gy + Math.floor(i / COLS) * cell;
      var p = 3;
      rr(x, y, cell, cell, Math.max(2, cell * 0.16));
      ctx.fillStyle = b ? 'rgba(255,255,255,.06)' : 'rgba(255,255,255,.02)';
      ctx.fill();
      // Every cell gets a visible border: without one, empty cells were the same
      // luminance as the board panel and the grid was invisible.
      ctx.strokeStyle = b ? hexA(TYPES[b.type].color, 0.45) : 'rgba(255,255,255,.20)';
      ctx.lineWidth = 1;
      if (!b) ctx.setLineDash([3, 3]);   // empty reads as "nothing here yet"
      ctx.stroke(); ctx.setLineDash([]);
      if (b) drawBuilding(i, b, now);
      // Live per-day income, on a dark chip so the number always clears contrast.
      if (b && cell >= 26) {
        var lbl = String(incomeOf(b)), fs = Math.max(8, Math.round(cell * 0.24));
        ctx.font = '800 ' + fs + 'px Rajdhani, system-ui, sans-serif';
        var tw = ctx.measureText(lbl).width;
        rr(x + 2, y + 2, tw + 6, fs + 4, 3);
        ctx.fillStyle = 'rgba(3,4,10,.86)'; ctx.fill();
        text(lbl, x + 5, y + 2 + (fs + 4) / 2, fs, TYPES[b.type].color, 'left', 800);
      }
      // Cursor: solid when keyboard-driven, dashed while the touch palette is open.
      if (i === sel && booted && (palOpen || !reduced)) {
        ctx.save();
        ctx.strokeStyle = palOpen ? C.acid : hexA(C.cyan, 0.8);
        ctx.shadowColor = ctx.strokeStyle; ctx.shadowBlur = reduced ? 0 : 12;
        ctx.lineWidth = 2;
        if (palOpen && !reduced) ctx.setLineDash([5, 4]);
        rr(x + 1.5, y + 1.5, cell - 3, cell - 3, Math.max(2, cell * 0.16)); ctx.stroke();
        ctx.restore();
      }
    }
    /** Shrink-to-fit: the ledger line is wide, and a phone canvas is 343 px. */
    function fitText(str, maxW, size, floor) {
      var s = size;
      while (s > floor) {
        ctx.font = '800 ' + s + 'px Rajdhani, system-ui, sans-serif';
        if (ctx.measureText(str).width <= maxW) return s;
        s -= 0.5;
      }
      return s;
    }
    function draw(now) {
      var w = cssW, h = cssH, net = gross - upkeep - tax;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // reset: the shake below offsets the transform
      var shake = (!reduced && now - shakeAt < 220) ? (now - shakeAt) / 220 : 0;
      if (shake) ctx.translate(Math.sin(now / 12) * shake * 3, 0);
      ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);
      /* ---- Grid (the world) ---- */
      // Board panel: gives the 6x6 a visible edge so the play area reads as a
      // play area, and stops empty cells dissolving into the background.
      var gpad = clamp((Math.max(24, palTop - hudH) - cell * ROWS) / 2, 2, 8);
      ctx.save();
      rr(gx - gpad, gy - gpad, cell * COLS + gpad * 2, cell * ROWS + gpad * 2, 10);
      ctx.fillStyle = hexA(C.cyan, 0.05); ctx.fill();
      ctx.strokeStyle = hexA(C.cyan, 0.30); ctx.lineWidth = 1.5; ctx.stroke();
      ctx.restore();
      for (var i = 0; i < CELLS; i++) drawCell(i, now);
      /* ---- CRT polish: scanlines + vignette, over the WORLD only ----
         Drawn before the HUD/readouts/buttons so those stay bright and legible. */
      if (!reduced) { ctx.fillStyle = 'rgba(0,0,0,.16)';
        for (var sy = 0; sy < h; sy += 3) ctx.fillRect(0, sy, w, 1); }
      var vig = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75);
      vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(0,0,0,.55)');
      ctx.fillStyle = vig; ctx.fillRect(0, 0, w, h);
      /* ---- HUD: the whole economy, three rows, nothing hidden behind a fade.
         Above the CRT layer, with a soft dark shadow so text reads over any world colour. */
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,.85)'; ctx.shadowBlur = 4;
      var f1 = compact ? 13 : Math.round(clamp(hudH * 0.20, 12, 19));
      var f2 = compact ? 10 : Math.round(clamp(hudH * 0.15, 10, 15));
      var f3 = compact ? 9  : Math.round(clamp(hudH * 0.13, 9,  13));
      var pad = compact ? 6 : 10;
      // In compact mode the pause chip owns the right gutter, so the HUD stops short of it.
      var right = compact ? w - 54 : w - pad;
      var y1 = hudH * 0.20, y2 = hudH * 0.47, y3 = hudH * 0.72;
      // Row 1 — where you are against the goal, and your score.
      text('DAY ' + day + '/' + WIN_DAY, pad, y1, f1, day >= WIN_DAY - 3 ? C.acid : C.cyan, 'left', 800);
      text('SCORE ' + score, right, y1, f1, C.ink, 'right', 800);
      if (!compact) text('BEST ' + (bestEver || 0), w / 2, y1, f2, C.dim, 'center', 600);
      // Row 2 — the bank, and the day's bottom line.
      text((credits < 0 ? '-' : '') + Math.abs(credits) + ' CR', pad, y2, f1, credits >= 0 ? C.ink : C.magenta, 'left', 800);
      var netCol = net >= 0 ? C.acid : C.magenta; // acid when in the black, magenta when in the red
      text('NET ' + signed(net), right, y2, f1, netCol, 'right', 800);
      // Row 3 — the three numbers the whole game turns on, always on screen. On a
      // phone there is no spare strip for the day ticker, so the ledger and the
      // fresh day report share this row; the report is itself the ledger.
      var fresh = msg && now - msgAt < 2400;
      var ledger = 'INC ' + gross + '  ·  UPKEEP ' + upkeep + '  ·  RENT ' + tax;
      if (compact && fresh) {
        var fs3 = fitText(msg, w - pad * 2, f3, 7);
        text(msg, w / 2, y3, fs3, netCol, 'center', 800);
      } else {
        text(ledger, w / 2, y3, fitText(ledger, w - pad * 2, f3, 7), C.dim, 'center', 700);
      }
      ctx.restore();
      // Bars: the bright cyan chunk is the day ticking; the acid track behind it
      // is how far through the 30-day run you are. Two bars, never ambiguous.
      var dm = dayMs(day), p = clamp(acc / dm, 0, 1);
      var gp = clamp(day / WIN_DAY, 0, 1);
      var bw = (compact ? w - 12 : w - pad * 2), bx0 = compact ? 6 : pad;
      var gby = hudH - (compact ? 11 : 12), gbh = compact ? 3 : 4;
      ctx.fillStyle = 'rgba(255,255,255,.07)'; ctx.fillRect(bx0, gby, bw, gbh);
      ctx.fillStyle = hexA(C.acid, 0.55); ctx.fillRect(bx0, gby, bw * gp, gbh);
      var tby = gby + gbh + 2, tbh = compact ? 2 : 3;
      ctx.fillStyle = 'rgba(255,255,255,.07)'; ctx.fillRect(bx0, tby, bw, tbh);
      ctx.fillStyle = hexA(C.cyan, 0.9); ctx.fillRect(bx0, tby, bw * p, tbh);
      drawLegend();
      /* ---- Selected cell: what exactly this building does, in words and numbers ---- */
      var selB = grid[sel];
      if (palOpen && selB) {
        var r2 = cellRect(sel), fs2 = Math.max(9, Math.round(clamp(cell * 0.24, 9, 15)));
        var si = incomeOf(selB), su = upkeepOf(selB);
        var tag = TYPES[selB.type].short + ' L' + selB.lv + '  +' + si + '  −' + su;
        ctx.save();
        ctx.font = '800 ' + fs2 + 'px Rajdhani, system-ui, sans-serif';
        var tw2 = ctx.measureText(tag).width;
        rr(r2.x + cell / 2 - tw2 / 2 - 5, r2.y + cell + 3, tw2 + 10, fs2 + 6, 4);
        ctx.fillStyle = 'rgba(3,4,10,.92)'; ctx.fill();
        ctx.strokeStyle = hexA(TYPES[selB.type].color, 0.7); ctx.lineWidth = 1; ctx.stroke();
        text(tag, r2.x + cell / 2, r2.y + cell + 3 + (fs2 + 6) / 2, fs2, C.ink, 'center', 800);
        ctx.restore();
      }
      /* ---- Build palette (always reserved so the grid never jumps) ---- */
      var btns = palLayout();
      for (var b2 = 0; b2 < btns.length; b2++) {
        var r = btns[b2], idx = r.i, on = palOpen, bcell = grid[sel];
        var col = idx < 4 ? TYPES[idx].color : (idx === 4 ? C.violet : C.orange);
        var label = idx < 4 ? TYPES[idx].short : (idx === 4 ? 'UP' : 'DEL');
        var cost = idx < 4 ? buildCost(TYPES[idx], 1)
          : (idx === 4 ? (bcell ? buildCost(TYPES[bcell.type], bcell.lv + 1) : 0) : (bcell ? Math.round(bcell.invest * REFUND) : 0));
        var afford = idx === 4 ? !!(bcell && bcell.lv < MAX_LV && credits >= cost) : (idx === 5 ? !!bcell : (!bcell && credits >= cost));
        rr(r.x, r.y, r.w, r.h, 8);
        ctx.fillStyle = on ? hexA(col, 0.14) : 'rgba(255,255,255,.03)'; ctx.fill();
        ctx.strokeStyle = on ? hexA(col, afford ? 0.9 : 0.3) : 'rgba(255,255,255,.12)';
        ctx.lineWidth = 1.5; ctx.stroke();
        var fs = Math.round(clamp(r.h * 0.30, 9, 15));
        text(String(idx + 1) + ' ' + label, r.x + r.w / 2, r.y + r.h * 0.36, fs, on && afford ? C.ink : C.dim, 'center', 800);
        var sub = idx === 4 ? (bcell ? (bcell.lv < MAX_LV ? cost + 'cr' : 'MAX') : '-')
          : (idx === 5 ? (bcell ? '+' + cost : '-') : cost + 'cr');
        text(sub, r.x + r.w / 2, r.y + r.h * 0.72, Math.max(8, fs - 2), on && afford ? hexA(col, 0.95) : C.dim, 'center', 600);
      }
      /* ---- Pause chip: bottom bar on a full stage, HUD gutter on a phone ---- */
      var pb = pauseBtn();
      rr(pb.x, pb.y, pb.w, pb.h, 8);
      ctx.fillStyle = 'rgba(255,255,255,.05)'; ctx.fill();
      ctx.strokeStyle = hexA(C.cyan, 0.4); ctx.lineWidth = 1.5; ctx.stroke();
      text(paused ? 'PLAY' : 'PAUSE', pb.x + pb.w / 2, pb.y + pb.h / 2,
        Math.round(clamp(pb.h * 0.34, 9, 14)), C.cyan, 'center', 800);
      /* ---- Floating build tags: the "that did something" layer ---- */
      ctx.save();
      ctx.font = '900 ' + Math.max(10, Math.round(clamp(cell * 0.30, 10, 17))) + 'px Rajdhani, system-ui, sans-serif';
      for (var fI = floats.length - 1; fI >= 0; fI--) {
        var fl = floats[fI], age = now - fl.t0;
        if (age > 1000) { floats.splice(fI, 1); continue; }
        var k = age / 1000, fr = cellRect(fl.i);
        ctx.globalAlpha = 1 - k * k;
        ctx.shadowColor = 'rgba(0,0,0,.9)'; ctx.shadowBlur = 6;
        text(fl.s, fr.x + cell / 2, fr.y + cell / 2 - k * (cell * 0.9), ctx.font.match(/(\d+)px/)[1] * 1, fl.c, 'center', 900);
      }
      ctx.restore();
      /* ---- Message bar: the day's ledger, or the standing hint. A full stage has
         an empty bottom strip next to the PAUSE chip, so the report lives there;
         a phone spends that row on the ledger instead (see the HUD above). ---- */
      if (!compact) {
        var hint = !firstBuild ? 'GOAL: REACH DAY ' + WIN_DAY + '  ·  KEEP NET POSITIVE'
          : 'TAP A CELL, THEN TAP A CARD TO BUILD';
        var mtxt = fresh ? msg : hint;
        var pbw = pauseBtn();
        var availW2 = pbw.x - 10 - pad - 8;
        var mfs = fitText(mtxt, availW2 - 18, Math.max(9, Math.round(clamp(cssW * 0.024, 9, 15))), 8);
        var mw = Math.min(availW2, ctx.measureText(mtxt).width + 18);
        var mh = mfs + 10;
        var mx = pad + 4, my = cssH - botH + (botH - mh) / 2;
        rr(mx, my, mw, mh, 6);
        ctx.fillStyle = 'rgba(3,4,10,.92)'; ctx.fill();
        ctx.strokeStyle = fresh ? hexA(netCol, 0.7) : hexA(C.cyan, 0.45); ctx.lineWidth = 1.5; ctx.stroke();
        text(mtxt, mx + mw / 2, my + mh / 2, mfs, fresh ? netCol : C.dim, 'center', 800);
      }
      /* ---- State card stays last, above the HUD ---- */
      if (intro && !over) {
        card('BASE BUILDER', 'GOAL: SURVIVE TO DAY ' + WIN_DAY, C.cyan,
          'KEEP INCOME ABOVE UPKEEP + RENT', 'TAP TO START  ·  tap a cell, then tap a card to place');
      } else if (paused && !over) {
        card('PAUSED', 'Day ' + day + '/' + WIN_DAY + '  ·  ' + credits + ' CR  ·  net ' + signed(net),
          C.cyan, 'TAP or press SPACE to resume');
      }
      if (over) {
        if (won) card('BASE SECURED', 'DAY ' + day + '  ·  SCORE ' + score + (isRecord ? '  ·  NEW BEST' : ''),
          C.acid, 'TAP or press SPACE to build again');
        else card('BANKRUPT', 'DAY ' + day + '/' + WIN_DAY + '  ·  SCORE ' + score + (isRecord ? '  ·  NEW BEST' : ''),
          C.magenta, 'TAP or press SPACE to rebuild');
      }
    }
    /** Centred overlay: big neon title, a line of sub-copy, up to two hint lines.
        Everything is clamped to the canvas box so it can never run off a short
        (phone) stage — the lines are stacked from the middle outwards. */
    function card(title, sub, color, hint, hint2) {
      ctx.fillStyle = hexA(C.bg, compact ? 0.94 : 0.86); ctx.fillRect(0, 0, cssW, cssH);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      // A phone stage is TALLER than it is wide, so a size taken from cssH alone
      // balloons: the title and hint lines ran off both edges. Cap by the smaller
      // dimension, then shrink-to-fit as a hard guarantee.
      var tSize = Math.round(clamp(Math.min(cssH * 0.12, cssW * 0.11), 19, Math.max(19, cssH * 0.19)));
      var sSize = Math.round(clamp(Math.min(cssH * 0.045, cssW * 0.05), 10, Math.min(20, tSize * 0.52)));
      var fitw = cssW - Math.max(16, cssW * 0.07);
      function fitTo(str, size, floor, weight, family) {
        var s = size;
        while (s > floor) {
          ctx.font = weight + ' ' + s + 'px ' + family + ', system-ui, sans-serif';
          if (ctx.measureText(str).width <= fitw) break;
          s -= 0.5;
        }
        return s;
      }
      tSize = Math.round(fitTo(title, tSize, 15, 900, 'Orbitron'));
      sSize = Math.round(fitTo(sub, sSize, 10, 600, 'Rajdhani'));
      var h1Size = Math.round(fitTo(hint, Math.round(sSize * 0.92), 8, 600, 'Rajdhani'));
      var h2Size = hint2 ? Math.round(fitTo(hint2, Math.round(sSize * 0.92), 8, 600, 'Rajdhani')) : 0;
      var mid = cssH / 2;
      var n = hint2 ? 3 : 2;
      var tY = mid - (n - 1) * sSize * 0.9 - sSize * 0.35;
      var sY = mid + sSize * 0.45;
      var hY = mid + sSize * 1.45, h2Y = mid + sSize * 2.40;
      ctx.font = '900 ' + tSize + 'px Orbitron, system-ui, sans-serif';
      ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 26;
      ctx.fillText(title, cssW / 2, tY); ctx.shadowBlur = 0;
      ctx.fillStyle = C.ink;
      ctx.font = '600 ' + sSize + 'px Rajdhani, system-ui, sans-serif';
      ctx.fillText(sub, cssW / 2, sY);
      ctx.fillStyle = hexA(color, 0.95);
      ctx.font = '600 ' + h1Size + 'px Rajdhani, system-ui, sans-serif';
      ctx.fillText(hint, cssW / 2, hY);
      if (hint2) {
        ctx.fillStyle = C.dim;
        ctx.font = '600 ' + h2Size + 'px Rajdhani, system-ui, sans-serif';
        ctx.fillText(hint2, cssW / 2, h2Y);
      }
    }
    function frame(now) {
      if (destroyed) return;   // guard: destroy() can land between frames
      // The stage's aspect-ratio box can settle over the first few frames after
      // start(); re-measure until the cached size stops moving so the backing
      // store (and therefore every hit-test) matches what is actually on screen.
      if (warmup < 30) { warmup++; var r0 = wrap.getBoundingClientRect();
        if (Math.round(r0.width) !== cssW || Math.round(r0.height) !== cssH) resize(); }
      var dt = Math.min(200, now - last); // clamp so a backgrounded tab can't fast-forward days
      last = now;
      if (!paused && !over && booted && !intro) {
        acc += dt;
        var dm = dayMs(day), guard = 0;
        while (acc >= dm && !over && !destroyed && guard++ < 3) { acc -= dm; doDay(); }
        if (acc > dm) acc = 0;   // bankrupt() stopped the run: drop the backlog
      }
      syncStatus();
      draw(now);
      if (!destroyed) rafId = requestAnimationFrame(frame); // destroy() may land inside draw()/gameOver()
    }
    /* ------------------- Input: keyboard + pointer ------------------- */
    function local(e) { var r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
    function selectCell(x, y) {
      var cx = Math.floor((x - gx) / cell), cy = Math.floor((y - gy) / cell);
      if (cx < 0 || cy < 0 || cx >= COLS || cy >= ROWS) return false;
      sel = cy * COLS + cx; palOpen = true; return true;
    }
    function begin() { if (intro) { intro = false; writeLS(HINT_KEY, '1'); } last = performance.now(); }
    function onPointerDown(e) {
      if (destroyed) return;
      if (e.button !== undefined && e.button !== 0) return;
      if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
      var p = local(e);
      if (over) { resetRun(); return; }               // one-tap restart
      if (intro) { begin(); return; }                 // the goal card: any tap starts the run
      if (paused) { paused = false; last = performance.now(); return; }
      if (hit(pauseBtn(), p.x, p.y)) { paused = true; return; }
      if (palOpen) {
        var btns = palLayout();
        for (var i = 0; i < btns.length; i++) if (hit(btns[i], p.x, p.y)) { act(btns[i].i); return; }
      }
      if (!selectCell(p.x, p.y)) palOpen = false;       // tap off-grid closes the palette
    }
    function onKeyDown(e) {
      if (destroyed || e.metaKey || e.ctrlKey || e.altKey) return;
      var a = document.activeElement;
      if (a && a !== canvas && /^(BUTTON|INPUT|SELECT|TEXTAREA|A|SUMMARY)$/.test(a.tagName)) return;
      var mv = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -COLS, ArrowDown: COLS,
        KeyA: -1, KeyD: 1, KeyW: -COLS, KeyS: COLS }[e.code];
      if (mv !== undefined) {
        e.preventDefault();
        if (over) { resetRun(); return; }
        if (intro) { begin(); return; }
        paused = false;
        var x = (sel % COLS) + (mv === -1 ? -1 : mv === 1 ? 1 : 0);
        var y = Math.floor(sel / COLS) + (mv === -COLS ? -1 : mv === COLS ? 1 : 0);
        if (x >= 0 && y >= 0 && x < COLS && y < ROWS) { sel = y * COLS + x; palOpen = true; }
        return;
      }
      if (e.code === 'Space' || e.code === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (over) resetRun();
        else if (intro) begin();
        else if (paused) { paused = false; last = performance.now(); }
        else palOpen = !palOpen;
        return;
      }
      if (e.code === 'Escape') { palOpen = false; return; }
      if (e.code === 'KeyP') { if (booted && !over) paused = !paused; return; }
      var n = (e.key && e.key.length === 1) ? '123456'.indexOf(e.key) : -1;
      if (n >= 0) { e.preventDefault(); act(n); }
    }
    function onResize() { if (!destroyed) resize(); }
    function onBlur() { if (!destroyed && booted && !over && !intro) paused = true; }
    function onVisibility() { if (document.hidden) onBlur(); }
    // The stage is sized by aspect-ratio and settles *after* start(), so a single
    // window-resize listener left the canvas permanently stale: backing store 843px
    // inside a 856px box, which both blurs the render and puts click hit-testing up to
    // 13 px out from what is drawn. Observe the wrapper so geometry is always current.
    var ro = null;
    if (typeof window.ResizeObserver === 'function') {
      ro = new window.ResizeObserver(onResize);
      ro.observe(wrap);
    }
    // Every listener the game owns, in one table so teardown cannot miss one.
    var BIND = [[document, 'keydown', onKeyDown], [canvas, 'pointerdown', onPointerDown],
      [window, 'resize', onResize, { passive: true }], [window, 'orientationchange', onResize],
      [window, 'blur', onBlur], [document, 'visibilitychange', onVisibility]];
    BIND.forEach(function (b) { b[0].addEventListener(b[1], b[2], b[3]); });
    resetRun(); rafId = requestAnimationFrame(frame);
    return {
      destroy: function () {
        if (destroyed) return;
        destroyed = true; cancelAnimationFrame(rafId);
        if (ro) { ro.disconnect(); ro = null; }
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
    name: 'Base Builder',
    instructions:
      'Survive to DAY 30. You start with 90 credits and one habitat on a 6x6 grid. Every building ' +
      'you place earns income from the day it lands and costs upkeep every day after; rent starts ' +
      'on day 9 and climbs steeply, so you must grow faster than it does. Each day a building ' +
      'takes one more worker, which raises its income to full. Green NET means you are winning, ' +
      'red means the rent is eating you alive — if credits hit zero you are bankrupt. Tap a cell, ' +
      'then tap a card to build (HABITAT, FARM, FABRICATOR, RUSH CORE); 5 upgrades, 6 salvages. ' +
      'Arrow keys move the cursor, 1-6 use the palette. A supply drop lands every 3rd day. ' +
      'Score is days survived plus peak income, plus 30 for holding the base.',
    start: start
  };
})();
