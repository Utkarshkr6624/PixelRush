/**
 * PIXEL RUSH — games/juice-jam.js — "Juice Jam"
 * Contract (GAME-CONTRACT.md): window.PixelGame = { name, instructions, start(root, api) }
 * where api = { setScore(n), setBest(n), gameOver(score) } and start() returns { destroy() }.
 * Self-contained: no imports, no dependencies, no assets — one <canvas> + 2D ctx, and every
 * rAF id and listener created in start() is torn down in destroy().
 */
(function () {
  'use strict';
  /* -------------------------------- Tuning -------------------------------- */
  var STORE_KEY = 'pixelrush.juice-jam.best'; // localStorage: all-time best score
  var COLS = 8, ROWS = 8, TYPES = 6;         // 6 silhouettes, so shape not just hue tells fruits apart
  var SP_NONE = 0, SP_H = 1, SP_V = 2, SP_BOMB = 3; // specials armed by 4- and 5-matches
  var FALL_SEC = 0.085, POP_MS = 210, SWAP_MS = 100; // gravity, clear flash, one swap leg
  var BASE_PTS = 30;         // score per cleared fruit, before the chain multiplier
  var METER_PER_FRUIT = 3.4; // fill meter drained per fruit cleared
  var METER_MAX = 100;       // fill meter needed to raise one crust row
  // The fill rate grows with level so pressure keeps pace with a player who is clearing
  // faster and faster. At 0.35/level the curve was flat for the whole first few thousand
  // points — 90s of solid play never produced a single crust row, so the losing condition
  // was something only a brand-new player ever met. 1.6 puts real teeth in it by level 3.
  var RATE_BASE = 6.0, RATE_FALLOFF = 1.6, RATE_FLOOR = 6; // fill %/s at level 0, + this per level
  var LEVEL_STEP = 1500;     // points per difficulty level
  var FLICK = 0.42;          // drag distance (fraction of a cell) that counts as a swipe
  var STYLES = '.jj{position:relative;width:100%;height:100%;overflow:hidden;touch-action:none;' +
    'user-select:none;-webkit-tap-highlight-color:transparent;outline:none;' +
    'font-family:var(--font-body,"Rajdhani",system-ui,sans-serif);color:var(--ink,#f2f5ff)}' +
    '.jj canvas{display:block;width:100%;height:100%;outline:none;touch-action:none}';
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
    /* -------------------------------- DOM -------------------------------- */
    var wrap = document.createElement('div'); wrap.className = 'jj';
    var canvas = document.createElement('canvas');
    canvas.setAttribute('tabindex', '0'); canvas.setAttribute('role', 'application');
    canvas.setAttribute('aria-label', 'Juice Jam match three board. Drag a fruit to swap; arrow keys move the cursor, space picks up.');
    var live = document.createElement('div'); // screen-reader announcements
    live.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0)';
    live.setAttribute('aria-live', 'polite');
    wrap.appendChild(canvas); wrap.appendChild(live);
    var styleTag = document.createElement('style');
    styleTag.textContent = STYLES; wrap.appendChild(styleTag); root.appendChild(wrap); // one <style>, scoped to .jj
    var ctx = canvas.getContext('2d');
    if (!ctx) { root.removeChild(wrap); return { destroy: function () {} }; }
    var rafId = 0, destroyed = false;
    var setStatusApi = typeof api.setStatus === 'function' ? api.setStatus : function () {};
    var reduced = !!(window.PX && window.PX.reduced) ||
      !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    /* ------------------------------- State ------------------------------ */
    var bd = new Array(COLS * ROWS);  // {t, sp, dy} per cell, or null when empty
    var pops = [];                    // cleared fruits, drawn as a fading flash
    var score = 0, bestEver = readBest(), level = 0, isRecord = false;
    var foul = 0, meter = 0;          // crust rows, and progress toward the next one
    var chain = 0, mode = 'play', waitT = 0, anim = null; // mode: play | swap | resolve
    var hold = null, cur = { x: 3, y: 3 }, sel = null;   // keyboard pick-up, cursor, pointer selection
    var booted = false, paused = false, over = false;    // `over` = api.gameOver() fired this run
    var readySaid = false, fresh = false;   // `fresh` = still sitting on the pre-start card
    var shake = 0, flashAt = -1e9, warnAt = -1e9, comboAt = -1e9, comboN = 0;
    /* ----------------- Sizing (crisp devicePixelRatio) ----------------- */
    var dpr = 1, cssW = 1, cssH = 1, cell = 20, bx = 0, by = 0, hudH = 40, barH = 56, HM = null;
    /** HUD band metrics. Sizing and drawing share these, so the two text lines
     *  and the meter are always stacked by the font sizes actually in use and
     *  can never land on top of each other however short the stage is. */
    /* Text is sized from the SMALLER of the two dimensions. On a portrait phone the
     * stage is now taller than it is wide, so height alone makes every string balloon
     * and run off both edges. */
    function dim() { return Math.min(cssW, cssH); }
    /** Largest size in [lo, px] at which `txt` still fits `maxW`, measured in the real
     *  weighted font. Keeps a long string honest instead of letting it clip. */
    function fitFont(txt, fontCss, px, maxW, lo) {
      var s = Math.round(px);
      ctx.font = s + 'px ' + fontCss;
      while (s > lo && ctx.measureText(txt).width > maxW) {
        s--; ctx.font = s + 'px ' + fontCss;
      }
      return s;
    }
    /** Greedy word wrap, hard-splitting any single word too long for the line. Words
     *  past `maxLines` are folded into the last line rather than dropped. */
    function wrapText(txt, maxW, maxLines) {
      var words = String(txt).split(' '), lines = [], cur = '', i, w, cut;
      for (i = 0; i < words.length; i++) {
        w = words[i];
        while (ctx.measureText(w).width > maxW && w.length > 1) { // unbreakable token
          cut = w.length;
          while (cut > 1 && ctx.measureText(w.slice(0, cut)).width > maxW) cut--;
          lines.push(w.slice(0, cut)); w = w.slice(cut);
        }
        if (!cur) cur = w;
        else if (ctx.measureText(cur + ' ' + w).width <= maxW) cur += ' ' + w;
        else { lines.push(cur); cur = w; }
      }
      if (cur) lines.push(cur);
      while (lines.length > maxLines) {          // never silently drop words
        lines[maxLines - 1] += ' ' + lines[maxLines];
        lines.length = maxLines;
      }
      return lines;
    }
    function hudMetrics() {
      var d = dim();
      var fs = Math.round(clamp(d * 0.052, 11, 18));    // score / level / best
      var lf = Math.round(clamp(d * 0.037, 9, 13));     // juice label
      var mh = Math.round(clamp(d * 0.037, 5, 9));      // fill meter
      var scoreMid = Math.max(4, Math.round(fs * 0.3)) + fs / 2;
      var labelMid = scoreMid + fs / 2 + 3 + lf / 2;     // 3px clear of the score line
      var meterTop = labelMid + lf / 2 + 4;
      var need = Math.ceil(meterTop + mh + 3);
      var withLabel = need <= Math.max(30, Math.round(cssH * 0.24));
      if (!withLabel) { meterTop = scoreMid + fs / 2 + 5; need = Math.ceil(meterTop + mh + 3); }
      return { fs: fs, lf: lf, mh: mh, scoreMid: scoreMid, labelMid: labelMid,
               meterTop: meterTop, need: need, withLabel: withLabel };
    }
    function measure() {
      // clientWidth/Height are the *layout* box. getBoundingClientRect() would fold in
      // the shell's entry animation transform (the stage scales up from 0.98), which
      // is why the very first measurement came out ~1.6% small and never self-corrected.
      var w = wrap.clientWidth, h = wrap.clientHeight;
      if (!w || !h) { var r = wrap.getBoundingClientRect(); w = r.width; h = r.height; }
      return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
    }
    function resize() {
      var m = measure();
      cssW = m.w; cssH = m.h;
      dpr = clamp(window.devicePixelRatio || 1, 1, 2); // cap DPR: fill-rate win on 3x phones
      canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
      canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Square board letterboxed between the HUD band and the thumb bar — never stretched.
      HM = hudMetrics();
      hudH = Math.max(30, Math.min(HM.need, Math.round(cssH * 0.24)));
      barH = Math.round(clamp(cssH * 0.13, 44, 68));
      var avail = cssH - hudH - barH - 6;
      cell = Math.max(6, Math.floor(Math.min(cssW - 10, avail) / COLS));
      bx = Math.round((cssW - cell * COLS) / 2);
      by = Math.max(hudH, Math.round(hudH + (avail - cell * ROWS) / 2));
    }
    resize();
    /* Watch the wrapper as well as the window: fires when the stage box really
     * changes (sidebar collapse, rotation), and never on the entry animation. */
    var ro = (typeof window.ResizeObserver === 'function') ? new window.ResizeObserver(function () {
      if (destroyed) return;
      var m = measure();
      if (m.w === cssW && m.h === cssH) return;
      resize();
    }) : null;
    if (ro) ro.observe(wrap);
    function token(n, fb) { // pull a site custom property, with a hard fallback
      var v = getComputedStyle(document.documentElement).getPropertyValue(n);
      return (v && v.trim()) || fb;
    }
    var C = { bg: token('--bg', '#05060f'), ink: token('--ink', '#f2f5ff'), dim: token('--ink-dim', '#a7b0d0'),
      cyan: token('--cyan', '#22e7ff'), magenta: token('--magenta', '#ff2fb9'), acid: token('--acid', '#c8ff2e'),
      orange: token('--orange', '#ff8a3d'), violet: token('--violet', '#8b5cf6') };
    var FCOL = [C.magenta, C.acid, C.cyan, C.orange, C.violet, C.ink];
    function hexA(hex, a) { // #rrggbb + alpha -> rgba()
      hex = (hex || '#fff').trim().replace('#', '');
      var n = parseInt(hex, 16);
      return isFinite(n) ? 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')' : 'rgba(255,255,255,' + a + ')';
    }
    function rr(x, y, w, h, r) { // rounded-rect path, with a pre-roundRect fallback
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
    }
    /* ---------------------------- Board helpers -------------------------- */
    function limitY() { return ROWS - 1 - foul; }  // lowest playable row index
    function at(x, y) { return (x < 0 || y < 0 || x >= COLS || y > limitY()) ? null : bd[y * COLS + x]; }
    function playable(x, y) { return x >= 0 && y >= 0 && x < COLS && y <= limitY() && !!at(x, y); }
    function rndType(x, y) { // spawn colour that cannot instantly triple against its neighbours
      for (var tries = 0; tries < 12; tries++) {
        var t = Math.floor(Math.random() * TYPES), a = at(x, y - 1), b = at(x, y + 1);
        if ((!a || a.t !== t) && (!b || b.t !== t)) return t;
      }
      return Math.floor(Math.random() * TYPES);
    }
    /* ------------------------------ Match scan --------------------------- */
    /** Every horizontal/vertical run of 3+ same-coloured fruit in the playable area. */
    function findGroups() {
      var groups = [], x, y, run, len, s, n;
      for (y = 0; y <= limitY(); y++) for (x = 0; x < COLS;) {
        run = at(x, y);
        if (!run) { x++; continue; }
        s = x;
        while (x + 1 < COLS && (n = at(x + 1, y)) && n.t === run.t) x++;
        if ((len = x - s + 1) >= 3) groups.push({ dir: 'h', len: len, sx: s, sy: y, dx: 1, dy: 0 });
        x++;
      }
      for (x = 0; x < COLS; x++) for (y = 0; y <= limitY();) {
        run = at(x, y);
        if (!run) { y++; continue; }
        s = y;
        while (y + 1 <= limitY() && (n = at(x, y + 1)) && n.t === run.t) y++;
        if ((len = y - s + 1) >= 3) groups.push({ dir: 'v', len: len, sx: x, sy: s, dx: 0, dy: 1 });
        y++;
      }
      return groups;
    }
    function cellOf(g, i) { return { x: g.sx + g.dx * i, y: g.sy + g.dy * i }; }
    /** Is any single adjacent swap legal? Drives the "no moves" reshuffle. */
    function hasMove() {
      var dirs = [[1, 0], [0, 1]], x, y, d, a, b, nx, ny, tt, ok;
      for (y = 0; y <= limitY(); y++) for (x = 0; x < COLS; x++) {
        if (!at(x, y)) continue;
        for (d = 0; d < 2; d++) {
          nx = x + dirs[d][0]; ny = y + dirs[d][1];
          if (!playable(nx, ny)) continue;
          a = at(x, y); b = at(nx, ny); tt = a.t;
          a.t = b.t; b.t = tt;                       // try the swap …
          ok = findGroups().length > 0;
          tt = a.t; a.t = b.t; b.t = tt;             // … and put it back
          if (ok) return true;
        }
      }
      return false;
    }
    /** Recolour the tail of every run until none is left. Always terminates — unlike
     *  blind re-rolling, which can never clear a board built from few live colours. */
    function scrubBoard() {
      var used = {}, gs, g, last, c, dx, dy, i, j, t, pass;
      for (pass = 0; pass < 12; pass++) {
        gs = findGroups();
        if (!gs.length) return true;
        for (i = 0; i < gs.length; i++) {
          g = gs[i]; last = cellOf(g, g.len - 1); c = at(last.x, last.y); used = {};
          for (j = 0; j < g.len - 1; j++) used[at(g.sx + g.dx * j, g.sy + g.dy * j).t] = 1;
          dx = g.dx; dy = g.dy;
          if (at(last.x - dx, last.y - dy)) used[at(last.x - dx, last.y - dy).t] = 1;
          if (at(last.x + dx, last.y + dy)) used[at(last.x + dx, last.y + dy).t] = 1;
          for (t = 0; t < TYPES; t++) if (!used[t]) { c.t = t; break; }
        }
      }
      return findGroups().length === 0;
    }
    /** Dead board: recolour everything, then make sure at least one swap is legal. */
    function reshuffle() {
      for (var tries = 0; tries < 12; tries++) {
        for (var y = 0; y <= limitY(); y++) for (var x = 0; x < COLS; x++) {
          var c = at(x, y); if (c) c.t = Math.floor(Math.random() * TYPES);
        }
        if (scrubBoard() && hasMove()) return true;
      }
      return hasMove();
    }
    /** Last line of defence against an unplayable board. Every fruit is random, so a
     *  4x8 or 3x8 pocket is easy to land on with no legal swap; without this the player
     *  is left staring at a board they cannot touch while the juice finishes them off.
     *  Cheap, because hasMove() short-circuits on the first legal swap it finds. */
    function ensureMove() {
      if (hasMove()) return false;
      reshuffle();
      warnAt = performance.now();
      live.textContent = 'No moves left. The board has been reshuffled.';
      return true;
    }
    /* ----------------------------- Scoring ------------------------------- */
    function addScore(n) {
      score += n;
      var lv = Math.floor(score / LEVEL_STEP);
      if (lv > level) { level = lv; flashAt = performance.now(); }
      setScore(score);
      if (bestEver === null || score > bestEver) {
        bestEver = score; isRecord = true; writeBest(score); setBest(score);
      }
    }
    function die() {
      if (over || destroyed) return;   // api.gameOver() may only fire once per run
      over = true; paused = false; anim = null;
      live.textContent = 'The juice ran out. Final score ' + score + '.';
      setStatusApi('Game over');
      gameOverCb(score);
    }
    /* ------------------------------ Run setup ---------------------------- */
    function resetRun() {
      var x, y, guard = 0;
      for (y = 0; y < ROWS; y++) for (x = 0; x < COLS; x++) {
        bd[y * COLS + x] = { t: Math.floor(Math.random() * TYPES), sp: SP_NONE, dy: 0 };
      }
      while (findGroups().length && guard++ < 50) { // a fresh board must start match-free
        for (y = 0; y < ROWS; y++) for (x = 0; x < COLS; x++) bd[y * COLS + x].t = Math.floor(Math.random() * TYPES);
      }
      if (!hasMove()) reshuffle();   // match-free is not the same as playable
      pops.length = 0;
      score = 0; level = 0; foul = 0; meter = 0; chain = 0; comboN = 0; shake = 0;
      mode = 'play'; waitT = 0; anim = null; hold = null; sel = null; cur = { x: 3, y: 3 };
      isRecord = false; over = false; paused = !booted; booted = true;
      fresh = paused;
      setScore(0);
      setStatusApi(paused ? 'Ready' : 'Playing');
      if (bestEver !== null) setBest(bestEver);
      live.textContent = 'New run. Score 0.';
    }
    /* ------------------------- Swapping & resolving ---------------------- */
    /** Exchange two neighbours outright. Both the colour AND the armed power move —
     *  swapping only the colour used to leave a striped fruit standing on the cell the
     *  player just dragged away from, so the strongest fruit in the game could never
     *  be repositioned. */
    function exchange(a, b) {
      var ca = at(a.x, a.y), cb = at(b.x, b.y), tt;
      if (!ca || !cb) return;
      tt = ca.t; ca.t = cb.t; cb.t = tt;
      tt = ca.sp; ca.sp = cb.sp; cb.sp = tt;
    }
    function beginSwap(a, b) {
      if (destroyed || over || mode !== 'play' || !playable(a.x, a.y) || !playable(b.x, b.y)) return false;
      if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) !== 1) return false;
      exchange(a, b);
      anim = { ax: a.x, ay: a.y, bx: b.x, by: b.y, leg: 0, pivot: b };
      mode = 'swap'; waitT = SWAP_MS;
      return true;
    }
    /** Clear the matched groups, arm specials, pull the board down, score it. */
    function resolve() {
      var groups = findGroups();
      if (!groups.length) return false;
      chain++;
      var clear = {}, arms = [], work, i, j, k, c, wx, wy, wc, xx, yy, n = 0, maxDrop = 0, pts;
      function add(x, y) { // claim a cell for clearing; true only the first time
        if (!playable(x, y)) return false;
        var kk = y * COLS + x;
        if (clear[kk]) return false;
        clear[kk] = 1; return true;
      }
      for (i = 0; i < groups.length; i++) for (j = 0; j < groups[i].len; j++) {
        c = cellOf(groups[i], j); add(c.x, c.y);
      }
      // 4-in-a-row arms a striped fruit, 5+ a colour bomb. The new special lands on the
      // cell the player moved where possible, otherwise on a cell two long runs share
      // (an L or T of two 4s), which upgrades to a bomb.
      for (i = 0; i < groups.length; i++) {
        var g = groups[i];
        if (g.len < 4) continue;
        var pivot = null, best = 0;
        for (j = 0; j < g.len; j++) {
          c = cellOf(g, j);
          var nc = 0, gi, gj, gc;   // `nc`, not `n`: n is the cleared-fruit tally below
          for (gi = 0; gi < groups.length; gi++) {          // how many long runs cover this cell?
            if (groups[gi].len < 4) continue;
            for (gj = 0; gj < groups[gi].len; gj++) {
              gc = cellOf(groups[gi], gj);
              if (gc.x === c.x && gc.y === c.y) { nc++; break; }
            }
          }
          var rank = nc * 2 + (anim && anim.pivot.x === c.x && anim.pivot.y === c.y ? 1 : 0);
          if (rank > best) { best = rank; pivot = c; }
        }
        if (!pivot) continue;
        arms.push({ x: pivot.x, y: pivot.y, sp: best >= 4 ? SP_BOMB : (g.len >= 5 ? SP_BOMB : (g.dir === 'h' ? SP_H : SP_V)) });
        clear[pivot.y * COLS + pivot.x] = 2;
      }
      // Specials caught in a clear fire: stripes sweep their line, bombs sweep their colour.
      // A worklist, so a striped fruit uncovered by a bomb keeps sweeping.
      work = Object.keys(clear);
      for (i = 0; i < work.length; i++) {
        k = +work[i]; wx = k % COLS; wy = Math.floor(k / COLS); wc = at(wx, wy);
        if (!wc || wc.sp === SP_NONE) continue;
        if (wc.sp === SP_H) { for (xx = 0; xx < COLS; xx++) if (add(xx, wy)) work.push(wy * COLS + xx); }
        else if (wc.sp === SP_V) { for (yy = 0; yy <= limitY(); yy++) if (add(wx, yy)) work.push(yy * COLS + wx); }
        else for (yy = 0; yy <= limitY(); yy++) for (xx = 0; xx < COLS; xx++) {
          if (at(xx, yy) && at(xx, yy).t === wc.t && add(xx, yy)) work.push(yy * COLS + xx);
        }
      }
      for (i = 0; i < arms.length; i++) delete clear[arms[i].y * COLS + arms[i].x]; // armed fruit survives its own match
      work = Object.keys(clear);
      for (i = 0; i < work.length; i++) {           // flash, then empty the cleared cells
        k = +work[i]; wx = k % COLS; wy = Math.floor(k / COLS);
        c = at(wx, wy);
        if (!c) continue;
        n++; pops.push({ x: wx, y: wy, t: c.t, t0: performance.now() }); bd[k] = null;
      }
      for (i = 0; i < arms.length; i++) { c = at(arms[i].x, arms[i].y); if (c) { c.sp = arms[i].sp; c.dy = 0; } }
      for (var gx = 0; gx < COLS; gx++) {            // gravity per column, then refill from above
        var write = limitY(), f, nf, ny;
        for (var gy = limitY(); gy >= 0; gy--) {
          f = at(gx, gy);
          if (!f) continue;
          if (write !== gy) {
            bd[write * COLS + gx] = f; bd[gy * COLS + gx] = null; f.dy = gy - write;
            if (f.dy > maxDrop) maxDrop = f.dy;
          }
          write--;
        }
        for (ny = write; ny >= 0; ny--) {
          nf = { t: rndType(gx, ny), sp: SP_NONE, dy: ny - write - 1 };
          bd[ny * COLS + gx] = nf;
          if (-nf.dy > maxDrop) maxDrop = -nf.dy;
        }
      }
      pts = BASE_PTS * n * chain;
      addScore(pts);
      meter = Math.max(0, meter - METER_PER_FRUIT * n);
      if (chain >= 2) { comboN = chain; comboAt = performance.now(); }
      shake = reduced ? 0 : Math.min(10, 3 + n * 0.4);
      live.textContent = 'Chain ' + chain + ', ' + n + ' fruit, ' + pts + ' points. Score ' + score + '.';
      anim = null; mode = 'resolve';
      waitT = Math.max(POP_MS, maxDrop * FALL_SEC * 1000 + 80);
      return true;
    }
    /* ------------------------------ Drawing ------------------------------ */
    function shapePath(t, cx, cy, r) { // one silhouette per colour: circle, square, gem, wedge, hex, star
      var i, a, rad;
      ctx.beginPath();
      if (t === 0) { ctx.arc(cx, cy, r, 0, 6.2832); return; }
      if (t === 1) { rr(cx - r, cy - r, r * 2, r * 2, r * 0.42); return; }
      if (t === 2) { ctx.moveTo(cx, cy - r * 1.12); ctx.lineTo(cx + r * 1.12, cy); ctx.lineTo(cx, cy + r * 1.12); ctx.lineTo(cx - r * 1.12, cy); ctx.closePath(); return; }
      if (t === 3 || t === 4) {
        var sides = t === 3 ? 3 : 6;
        for (i = 0; i < sides; i++) { a = -1.5708 + i * 6.2832 / sides; ctx[i ? 'lineTo' : 'moveTo'](cx + Math.cos(a) * r * 1.12, cy + Math.sin(a) * r * 1.12); }
        ctx.closePath(); return;
      }
      for (i = 0; i < 10; i++) {
        a = -1.5708 + i * 0.6283; rad = i % 2 ? r * 0.5 : r * 1.16;
        ctx[i ? 'lineTo' : 'moveTo'](cx + Math.cos(a) * rad, cy + Math.sin(a) * rad);
      }
      ctx.closePath();
    }
    function fruit(c, cx, cy, r, alpha) {
      var col = FCOL[c.t], i;
      ctx.save();
      ctx.globalAlpha = alpha == null ? 1 : alpha;
      ctx.shadowColor = col; ctx.shadowBlur = 15 * (reduced ? 0.4 : 1);
      ctx.fillStyle = col; shapePath(c.t, cx, cy, r); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(255,255,255,.32)'; ctx.beginPath();          // wet highlight
      ctx.ellipse(cx - r * 0.3, cy - r * 0.4, r * 0.3, r * 0.18, -0.6, 0, 6.2832); ctx.fill();
      if (!c.sp) { ctx.restore(); return; }
      ctx.shadowColor = '#ffffff'; ctx.shadowBlur = 12; ctx.strokeStyle = '#ffffff';
      ctx.lineCap = 'round'; ctx.lineWidth = Math.max(1.5, r * 0.15);
      if (c.sp === SP_BOMB) {                                             // radiant core
        ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(cx, cy, r * 0.28, 0, 6.2832); ctx.fill();
        for (i = 0; i < 6; i++) {
          var an = i * 1.0472;
          ctx.beginPath(); ctx.moveTo(cx + Math.cos(an) * r * 0.5, cy + Math.sin(an) * r * 0.5);
          ctx.lineTo(cx + Math.cos(an) * r * 0.85, cy + Math.sin(an) * r * 0.85); ctx.stroke();
        }
      } else {                                                            // stripes: sweep this way
        var horiz = c.sp === SP_H, d = r * 0.3, e2 = r * 0.66;
        for (i = -1; i <= 1; i += 2) {
          ctx.beginPath();
          if (horiz) { ctx.moveTo(cx - e2, cy + i * d); ctx.lineTo(cx + e2, cy + i * d); }
          else { ctx.moveTo(cx + i * d, cy - e2); ctx.lineTo(cx + i * d, cy + e2); }
          ctx.stroke();
        }
      }
      ctx.restore();
    }
    function drawCrust(now) { // the rising threat, with a slow travelling sheen
      var x, y, p = cell * 0.04, ph;
      for (y = limitY() + 1; y < ROWS; y++) for (x = 0; x < COLS; x++) {
        var cx = bx + x * cell, cy = by + y * cell;
        rr(cx + p, cy + p, cell - p * 2, cell - p * 2, cell * 0.2);
        ctx.fillStyle = 'rgba(255,47,185,.10)'; ctx.fill();
        ctx.strokeStyle = hexA(C.magenta, 0.45); ctx.lineWidth = 1.5; ctx.stroke();
        if (!reduced) {
          ph = (now / 700 - (x * 0.17 + y * 0.11)) % 1;
          ctx.fillStyle = hexA(C.magenta, 0.10 * Math.max(0, 1 - Math.abs(ph - 0.5) * 2));
          ctx.fillRect(cx, cy, cell, cell);
        }
      }
      ctx.save();
      ctx.strokeStyle = hexA(C.magenta, 0.9); ctx.shadowColor = C.magenta; ctx.shadowBlur = 18; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(bx, by + (limitY() + 1) * cell); ctx.lineTo(bx + cell * COLS, by + (limitY() + 1) * cell); ctx.stroke();
      ctx.restore();
    }
    function button(r, label, color) { // thumb-zone buttons, drawn on the canvas and hit-tested
      rr(r.x, r.y, r.w, r.h, Math.min(14, r.h * 0.3));
      ctx.fillStyle = hexA(color, 0.10); ctx.fill();
      ctx.strokeStyle = hexA(color, 0.75); ctx.lineWidth = 1.5; ctx.stroke();
      ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0,0,0,.9)'; ctx.shadowBlur = 5;
      ctx.font = '700 ' + Math.round(clamp(r.h * 0.34, 11, 17)) + 'px Rajdhani, system-ui, sans-serif';
      ctx.fillText(label, r.x + r.w / 2, r.y + r.h / 2);
      ctx.shadowBlur = 0;
    }
    /** Centred overlay: big neon title, sub-copy, optional hint. Title, body and hint
     *  all size off min(cssW, cssH) and are then shrunk to their own measured width,
     *  with the longer lines wrapped — a 390px portrait stage is much taller than wide
     *  and height-only sizing used to push all of this off both edges. */
    function card(title, sub, color, hint) {
      var ORB = '900 Orbitron, system-ui, sans-serif', RAJ = '600 Rajdhani, system-ui, sans-serif';
      var maxW = cssW - Math.max(20, cssW * 0.08);
      var ts, bs, subLines, hintLines, i;
      ctx.fillStyle = hexA(C.bg, 0.76); ctx.fillRect(0, 0, cssW, cssH);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ts = fitFont(title, ORB, Math.min(cssH * 0.13, cssW * 0.2), maxW, 13);
      ctx.font = ts + 'px ' + ORB;
      bs = clamp(Math.min(cssH * 0.048, cssW * 0.055), 10, 21);
      ctx.font = Math.round(bs) + 'px ' + RAJ;
      subLines = wrapText(sub, maxW, 2);
      for (i = 0; i < subLines.length; i++) bs = Math.min(bs, fitFont(subLines[i], RAJ, bs, maxW, 9));
      ctx.font = Math.round(bs) + 'px ' + RAJ;
      hintLines = hint ? wrapText(hint, maxW, 3) : [];
      var hs = Math.max(9, Math.min(Math.round(bs), 18));
      ctx.font = hs + 'px ' + RAJ;
      for (i = 0; i < hintLines.length; i++) hs = Math.min(hs, fitFont(hintLines[i], RAJ, hs, maxW, 9));
      // Stack from the middle outward so the block stays centred whatever it wraps to.
      var blocks = [{ lines: [title], size: ts, lh: ts * 1.25 },
                    { lines: subLines, size: bs, lh: bs * 1.3 },
                    { lines: hintLines, size: hs, lh: hs * 1.3 }];
      var total = 0;
      for (i = 0; i < blocks.length; i++) total += blocks[i].lines.length * blocks[i].lh;
      var gapY = clamp(cssH * 0.035, 8, 22);
      total += gapY * (blocks.length - 1);
      var yy = Math.max(blocks[0].lh, (cssH - total) / 2);
      for (i = 0; i < blocks.length; i++) {
        var b = blocks[i];
        for (var j = 0; j < b.lines.length; j++) {
          ctx.font = Math.round(b.size) + 'px ' + (i === 0 ? ORB : RAJ);
          ctx.fillStyle = i === 0 ? color : C.dim;
          ctx.shadowColor = i === 0 ? color : 'rgba(0,0,0,.9)';
          ctx.shadowBlur = i === 0 ? 28 : 5;
          ctx.fillText(b.lines[j], cssW / 2, yy + b.lh / 2);
          yy += b.lh;
        }
        yy += gapY;
      }
      ctx.shadowBlur = 0;
    }
    function draw(now) {
      var w = cssW, h = cssH, bw2 = cell * COLS, bh2 = cell * ROWS;
      var pad = Math.max(8, cssW * 0.03), gap = 10, bw3 = (cssW - pad * 2 - gap) / 2;
      var byy = cssH - barH + 7, bh3 = barH - 14, x, y, c, cx2, cy2, gr, age, e, p, mh, mw, mxp, myp, ratio, fs, top;
      ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);
      ctx.save();
      if (shake > 0.2) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
      // Playfield plate + grid.
      rr(bx, by, bw2, bh2, Math.min(16, cell * 0.4)); ctx.fillStyle = 'rgba(255,255,255,.03)'; ctx.fill();
      ctx.strokeStyle = hexA(C.cyan, 0.07); ctx.lineWidth = 1; ctx.beginPath();
      for (var g = 1; g < COLS; g++) { ctx.moveTo(bx + g * cell, by); ctx.lineTo(bx + g * cell, by + bh2); }
      for (var k = 1; k < ROWS; k++) { ctx.moveTo(bx, by + k * cell); ctx.lineTo(bx + bw2, by + k * cell); }
      ctx.stroke();
      for (y = 0; y < ROWS; y++) for (x = 0; x < COLS; x++) {
        c = at(x, y);
        if (!c) continue;
        if (anim && ((x === anim.ax && y === anim.ay) || (x === anim.bx && y === anim.by))) continue;
        var beat = c.sp === SP_BOMB && !reduced ? 1 + 0.12 * Math.sin(now / 130) : 1;
        fruit(c, bx + (x + 0.5) * cell, by + (y + 0.5 + c.dy) * cell, cell * 0.4 * beat, 1);
      }
      if (anim) { // the two movers, drawn on top so a swap reads clearly
        p = clamp(1 - waitT / SWAP_MS, 0, 1); e = p * p * (3 - 2 * p);
        c = at(anim.ax, anim.ay);
        if (c) fruit(c, bx + (anim.ax + 0.5 + (anim.bx - anim.ax) * e) * cell, by + (anim.ay + 0.5 + (anim.by - anim.ay) * e) * cell, cell * 0.4, 1);
        c = at(anim.bx, anim.by);
        if (c) fruit(c, bx + (anim.bx + 0.5 + (anim.ax - anim.bx) * e) * cell, by + (anim.by + 0.5 + (anim.ay - anim.by) * e) * cell, cell * 0.4, 1);
      }
      drawCrust(now);   // under the flashes, so a swallowed row's pop still reads
      for (var pi = pops.length - 1; pi >= 0; pi--) { // clear flashes
        var pp = pops[pi]; age = (now - pp.t0) / POP_MS;
        if (age > 1) { pops.splice(pi, 1); continue; }
        cx2 = bx + (pp.x + 0.5) * cell; cy2 = by + (pp.y + 0.5) * cell;
        gr = ctx.createRadialGradient(cx2, cy2, 0, cx2, cy2, cell * (0.4 + age * 0.9));
        gr.addColorStop(0, hexA(FCOL[pp.t], 0.9 * (1 - age))); gr.addColorStop(1, hexA(FCOL[pp.t], 0));
        ctx.fillStyle = gr; ctx.fillRect(cx2 - cell, cy2 - cell, cell * 2, cell * 2);
        ctx.strokeStyle = hexA('#ffffff', 0.8 * (1 - age)); ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cx2, cy2, cell * (0.3 + age * 0.7), 0, 6.2832); ctx.stroke();
      }
      if (sel && playable(sel.x, sel.y)) {           // pointer selection ring
        ctx.strokeStyle = C.acid; ctx.shadowColor = C.acid; ctx.shadowBlur = 16; ctx.lineWidth = 3;
        ctx.strokeRect(bx + sel.x * cell + 2, by + sel.y * cell + 2, cell - 4, cell - 4); ctx.shadowBlur = 0;
      }
      ctx.strokeStyle = hexA(C.cyan, reduced ? 0.7 : 0.55 + 0.35 * Math.sin(now / 260)); // keyboard cursor
      ctx.shadowColor = C.cyan; ctx.shadowBlur = reduced ? 0 : 12; ctx.lineWidth = 2;
      ctx.strokeRect(bx + cur.x * cell + 1.5, by + cur.y * cell + 1.5, cell - 3, cell - 3); ctx.shadowBlur = 0;
      ctx.strokeStyle = hexA(C.cyan, 0.28); ctx.shadowColor = hexA(C.cyan, 0.6); ctx.shadowBlur = 16; // neon frame
      rr(bx, by, bw2, bh2, Math.min(16, cell * 0.4)); ctx.stroke(); ctx.restore();
      // CRT polish: scanlines + vignette, applied to the world only — the HUD below
      // is painted after this so it stays at full brightness and clears WCAG AA.
      if (!reduced) { ctx.fillStyle = 'rgba(0,0,0,.16)'; for (var sy = 0; sy < h; sy += 3) ctx.fillRect(0, sy, w, 1); }
      var vig = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75);
      vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(0,0,0,.55)');
      ctx.fillStyle = vig; ctx.fillRect(0, 0, w, h);
      /* HUD — score, level, best, and the fill meter that kills you. Above the CRT wash.
       * Every y here comes from HM, the same metrics resize() used to size the band,
       * so the two lines can never collide on a short stage. */
      HM = HM || hudMetrics();
      fs = HM.fs; top = HM.scoreMid;
      ctx.font = '700 ' + fs + 'px Rajdhani, system-ui, sans-serif';
      ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      ctx.shadowColor = 'rgba(0,0,0,.9)'; ctx.shadowBlur = 5;   // keeps the readout legible over any fruit colour
      // The three readouts share one line. They used to be anchored to the *board* edges,
      // which on a 390px phone is a 96px span — "SCORE 3960" landed on top of "LV 0" and
      // a 5-digit score ran into "BEST". Anchor to the board when it is wide enough to
      // carry the line, otherwise to a readable minimum span, and drop LV if it still
      // does not fit. SCORE always wins; BEST is the one that yields.
      var span = Math.max(bw2, Math.min(w - 16, 260));
      var scL = Math.max(8, Math.round((w - span) / 2)), scR = scL + span;
      var scTxt = 'SCORE ' + score, bTxt = 'BEST ' + (bestEver || 0), lTxt = 'LV ' + level;
      var scW = ctx.measureText(scTxt).width;
      var bW = ctx.measureText(bTxt).width, lW = ctx.measureText(lTxt).width;
      ctx.fillStyle = C.ink; ctx.fillText(scTxt, scL, top);
      if (scL + scW + 8 + bW <= scR) {
        ctx.textAlign = 'right'; ctx.fillStyle = C.dim; ctx.fillText(bTxt, scR, top);
        if (scL + scW + 10 + lW / 2 < w / 2 && w / 2 + lW / 2 + 10 < scR - bW) {
          ctx.textAlign = 'center'; ctx.fillStyle = now - flashAt < 300 ? C.acid : C.cyan; ctx.fillText(lTxt, w / 2, top);
        }
      }
      ctx.shadowBlur = 0;
      mw = Math.min(cssW - 20, bw2); mh = HM.mh;
      mxp = (w - mw) / 2; myp = HM.meterTop; ratio = clamp(meter / METER_MAX, 0, 1);
      rr(mxp, myp, mw, mh, mh / 2); ctx.fillStyle = 'rgba(255,255,255,.07)'; ctx.fill();
      if (ratio > 0) {
        rr(mxp, myp, Math.max(mh, mw * ratio), mh, mh / 2);
        ctx.fillStyle = ratio > 0.75 ? C.magenta : C.orange; ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 10;
        ctx.fill(); ctx.shadowBlur = 0;
      }
      if (HM.withLabel) {
        var lbl = foul > 0 ? 'JUICE RISING — LEVEL ' + foul : 'JUICE LEVEL — MATCH TO DRAIN';
        ctx.font = '600 ' + HM.lf + 'px Rajdhani, system-ui, sans-serif';
        // Narrow stage: fall back to a shorter form, then drop the line rather than clip it.
        if (ctx.measureText(lbl).width > w - 12) lbl = foul > 0 ? 'JUICE LEVEL ' + foul : 'MATCH TO DRAIN';
        if (ctx.measureText(lbl).width > w - 12) lbl = foul > 0 ? 'JUICE ' + foul : 'DRAIN';
        ctx.shadowColor = 'rgba(0,0,0,.9)'; ctx.shadowBlur = 5;
        ctx.fillStyle = now - warnAt < 700 ? C.magenta : C.dim;
        if (ctx.measureText(lbl).width <= w - 12) ctx.fillText(lbl, w / 2, HM.labelMid);
        ctx.shadowBlur = 0;
      }
      if (now - comboAt < 800 && comboN >= 2) {       // escalating chain call-out
        var ca2 = (now - comboAt) / 800;
        ctx.font = '900 ' + Math.round(clamp(Math.min(h * 0.1, w * 0.13) * (1 + (1 - ca2) * 0.3), 18, 54)) + 'px Orbitron, system-ui, sans-serif';
        ctx.fillStyle = hexA(comboN >= 4 ? C.acid : C.magenta, 1 - ca2);
        ctx.shadowColor = C.magenta; ctx.shadowBlur = 24; ctx.fillText('CHAIN x' + comboN, w / 2, cssH * 0.3); ctx.shadowBlur = 0;
      }
      button({ x: pad, y: byy, w: bw3, h: bh3 }, paused && !over ? 'RESUME' : 'PAUSE', C.cyan);
      button({ x: pad + bw3 + gap, y: byy, w: bw3, h: bh3 }, over ? 'PLAY AGAIN' : 'NEW GAME', C.magenta);
      if (fresh && !over) card('JUICE JAM', 'Match 3 or more to drain the juice.', C.cyan, 'It rises anyway. Keep up or the crust eats the board. TAP to start');
      else if (paused && !over) card('PAUSED', 'Tap a button or press SPACE to resume', C.cyan, null);
      if (over) card('GAME OVER', 'SCORE ' + score + (isRecord ? '  ·  NEW BEST' : ''), C.magenta, 'TAP or press SPACE to play again');
    }
    /* -------------------------- Single rAF loop -------------------------- */
    function frame(now) {
      if (destroyed) return;   // guard: destroy() can land between frames
      var dt = Math.min(200, now - (frame.last || now)); frame.last = now;
      // The shell stamps "Playing" once, right after start(), which overwrites the
      // "Ready" the first resetRun() pushed. Re-assert it from the loop while the
      // pre-start card is up, so the STATUS row always matches what is on screen.
      if (fresh && paused && !over) { if (!readySaid) { readySaid = true; setStatusApi('Ready'); } } else readySaid = false;
      if (shake > 0) shake = Math.max(0, shake - dt / 260);
      if (!paused && !over) {
        var yy, xx, fc, step = dt / (FALL_SEC * 1000);
        if (mode !== 'play') for (yy = 0; yy <= limitY(); yy++) for (xx = 0; xx < COLS; xx++) {
          // falling fruit slide home continuously, so the board reads as a cascade
          fc = at(xx, yy);
          if (fc && fc.dy) { fc.dy -= step; if (fc.dy < 0) fc.dy = 0; }
        }
        // The juice creeps up in real time, even mid-animation, so spamming rejected
        // swaps cannot stall it. Rows only rise while the board is idle, never mid-fall.
        meter += Math.max(RATE_FLOOR, RATE_BASE + RATE_FALLOFF * level) * dt / 1000;
        if (meter > METER_MAX * 1.5) meter = METER_MAX * 1.5;   // cap the backlog, no instant burst
        if (mode === 'play') {
          while (meter >= METER_MAX) {
            meter -= METER_MAX;
            // Flash the row about to be swallowed *before* it leaves the playable
            // area — once foul ticks up, at() no longer returns those cells.
            var cy = ROWS - foul - 1, cx, doomed;
            for (cx = 0; cx < COLS; cx++) { doomed = at(cx, cy); if (doomed) pops.push({ x: cx, y: cy, t: doomed.t, t0: now }); }
            foul++;
            warnAt = now; shake = reduced ? 0 : 9;
            ensureMove();   // the crust just removed a row: the pocket it left may be dead
            live.textContent = 'Warning. Juice level ' + foul + '.';
            if (foul >= ROWS - 1) { die(); break; }
          }
        }
        if (waitT > 0) {
          waitT -= dt;
          if (waitT <= 0 && !over) {
            if (mode === 'swap') {
              if (anim.leg === 0) {
                if (findGroups().length) { anim = null; resolve(); }
                else { anim.leg = 1; waitT = SWAP_MS; }   // illegal swap: slide back
              } else {
                exchange({ x: anim.ax, y: anim.ay }, { x: anim.bx, y: anim.by }); // undo in the data, no visual jump
                anim = null; mode = 'play';
              }
            } else if (mode === 'resolve' && !resolve()) {
              mode = 'play'; chain = 0;
              ensureMove();
            }
          }
        }
      }
      draw(now);
      rafId = requestAnimationFrame(frame);
    }
    /* ------------------- Input: keyboard + drag + buttons ------------------- */
    /** Single place that flips the pause flag, so the shell's STATUS row can
     *  never disagree with the card on the canvas. */
    function setPaused(on) {
      paused = !!on;
      if (!paused) fresh = false;
      if (!over) setStatusApi(paused ? 'Paused' : (booted ? 'Playing' : 'Ready'));
    }
    function act(fn) { if (destroyed) return; if (over) { resetRun(); return; } setPaused(false); fn(); }
    function onKeyDown(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var a = document.activeElement;
      if (a && a !== canvas && /^(BUTTON|INPUT|SELECT|TEXTAREA|A|SUMMARY)$/.test(a.tagName)) return; // never steal from a real control
      var code = e.code, dir = KEYS[code];
      if (dir) {
        e.preventDefault();
        act(function () {
          if (hold) {                       // holding: the arrow is a swap, not a cursor move
            var ok = beginSwap(hold, { x: hold.x + dir[0], y: hold.y + dir[1] });
            hold = null;
            if (!ok) sel = null;            // crust or edge: drop the pick, never swap illegally
            return;
          }
          cur.x = clamp(cur.x + dir[0], 0, COLS - 1);
          cur.y = clamp(cur.y + dir[1], 0, limitY());
          sel = { x: cur.x, y: cur.y };
        });
        return;
      }
      if (code === 'Space' || code === 'Enter' || code === 'KeyR') {
        e.preventDefault();
        if (over) { resetRun(); return; }
        if (paused) { setPaused(false); return; }
        if (code === 'KeyR') { resetRun(); return; }
        if (hold) { hold = null; sel = null; return; }  // put the fruit back down
        hold = { x: cur.x, y: cur.y }; sel = { x: cur.x, y: cur.y };
      } else if (code === 'KeyP' || code === 'Escape') {
        e.preventDefault();
        if (over) return;
        if (!booted) { booted = true; setPaused(false); return; }
        setPaused(!paused);
      }
    }
    var KEYS = { ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0],
                 ArrowUp: [0, -1], KeyW: [0, -1], ArrowDown: [0, 1], KeyS: [0, 1] };
    var drag = null, downX = 0, downY = 0;
    function localPoint(e) { // client coords -> canvas layout coords
      var r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }
    function cellAtPoint(px, py) {
      var x = Math.floor((px - bx) / cell), y = Math.floor((py - by) / cell);
      return (x < 0 || y < 0 || x >= COLS || y >= ROWS) ? null : { x: x, y: y };
    }
    function buttonAt(px, py) {
      var pad = Math.max(8, cssW * 0.03), gap = 10, bw3 = (cssW - pad * 2 - gap) / 2, byy = cssH - barH + 7;
      if (py < byy || py > byy + barH - 14) return null;
      if (px >= pad && px <= pad + bw3) return 'pause';
      if (px >= pad + bw3 + gap && px <= pad + bw3 + gap + bw3) return 'new';
      return null;
    }
    function onPointerDown(e) {
      if (e.button !== undefined && e.button > 0) return;
      if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
      drag = null;
      var p = localPoint(e), btn = buttonAt(p.x, p.y);
      if (btn === 'new') { resetRun(); return; }
      if (btn === 'pause' || over || paused) {   // buttons, game-over and READY all restart/resume here
        if (over) resetRun();
        else if (!booted) { booted = true; setPaused(false); }
        else setPaused(btn !== 'pause' ? false : !paused);
        return;
      }
      var c = cellAtPoint(p.x, p.y);
      if (c && playable(c.x, c.y)) {              // remember the offset from the cell centre
        drag = c;
        downX = p.x - (bx + (c.x + 0.5) * cell); downY = p.y - (by + (c.y + 0.5) * cell);
      }
    }
    function onPointerMove(e) {
      if (!drag || destroyed) return;
      // The delta is read in board space, so a drag that wanders off the canvas still works.
      var p = localPoint(e);
      var gx = p.x - downX - (bx + (drag.x + 0.5) * cell), gy = p.y - downY - (by + (drag.y + 0.5) * cell);
      if (Math.max(Math.abs(gx), Math.abs(gy)) < cell * FLICK) return;
      var from = drag;
      drag = null;
      if (beginSwap(from, Math.abs(gx) > Math.abs(gy) ? { x: from.x + (gx > 0 ? 1 : -1), y: from.y }
                                                    : { x: from.x, y: from.y + (gy > 0 ? 1 : -1) })) sel = { x: from.x, y: from.y };
    }
    function onPointerUp(e) {
      var tapped = drag;
      drag = null;
      if (!tapped || !e) return;
      var p = localPoint(e), c = cellAtPoint(p.x, p.y);
      if (!c || !playable(c.x, c.y)) { sel = null; return; }
      if (sel && Math.abs(sel.x - c.x) + Math.abs(sel.y - c.y) === 1) {
        var from = sel; sel = null; beginSwap(from, c); return;   // tap a neighbour to swap
      }
      sel = { x: c.x, y: c.y }; cur = { x: c.x, y: c.y };
    }
    function onPointerCancel() { drag = null; }
    function onResize() { if (!destroyed) resize(); }
    function onBlur() { if (!destroyed && !over) setPaused(true); }   // auto-pause on focus loss
    function onVisibility() { if (document.hidden) onBlur(); }
    // Every listener the game owns, in one table so teardown cannot miss one.
    var BIND = [[document, 'keydown', onKeyDown], [canvas, 'pointerdown', onPointerDown],
      [canvas, 'pointermove', onPointerMove], [canvas, 'pointerup', onPointerUp],
      [canvas, 'pointercancel', onPointerCancel],
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
    name: 'Juice Jam',
    instructions:
      'Swap adjacent fruits to line up 3 or more — drag a fruit on touch, or use ARROW KEYS to move the ' +
      'cursor and SPACE to pick up, then an arrow to swap. Matches clear, new fruit falls in, and each ' +
      'cascade pays more than the last. Four in a row arms a striped fruit, five arms a colour bomb. The ' +
      'juice level climbs constantly and every fruit you clear drains it: when the crust reaches the top, ' +
      'the run is over. PAUSE and NEW GAME buttons sit in the thumb zone. Best score is saved here.',
    start: start
  };
})();
