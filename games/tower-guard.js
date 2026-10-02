/**
 * PIXEL RUSH — games/tower-guard.js — "Tower Guard"
 * Contract (SPEC.md): window.PixelGame = { name, instructions, start(root, api) } where
 * api = { setScore(n), setBest(n), gameOver(score) } and start() returns { destroy() }.
 * Self-contained: no imports, no dependencies, no assets — one <canvas> + 2D ctx, and
 * every rAF id and listener created in start() is torn down in destroy().
 */
(function () {
  'use strict';
  /* -------------------------------- Tuning -------------------------------- */
  var STORE_KEY = 'pixelrush.tower-guard.best'; // localStorage: all-time best score
  var BW = 100, BH = 70;            // board units; lane + pads are authored in this space
  var PATH = [[-6, 12], [72, 12], [72, 38], [28, 38], [28, 62], [96, 62]]; // fixed serpentine lane
  var SLOT_STEP = 13, SLOT_OFF = 9, SLOT_SELL = 0.65, TAP_SLOP = 26; // pad spacing, refund, finger slack
  var CREDIT_RATE = 5, START_CREDITS = 180, LIVES_MAX = 20, WAVES = 12;
  var TYPES = [ // 1 / 2 / 3 — the three buildable turrets
    { name: 'PULSE', cost: 50, range: 26, cd: 0.40, dmg: 15, col: 'cyan', kind: 'bolt' },
    { name: 'ARC', cost: 90, range: 24, cd: 0.95, dmg: 30, col: 'magenta', kind: 'arc' },
    { name: 'RAIL', cost: 160, range: 33, cd: 1.60, dmg: 58, col: 'acid', kind: 'rail' }
  ];
  var ENEMY = {
    grunt: { hp: 24, spd: 15, r: 3.4, bounty: 7, leak: 1, col: 'magenta', short: 'GRUNT' },
    runner: { hp: 15, spd: 27, r: 3.0, bounty: 9, leak: 1, col: 'orange', short: 'RUNNER' },
    brute: { hp: 80, spd: 9.5, r: 5.0, bounty: 20, leak: 3, col: 'violet', armor: 0.35, short: 'BRUTE' },
    boss: { hp: 620, spd: 6.5, r: 9.0, bounty: 150, leak: 10, col: 'magenta', armor: 0.2, short: 'BOSS' }
  };
  // Everything the spec does not name, prefixed `tg-` so it cannot collide with the shell
  var STYLES = '.tg{position:relative;width:100%;height:100%;overflow:hidden;touch-action:none;' +
    'user-select:none;-webkit-tap-highlight-color:transparent;' +
    'font-family:var(--font-body,"Rajdhani",system-ui,sans-serif);color:var(--ink,#f2f5ff)}' +
    '.tg canvas{display:block;width:100%;height:100%;outline:none}';
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  var tmpPt = {}; // scratch for per-frame lane samples, so draw() stays allocation-free
  function randInt(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
  function readBest() {
    try { var v = parseInt(window.localStorage.getItem(STORE_KEY), 10);
      return isFinite(v) && v > 0 ? v : null; } catch (e) { return null; } // private mode
  }
  function writeBest(v) { try { window.localStorage.setItem(STORE_KEY, String(v)); } catch (e) {} }
  /* ------------------------- Lane geometry (unit space) ------------------------- */
  var SEG = [], TOT = 0, SLOTS = [];
  (function buildGeometry() {
    var i, s, a, b, dx, dy, L, n, t, sgn, sx, sy, key, seen = {};
    for (i = 0; i < PATH.length - 1; i++) {
      a = PATH[i]; b = PATH[i + 1]; dx = b[0] - a[0]; dy = b[1] - a[1];
      L = Math.sqrt(dx * dx + dy * dy);
      SEG.push({ ax: a[0], ay: a[1], ux: dx / L, uy: dy / L, L: L, start: TOT }); TOT += L;
    }
    for (s = 0; s < SEG.length; s++) { // pads every SLOT_STEP units, alternating sides of the lane
      var g = SEG[s], nx = -g.uy, ny = g.ux; n = Math.floor(g.L / SLOT_STEP);
      for (i = 1; i <= n; i++) {
        t = i * SLOT_STEP; sgn = (i % 2) ? 1 : -1;
        sx = g.ax + g.ux * t + nx * sgn * SLOT_OFF; sy = g.ay + g.uy * t + ny * sgn * SLOT_OFF;
        if (sx < 3 || sx > 97 || sy < 4 || sy > 66) { sgn = -sgn; // off the plate — try the far side
          sx = g.ax + g.ux * t + nx * sgn * SLOT_OFF; sy = g.ay + g.uy * t + ny * sgn * SLOT_OFF;
          if (sx < 3 || sx > 97 || sy < 4 || sy > 66) continue; }
        key = Math.round(sx) + ',' + Math.round(sy);
        if (seen[key]) continue;
        seen[key] = 1; SLOTS.push({ x: sx, y: sy, turret: null });
      }
    }
  })();
  /** World point at distance `d` along the lane; writes into `out` to avoid per-frame garbage. */
  function pathAt(d, out) {
    out = out || {}; if (d < 0) d = 0;
    for (var i = 0; i < SEG.length; i++) {
      var s = SEG[i];
      if (d <= s.start + s.L || i === SEG.length - 1) {
        var k = clamp(d - s.start, 0, s.L);
        out.x = s.ax + s.ux * k; out.y = s.ay + s.uy * k; out.a = Math.atan2(s.uy, s.ux); return out;
      }
    }
    return out;
  }
  /** Perpendicular distance from a point to a finite segment — used by the rail beam. */
  function segDist(px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy, t = 0;
    if (L2 > 0) { t = clamp(((px - ax) * dx + (py - ay) * dy) / L2, 0, 1); }
    var ex = ax + dx * t - px, ey = ay + dy * t - py;
    return Math.sqrt(ex * ex + ey * ey);
  }
  /**
   * start(root, api) — build the game inside `root` and return { destroy }.
   * @param {HTMLElement} root
   * @param {{setScore:Function,setBest:Function,gameOver:Function}} api
   */
  function start(root, api) {
    api = api || {};
    var setScore = typeof api.setScore === 'function' ? api.setScore : function () {};
    var setBest = typeof api.setBest === 'function' ? api.setBest : function () {};
    var gameOverCb = typeof api.gameOver === 'function' ? api.gameOver : function () {};
    /* -------------------------------- DOM -------------------------------- */
    var wrap = document.createElement('div'); wrap.className = 'tg';
    var canvas = document.createElement('canvas');
    canvas.setAttribute('tabindex', '0'); canvas.setAttribute('role', 'application');
    canvas.setAttribute('aria-label', 'Tower Guard lane defence. Hold the core through twelve waves. ' +
      'Credits trickle in constantly. Tap a pad to build the selected turret, tap a built turret to sell it. ' +
      'Arrow keys move the cursor, 1 2 3 pick a turret, space builds or sells, enter starts the wave.');
    var live = document.createElement('div'); // screen-reader announcements
    live.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0)';
    live.setAttribute('aria-live', 'polite');
    var styleTag = document.createElement('style');
    styleTag.textContent = STYLES;
    wrap.appendChild(canvas); wrap.appendChild(live); wrap.appendChild(styleTag); root.appendChild(wrap);
    var ctx = canvas.getContext('2d');
    if (!ctx) { root.removeChild(wrap); return { destroy: function () {} }; }
    var rafId = 0, destroyed = false, ro = null;
    var reduced = !!(window.PX && window.PX.reduced) || !!(window.PX && window.PX.motionOn === false) ||
      !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    /* ------------------------------ Run state ------------------------------ */
    var turrets = [], enemies = [], bolts = [], beams = [], parts = []; // all reset in resetRun()
    var credits, lives, score, wave, phase, sel, cur, spawnQ, waveT, spawnI, ended;
    var bestEver = readBest(), isRecord = false, booted = false, paused = false, won = false, intro = false;
    var shake = 0, flashAt = -1e9, builtAt = -1e9, leakAt = -1e9, builtSlot = null, sellArm = null, sellAt = -1e9;
    /* ----------------- Sizing (crisp devicePixelRatio) ----------------- */
    var dpr = 1, cssW = 1, cssH = 1, sc = 1, bx = 0, by = 0, bw = 1, bh = 1, hudH = 30, noteH = 34;
    var compact = false; // short stage (a 390px phone gets ~343x186): chrome has to get out of the way
    function barHeight() { return compact ? 46 : clamp(cssH * 0.24, 100, 152); }
    function resize() {
      // Measure the LAYOUT box (offsetWidth/Height), not getBoundingClientRect(): the host animates
      // the stage with a CSS transform, so the rect is mid-animation and transform-sensitive while
      // the offset box and the ResizeObserver both report the final size. Reading the rect here
      // latched a stale width that the observer could never correct (it is transform-immune).
      var ow = wrap.offsetWidth, oh = wrap.offsetHeight;
      if (!ow || !oh) { // not laid out yet — fall back to the rect
        var r = wrap.getBoundingClientRect();
        ow = r.width; oh = r.height;
      }
      cssW = Math.max(1, Math.round(ow)); cssH = Math.max(1, Math.round(oh));
      dpr = clamp(window.devicePixelRatio || 1, 1, 2); // cap DPR: 2 is plenty, higher just costs fill rate
      canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
      canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // A phone stage is barely taller than the control bar alone. Below 300px the objective strip
      // folds into the HUD as a second line and the bar collapses to a single row, which buys back
      // the board height a fixed two-row bar would otherwise swallow whole.
      compact = cssH < 300;
      hudH = compact ? 34 : clamp(cssH * 0.085, 30, 48);
      noteH = compact ? 0 : clamp(cssH * 0.075, 30, 42);
      var availW = Math.max(40, cssW - 8);
      var availH = Math.max(36, cssH - hudH - noteH - barHeight() - (compact ? 4 : 8));
      sc = Math.min(availW / BW, availH / BH); // letterbox the 100x70 plate into any stage aspect
      bw = BW * sc; bh = BH * sc;
      bx = Math.round((cssW - bw) / 2); by = Math.round(hudH + noteH + (availH - bh) / 2);
    }
    function token(n, fb) { // pull a site custom property, with a hard fallback
      var v = getComputedStyle(document.documentElement).getPropertyValue(n);
      return (v && v.trim()) || fb;
    }
    var C = { bg: token('--bg', '#05060f'), ink: token('--ink', '#f2f5ff'), dim: token('--ink-dim', '#a7b0d0'),
      cyan: token('--cyan', '#22e7ff'), magenta: token('--magenta', '#ff2fb9'), acid: token('--acid', '#c8ff2e'),
      orange: token('--orange', '#ff8a3d'), violet: token('--violet', '#8b5cf6') };
    function hexA(hex, a) { // #rrggbb + alpha -> rgba()
      hex = (hex || '#fff').trim().replace('#', ''); var n = parseInt(hex, 16);
      return isFinite(n) ? 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')' : 'rgba(255,255,255,' + a + ')';
    }
    function rr(x, y, w, h, r) { // rounded-rect path, with a pre-roundRect fallback
      ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
    }
    /* ------------------------- Control-bar layout ------------------------- */
    var barY, rowH, rowA, rowB, gap = 6, pad = 8, btnStart = null, btnT = [], btnC = [];
    function layout() {
      var barH = barHeight(), i;
      barY = cssH - barH;
      if (compact) { // one row: the three turrets, then a wide START. The cursor and ACT buttons
        // are a keyboard/precision fallback and there is no vertical room for them at this height.
        pad = 5; gap = 4;
        var Wc = cssW - pad * 2;
        rowH = barH - pad * 2; rowA = barY + pad; rowB = rowA;
        var u = (Wc - gap * 4) / 5, xc = pad; // 3u + 2u + 4 gaps fills the row exactly
        for (i = 0; i < 3; i++) { btnT[i] = { x: xc, y: rowA, w: u, h: rowH }; xc += u + gap; }
        btnStart = { x: xc, y: rowA, w: u * 2 + gap, h: rowH };
        btnC = [];
        return;
      }
      pad = 8; gap = 6;
      var W = cssW - pad * 2;
      rowH = (barH - pad * 2 - gap) / 2; rowA = barY + pad; rowB = rowA + rowH + gap;
      var tw = (W - gap * 2) / 3, nw = (W - gap * 3) / 5; // 3 turret buttons; then a 5-unit cursor row
      for (i = 0; i < 3; i++) btnT[i] = { x: pad + i * (tw + gap), y: rowA, w: tw, h: rowH };
      // Row B is 5 unit widths across 4 gaps: two cursor steps, ACT, then a double-wide START.
      // Every x is chained off the previous button so none can slide off. START lives in the bar
      // rather than floating over the board, so reaching for it can never swallow a pad tap.
      var s2 = nw * 2 + gap, x2 = pad;
      btnC = [{ id: 'prev', x: x2, y: rowB, w: nw, h: rowH }]; x2 += nw + gap;
      btnC.push({ id: 'next', x: x2, y: rowB, w: nw, h: rowH }); x2 += nw + gap;
      btnC.push({ id: 'act', x: x2, y: rowB, w: nw, h: rowH }); x2 += nw + gap;
      btnStart = { x: x2, y: rowB, w: s2, h: rowH };
    }
    function inside(b, x, y, slop) { // slop keeps fat fingers from missing a button
      slop = slop === undefined ? TAP_SLOP : slop;
      return b && x >= b.x - slop && x <= b.x + b.w + slop && y >= b.y - slop && y <= b.y + b.h + slop;
    }
    /* ---------------------------- Game logic ---------------------------- */
    function addScore() {
      if (bestEver === null || score > bestEver) { bestEver = score; isRecord = true; writeBest(score); setBest(score); }
      setScore(score);
    }
    function slotAtIndex(i) { return SLOTS[(i + SLOTS.length) % SLOTS.length]; }
    function resetRun() {
      turrets.length = 0; enemies.length = 0; bolts.length = 0; beams.length = 0; parts.length = 0;
      for (var i = 0; i < SLOTS.length; i++) SLOTS[i].turret = null;
      credits = START_CREDITS; lives = LIVES_MAX; score = 0; wave = 0;
      phase = 'build'; sel = 0; cur = 0; spawnQ = []; waveT = 0; spawnI = 0;
      ended = false; won = false; shake = 0; isRecord = false; paused = false;
      sellArm = null; builtSlot = null;
      // The briefing card is a first-load thing only: `booted` is already true from the second
      // resetRun on, so a restart drops straight into a playable board instead of re-teaching.
      intro = !booted; booted = true;
      setScore(0); if (bestEver !== null) setBest(bestEver);
      live.textContent = 'New run. Build your turrets, then start wave 1.';
    }
    /** Composition for wave n (1..12) — pure, so the whole ramp is readable in one place. */
    function buildQueue(n) {
      var q = [], i, hp = 1 + (n - 1) * 0.48, sp = 1 + (n - 1) * 0.02, out = [], at = 0, j, t, kind, def;
      for (i = 0; i < Math.round(4 + n * 1.7); i++) q.push('grunt');               // grunts from wave 1
      if (n >= 2) for (i = 0; i < Math.round((n - 1) * 1.5); i++) q.push('runner'); // runners from wave 2
      if (n >= 4) for (i = 0; i < Math.round((n - 3) * 1.2); i++) q.push('brute');  // armour from wave 4
      if (n === WAVES) q.push('boss');                                              // the boss closes the run
      for (i = q.length - 1; i > 0; i--) { j = randInt(0, i); t = q[i]; q[i] = q[j]; q[j] = t; }
      for (i = 0; i < q.length; i++) { // interleave, then space arrivals tighter as waves climb
        kind = q[i]; def = ENEMY[kind];
        out.push({ kind: kind, hp: def.hp * (kind === 'boss' ? 1 : hp), spd: def.spd * (kind === 'boss' ? 1 : sp),
          at: at, gap: Math.max(0.40, 1.0 - n * 0.045) * (kind === 'runner' ? 0.5 : kind === 'boss' ? 3 : 1) });
        at += out[i].gap;
      }
      return out;
    }
    /** What wave n will send, and what it costs if it arrives: the build-phase threat read-out. */
    function peek(n) {
      var t = { grunt: 0, runner: 0, brute: 0, boss: 0, leak: 0, total: 0 }, q = buildQueue(n), i, k;
      for (i = 0; i < q.length; i++) { k = q[i].kind; t[k]++; t.total++; t.leak += ENEMY[k].leak; }
      return t;
    }
    /** "7 GRUNT · 3 RUNNER", or a friendly "SCOUTS" when a wave is only grunts. */
    function threatText(t) {
      var bits = [], order = ['boss', 'brute', 'runner', 'grunt'], i, k, n;
      for (i = 0; i < order.length; i++) { k = order[i]; n = t[k];
        if (n) bits.push(n + ' ' + ENEMY[k].short + (n > 1 ? 'S' : '')); }
      return bits.length ? bits.join(' · ') : 'NOTHING';
    }
    function startWave() {
      if (ended || phase !== 'build') return;
      wave++; phase = 'wave'; spawnQ = buildQueue(wave); waveT = 0; spawnI = 0;
      for (var i = 0; i < turrets.length; i++) turrets[i].scan = 1.6; // show what each one covers
      live.textContent = 'Wave ' + wave + ' incoming. ' + spawnQ.length + ' hostiles.';
    }
    function spawn(q) {
      var e = ENEMY[q.kind], p = pathAt(0, {});
      enemies.push({ kind: q.kind, hp: q.hp, max: q.hp, d: 0, x: p.x, y: p.y, ang: p.a,
        spd: q.spd, r: e.r, bounty: e.bounty, leak: e.leak, armor: e.armor || 0, col: e.col, dead: false, flash: 0 });
    }
    function hurt(en, dmg, pierce) {
      if (en.dead) return;
      if (!pierce && en.armor) dmg *= (1 - en.armor);
      en.hp -= dmg; en.flash = 0.14;
      if (en.hp > 0) return;
      en.dead = true; score += en.bounty * 2; credits += en.bounty; addScore();
      if (!reduced) for (var i = 0; i < 7; i++) { // bloom of sparks
        var a = Math.random() * Math.PI * 2, sp = 6 + Math.random() * 16;
        parts.push({ x: en.x, y: en.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, t: 0.45, col: C[en.col] });
      }
    }
    function endRun(victory) { // api.gameOver() may only fire once per run
      if (ended || destroyed) return;
      ended = true; won = !!victory; paused = false;
      live.textContent = (won ? 'All waves held. ' : 'Core breached. ') + 'Final score ' + score + '.';
      gameOverCb(score);
    }
    /** Turret `t` picks the leading enemy in range and fires its one weapon. */
    function fireTurret(t) {
      var T = TYPES[t.type], best = null, bd = -1, i, e, dx, dy, ang, tx, ty, ex, ey, k, en, last, from, hit, nx2, nd, c;
      for (i = 0; i < enemies.length; i++) {
        e = enemies[i]; if (e.dead) continue;
        dx = e.x - t.slot.x; dy = e.y - t.slot.y;
        if (dx * dx + dy * dy > T.range * T.range) continue;
        if (e.d > bd) { bd = e.d; best = e; } // highest progress = nearest the core
      }
      if (!best) return;
      ang = Math.atan2(best.y - t.slot.y, best.x - t.slot.x);
      t.aim = ang; t.flash = 0.12; t.cd = T.cd; tx = best.x; ty = best.y;
      if (T.kind === 'bolt') {
        bolts.push({ x: t.slot.x, y: t.slot.y, tx: tx, ty: ty, dmg: T.dmg, col: C[T.col], sp: 110 });
      } else if (T.kind === 'arc') {
        beams.push({ x1: t.slot.x, y1: t.slot.y, x2: tx, y2: ty, col: C[T.col], t: 0.18, w: 1.2 });
        hurt(best, T.dmg);
        last = best; from = best; hit = 1;
        while (hit < 3) { // chain to two nearby hostiles at reduced damage
          nx2 = null; nd = 15;
          for (i = 0; i < enemies.length; i++) {
            c = enemies[i]; if (c.dead || c === last) continue;
            dx = c.x - from.x; dy = c.y - from.y;
            if (dx * dx + dy * dy < nd * nd) { nd = dx * dx + dy * dy; nx2 = c; }
          }
          if (!nx2) break;
          beams.push({ x1: from.x, y1: from.y, x2: nx2.x, y2: nx2.y, col: C[T.col], t: 0.18, w: 1 });
          hurt(nx2, T.dmg * 0.6); last = nx2; from = nx2; hit++;
        }
      } else { // rail: a piercing beam along the full range, ignores armour
        ex = t.slot.x + Math.cos(ang) * T.range; ey = t.slot.y + Math.sin(ang) * T.range;
        beams.push({ x1: t.slot.x, y1: t.slot.y, x2: ex, y2: ey, col: C[T.col], t: 0.22, w: 1.8 });
        for (k = 0; k < enemies.length; k++) {
          en = enemies[k];
          if (!en.dead && segDist(en.x, en.y, t.slot.x, t.slot.y, ex, ey) < en.r + 1.6) hurt(en, T.dmg, true);
        }
        shake = Math.max(shake, reduced ? 0 : 3);
      }
    }
    /**
     * Build on an empty pad, or sell whatever is standing on it. Selling takes two taps: a
     * stray thumb on a turret that is already doing its job should not silently dismantle it.
     */
    function build(slot) {
      var T = TYPES[sel], i;
      if (slot.turret) {
        var t = slot.turret;
        if (sellArm !== slot || performance.now() - sellAt > 2600) {
          sellArm = slot; sellAt = performance.now();
          live.textContent = 'Tap again to sell this ' + TYPES[t.type].name + ' turret.';
          return;
        }
        sellArm = null;
        credits += Math.floor(TYPES[t.type].cost * SLOT_SELL);
        slot.turret = null;
        for (i = turrets.length - 1; i >= 0; i--) if (turrets[i] === t) turrets.splice(i, 1);
        live.textContent = 'Sold ' + TYPES[t.type].name + ' turret.'; return;
      }
      sellArm = null;
      if (credits < T.cost) { flashAt = performance.now(); live.textContent = 'Not enough credits for a ' + T.name + '.'; return; }
      credits -= T.cost;
      var nw = { slot: slot, type: sel, cd: 0, aim: 0, flash: 0, scan: 0 };
      slot.turret = nw; turrets.push(nw); builtAt = performance.now(); builtSlot = slot;
      live.textContent = T.name + ' turret built on a pad. It fires on its own.';
    }
    function act() {
      if (ended) { booted = true; resetRun(); return; }
      paused = false; build(slotAtIndex(cur));
    }
    /* ------------------------------ Update ------------------------------ */
    function update(dt) {
      if (paused || ended || intro) return; // the briefing card is up: nothing ticks behind it
      credits += CREDIT_RATE * dt; // credits accrue whether or not a wave is running
      if (phase === 'build') return;
      waveT += dt;
      while (spawnI < spawnQ.length && spawnQ[spawnI].at <= waveT) spawn(spawnQ[spawnI++]);
      var i, e, b, dx, dy, d, mv, j, en, ex, ey, q, p = pathAt(0, {});
      for (i = 0; i < enemies.length; i++) { // walk the lane toward the core
        e = enemies[i]; if (e.dead) continue;
        e.d += e.spd * dt;
        if (e.flash > 0) e.flash -= dt;
        if (e.d >= TOT) { // reached the core: costs a life
          e.dead = true; lives -= e.leak; flashAt = performance.now(); leakAt = performance.now();
          shake = reduced ? 0 : 8;
          live.textContent = 'Leak! ' + e.leak + ' core ' + (e.leak === 1 ? 'life' : 'lives') + ' lost.';
          if (lives <= 0) { lives = 0; endRun(false); }
          continue;
        }
        pathAt(e.d, p); e.x = p.x; e.y = p.y; e.ang = p.a;
      }
      for (i = enemies.length - 1; i >= 0; i--) if (enemies[i].dead) enemies.splice(i, 1);
      // The core fell earlier in THIS frame. Nothing below may run: turrets still firing
      // would keep adding bounty (the round-over card then showed a different, higher number
      // than the one api.gameOver() was handed), and the wave-clear branch below would award
      // the 1500-point "all twelve held" bonus to a run that was actually breached.
      if (ended) return;
      for (i = 0; i < turrets.length; i++) { // auto-target, auto-fire
        var t = turrets[i];
        if (t.flash > 0) t.flash -= dt;
        if (t.scan > 0) t.scan -= dt;
        t.cd -= dt;
        if (t.cd <= 0) fireTurret(t);
      }
      for (i = bolts.length - 1; i >= 0; i--) { // pulse bolts home on the lane
        b = bolts[i]; dx = b.tx - b.x; dy = b.ty - b.y; d = Math.sqrt(dx * dx + dy * dy); mv = b.sp * dt;
        if (d <= mv) {
          for (j = 0; j < enemies.length; j++) {
            en = enemies[j]; ex = en.x - b.x; ey = en.y - b.y;
            if (!en.dead && ex * ex + ey * ey < (en.r + 1.2) * (en.r + 1.2)) { hurt(en, b.dmg); break; }
          }
          bolts.splice(i, 1); continue;
        }
        b.x += dx / d * mv; b.y += dy / d * mv;
      }
      for (i = beams.length - 1; i >= 0; i--) { beams[i].t -= dt; if (beams[i].t <= 0) beams.splice(i, 1); }
      for (i = parts.length - 1; i >= 0; i--) {
        q = parts[i]; q.t -= dt; q.x += q.vx * dt; q.y += q.vy * dt;
        if (q.t <= 0) parts.splice(i, 1);
      }
      if (spawnI >= spawnQ.length && enemies.length === 0) { // wave cleared
        phase = 'build'; credits += 35 + wave * 18; score += wave * 120; addScore();
        if (wave >= WAVES) { score += 1500 + lives * 25; addScore(); endRun(true); } // all twelve held
        else live.textContent = 'Wave ' + wave + ' cleared. Bonus ' + (wave * 120) + ' points.';
      }
    }
    /* ------------------------------- Draw ------------------------------- */
    function button(b, label, sub, col, active) {
      rr(b.x, b.y, b.w, b.h, Math.min(12, b.h * 0.28));
      ctx.fillStyle = active ? hexA(col, 0.2) : 'rgba(255,255,255,.04)'; ctx.fill();
      ctx.strokeStyle = active ? col : hexA(col, 0.4); ctx.lineWidth = active ? 2 : 1;
      ctx.shadowColor = col; ctx.shadowBlur = active ? 16 : 0; ctx.stroke(); ctx.shadowBlur = 0;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      // Seed the size from the button HEIGHT, but stop at the button WIDTH: on a portrait phone
      // the stage is taller than it is wide, so a height-only size makes long labels ('▶ START
      // WAVE 1', 'SEND THE NEXT WAVE') run out through the side of a narrow button.
      var fs = fitSize('800', 'Orbitron, system-ui, sans-serif', label,
        clamp(b.h * 0.34, 10, 20), b.w - 8, 8);
      ctx.font = '800 ' + fs + 'px Orbitron, system-ui, sans-serif';
      ctx.fillStyle = active ? col : C.ink;
      ctx.fillText(label, b.x + b.w / 2, sub ? b.y + b.h * 0.38 : b.y + b.h / 2);
      if (sub) {
        var sfs = fitSize('700', 'Rajdhani, system-ui, sans-serif', sub,
          Math.min(fs * 0.72, b.h * 0.26), b.w - 8, 7);
        ctx.font = '700 ' + sfs + 'px Rajdhani, system-ui, sans-serif';
        ctx.fillStyle = active ? C.ink : C.dim;
        ctx.fillText(sub, b.x + b.w / 2, b.y + b.h * 0.71);
      }
    }
    function lanePath() { // the fixed lane, in canvas pixels
      ctx.beginPath();
      for (var i = 0; i < PATH.length; i++) {
        var x = bx + PATH[i][0] * sc, y = by + PATH[i][1] * sc;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
    }
    function drawBoard(now) {
      rr(bx - 6, by - 6, bw + 12, bh + 12, 16);
      ctx.fillStyle = 'rgba(255,255,255,.035)'; ctx.fill();
      ctx.strokeStyle = hexA(C.cyan, 0.28); ctx.lineWidth = 1; ctx.stroke();
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      lanePath(); ctx.strokeStyle = hexA(C.cyan, 0.22); ctx.lineWidth = 9 * sc; ctx.stroke();
      lanePath(); ctx.strokeStyle = hexA(C.cyan, 0.75); ctx.lineWidth = 1.4; ctx.stroke();
      if (!reduced) { // flowing centre line, dropped under reduced motion
        ctx.setLineDash([5 * sc, 11 * sc]); ctx.lineDashOffset = -((now / 26) % (16 * sc));
        lanePath(); ctx.strokeStyle = hexA(C.acid, 0.5); ctx.lineWidth = 1.8; ctx.stroke();
        ctx.setLineDash([]); ctx.lineDashOffset = 0;
      } else { lanePath(); ctx.strokeStyle = hexA(C.acid, 0.4); ctx.lineWidth = 1.6; ctx.stroke(); }
      var i;
      // Direction chevrons marching down the lane: the single clearest "this way, hostiles".
      var p1, nch = 5, frac = reduced ? 0 : (now / 900) % 1;
      for (i = 0; i < nch; i++) {
        p1 = pathAt(TOT * (((i + frac) / nch) % 1), tmpPt);
        ctx.save(); ctx.translate(bx + p1.x * sc, by + p1.y * sc); ctx.rotate(p1.a);
        ctx.strokeStyle = hexA(C.orange, 0.75); ctx.lineWidth = Math.max(1.4, 2 * sc);
        ctx.beginPath(); ctx.moveTo(-2.6 * sc, -3 * sc); ctx.lineTo(1.6 * sc, 0); ctx.lineTo(-2.6 * sc, 3 * sc);
        ctx.stroke(); ctx.restore();
      }
      // Spawn gate on the left edge, labelled, so "where do they come from" is answered.
      var gx = bx + 2 * sc, gy = by + 12 * sc, pulse = reduced ? 1 : 0.7 + 0.3 * Math.sin(now / 260);
      ctx.save();
      ctx.fillStyle = hexA(C.magenta, 0.5 * pulse); ctx.shadowColor = C.magenta; ctx.shadowBlur = 14;
      ctx.beginPath(); ctx.moveTo(gx, gy - 4.5 * sc); ctx.lineTo(gx + 5.5 * sc, gy); ctx.lineTo(gx, gy + 4.5 * sc);
      ctx.closePath(); ctx.fill(); ctx.restore();
      plateText('IN', gx + 6.5 * sc, gy - 6.5 * sc, Math.max(9, 4.2 * sc), C.magenta, 'center');
      var cx = bx + 96 * sc, cy = by + 62 * sc; // the core being defended
      var beat = reduced ? 1 : 1 + 0.06 * Math.sin(now / 200);
      var hurtCore = now - leakAt < 320;
      var hue = hurtCore ? C.orange : (lives > LIVES_MAX * 0.3 ? C.cyan : C.magenta);
      ctx.save(); ctx.shadowColor = hue; ctx.shadowBlur = 26;
      ctx.strokeStyle = hue; ctx.lineWidth = 2.4; ctx.beginPath();
      for (var k = 0; k < 6; k++) {
        var a = k * Math.PI / 3 - Math.PI / 2, r = 7 * sc * (k % 2 ? 0.72 : 1) * beat;
        var px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r;
        if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath(); ctx.stroke(); ctx.fillStyle = hexA(hue, 0.55); ctx.fill(); ctx.restore();
      // A labelled status module in the empty top-right corner: what the core is, and what a
      // leak costs. Lives as countable pips, so "20" and "you have 6 left" mean the same thing.
      var n = LIVES_MAX, pw = 0.5, pgap = 0.22, tot = n * pw + (n - 1) * pgap;
      var sx0 = bx + 87 * sc - tot / 2 * sc, sy0 = by + 11 * sc;
      plateText('CORE ' + lives, bx + 87 * sc, by + 5 * sc, Math.max(9, 4.2 * sc), hue, 'center');
      for (i = 0; i < n; i++) {
        ctx.fillStyle = i < lives ? (lives <= 5 ? C.magenta : C.cyan) : hexA(C.ink, 0.18);
        ctx.fillRect(sx0 + i * (pw + pgap) * sc, sy0, Math.max(1.5, pw * sc), Math.max(2, 2.4 * sc));
      }
    }
    /** Small caption in board units, so it scales with the plate instead of the stage. */
    function plateText(s, x, y, size, col, align) {
      ctx.save(); ctx.textAlign = align || 'center'; ctx.textBaseline = 'middle';
      ctx.font = '800 ' + size + 'px Orbitron, system-ui, sans-serif';
      ctx.fillStyle = col; ctx.shadowColor = C.bg; ctx.shadowBlur = 4;
      ctx.fillText(s, x, y); ctx.restore();
    }
    /** The pad the tutorial points at: the free one with the most lane within reach, earliest first. */
    function suggestPad() {
      var T = TYPES[sel], best = null, bestN = -1, i, s, j, c, dx, dy, n;
      for (i = 0; i < SLOTS.length; i++) {
        s = SLOTS[i]; if (s.turret) continue;
        n = 0;
        for (j = 0; j < 14; j++) { // sample the lane: how much of it this pad actually covers
          c = pathAt(TOT * (j / 14), tmpPt);
          dx = c.x - s.x; dy = c.y - s.y;
          if (dx * dx + dy * dy <= T.range * T.range) n++;
        }
        if (n > bestN) { bestN = n; best = s; }
      }
      return best;
    }
    function drawSlots(now) {
      var focused = slotAtIndex(cur), r = 6.5 * sc, i, s, x, y, col, m, sug, teach;
      sug = (!turrets.length && phase === 'build' && !ended) ? suggestPad() : null;
      teach = !!sug;
      for (i = 0; i < SLOTS.length; i++) {
        s = SLOTS[i]; if (s.turret) continue;
        x = bx + s.x * sc; y = by + s.y * sc;
        col = s === focused ? C.acid : (credits >= TYPES[sel].cost ? C.cyan : C.dim);
        ctx.save(); ctx.strokeStyle = hexA(col, s === focused ? 0.95 : 0.55); ctx.lineWidth = s === focused ? 2.2 : 1.2;
        if (s === focused && !reduced) { ctx.shadowColor = C.acid; ctx.shadowBlur = 18; }
        rr(x - r, y - r, r * 2, r * 2, 4); ctx.stroke();
        ctx.fillStyle = hexA(col, s === focused ? 0.18 : 0.07); ctx.fill(); ctx.shadowBlur = 0;
        ctx.fillStyle = hexA(col, 0.85); m = r * 0.42;
        ctx.fillRect(x - m, y - 1, m * 2, 2); ctx.fillRect(x - 1, y - m, 2, m * 2); ctx.restore();
      }
      if (teach) { // the one pad the first 10 seconds care about: ringed, ranged, and named
        var pr = 1 + (reduced ? 0 : 0.18 * Math.sin(now / 240));
        x = bx + sug.x * sc; y = by + sug.y * sc;
        ctx.save(); ctx.strokeStyle = hexA(C.acid, 0.75); ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]); ctx.lineDashOffset = reduced ? 0 : -(now / 90) % 10;
        ctx.beginPath(); ctx.arc(x, y, r * 2.1 * pr, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]); ctx.globalAlpha = 0.4; ctx.strokeStyle = C[TYPES[sel].col]; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.arc(x, y, TYPES[sel].range * sc, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
        plateText('TAP TO BUILD', x, y + r * 2.1 * pr + 7 * sc, Math.max(9, 3.6 * sc), C.acid, 'center');
      }
    }
    function drawTurrets(now) {
      for (var i = 0; i < turrets.length; i++) {
        var t = turrets[i], T = TYPES[t.type], col = C[T.col];
        var x = bx + t.slot.x * sc, y = by + t.slot.y * sc, r = 6.4 * sc, a = t.aim - Math.PI / 2;
        // For the first moments of a wave every turret shows its reach: the direct answer to
        // "what does this thing I just placed actually do?"
        if (t.scan > 0) {
          ctx.save(); ctx.globalAlpha = clamp(t.scan / 1.6, 0, 1) * 0.45;
          ctx.strokeStyle = col; ctx.lineWidth = 1.4; ctx.setLineDash([4, 4]);
          ctx.lineDashOffset = reduced ? 0 : -(now / 70) % 8;
          ctx.beginPath(); ctx.arc(x, y, T.range * sc, 0, Math.PI * 2); ctx.stroke();
          ctx.restore();
        }
        ctx.save();
        if (t.flash > 0) { ctx.shadowColor = col; ctx.shadowBlur = 26; }
        ctx.strokeStyle = col; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = hexA(col, 0.18); ctx.fill(); ctx.shadowBlur = 0;
        ctx.strokeStyle = hexA(C.ink, 0.9); ctx.lineWidth = 2.4; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(a) * r * 1.5, y + Math.sin(a) * r * 1.5); ctx.stroke();
        if (t.flash > 0) { // muzzle flash
          ctx.fillStyle = col; ctx.beginPath();
          ctx.arc(x + Math.cos(a) * r * 1.6, y + Math.sin(a) * r * 1.6, 2.2 * sc, 0, Math.PI * 2); ctx.fill();
        }
        ctx.restore();
        if (sellArm === t.slot && now - sellAt < 2600) { // "tap again to sell" confirmation
          var bl2 = reduced ? 1 : 0.55 + 0.45 * Math.sin(now / 180);
          ctx.save(); ctx.globalAlpha = bl2; ctx.strokeStyle = C.orange; ctx.lineWidth = 2.2;
          ctx.beginPath(); ctx.arc(x, y, r * 1.7, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
          plateText('TAP AGAIN TO SELL +' + Math.floor(T.cost * SLOT_SELL) + ' CR',
            x, y + r * 1.7 + 7 * sc, Math.max(9, 3.4 * sc), C.orange, 'center');
        }
      }
      // Expanding ring on the pad you just built on, so the tap is never silent.
      if (builtSlot && now - builtAt < 600) {
        var q = clamp((now - builtAt) / 600, 0, 1), cx2 = bx + builtSlot.x * sc, cy2 = by + builtSlot.y * sc;
        ctx.save(); ctx.globalAlpha = 1 - q; ctx.strokeStyle = C.acid; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cx2, cy2, 6 * sc + q * 22 * sc, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      }
    }
    function drawEnemies(now) {
      for (var i = 0; i < enemies.length; i++) {
        var e = enemies[i], col = C[e.col], x = bx + e.x * sc, y = by + e.y * sc, r = e.r * sc;
        ctx.save(); ctx.shadowColor = col; ctx.shadowBlur = reduced ? 6 : 16;
        ctx.fillStyle = e.flash > 0 ? C.ink : hexA(col, 0.9); ctx.strokeStyle = col; ctx.lineWidth = 1.5;
        if (e.kind === 'boss') { // boss: a heavy hex shell around a pulsing core
          ctx.beginPath();
          for (var k = 0; k < 6; k++) {
            var a = k * Math.PI / 3 + e.ang, px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
            if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          }
          ctx.closePath(); ctx.fill(); ctx.stroke();
          var beat = reduced ? 1 : 0.7 + 0.3 * Math.sin(now / 130);
          ctx.fillStyle = C.acid; ctx.beginPath(); ctx.arc(x, y, r * 0.42 * beat, 0, Math.PI * 2); ctx.fill();
        } else { // grunt / runner / brute: a disc with a heading pip
          ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
          ctx.shadowBlur = 0; ctx.fillStyle = C.bg; ctx.beginPath();
          ctx.arc(x + Math.cos(e.ang) * r * 0.4, y + Math.sin(e.ang) * r * 0.4, r * 0.32, 0, Math.PI * 2); ctx.fill();
        }
        ctx.restore();
        if (e.d > TOT * 0.78) { // closing on the core: flag it before it actually lands
          var warn = reduced ? 1 : 0.45 + 0.55 * Math.abs(Math.sin(now / 130));
          ctx.save(); ctx.globalAlpha = warn; ctx.strokeStyle = C.magenta; ctx.lineWidth = 1.6;
          ctx.beginPath(); ctx.arc(x, y, r + 3.5 * sc * warn + 1, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
        }
        if (e.hp < e.max) { // damage bar, only once hurt
          var w = r * 2.2, hp = clamp(e.hp / e.max, 0, 1);
          ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(x - w / 2, y - r - 4, w, 2.4);
          ctx.fillStyle = hp > 0.4 ? C.acid : C.orange; ctx.fillRect(x - w / 2, y - r - 4, w * hp, 2.4);
        }
      }
    }
    function drawFx() {
      var i, L, q, b;
      for (i = 0; i < bolts.length; i++) {
        b = bolts[i]; ctx.save();
        ctx.shadowColor = b.col; ctx.shadowBlur = 14; ctx.fillStyle = b.col;
        ctx.beginPath(); ctx.arc(bx + b.x * sc, by + b.y * sc, 2 * sc, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      }
      for (i = 0; i < beams.length; i++) {
        L = beams[i]; ctx.save();
        ctx.strokeStyle = L.col; ctx.shadowColor = L.col; ctx.shadowBlur = 18;
        ctx.globalAlpha = clamp(L.t / 0.22, 0, 1); ctx.lineWidth = L.w * 3.2 * sc + 0.6; ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(bx + L.x1 * sc, by + L.y1 * sc); ctx.lineTo(bx + L.x2 * sc, by + L.y2 * sc);
        ctx.stroke(); ctx.restore();
      }
      for (i = 0; i < parts.length; i++) {
        q = parts[i]; ctx.fillStyle = hexA(q.col, clamp(q.t / 0.45, 0, 1));
        ctx.fillRect(bx + q.x * sc - 1.5, by + q.y * sc - 1.5, 3, 3);
      }
    }
    function hudTextW(s, f) { ctx.font = '700 ' + f + 'px Rajdhani, system-ui, sans-serif'; return ctx.measureText(s).width; }
    /** 0 = place a turret, 1 = send the wave, 2 = fight the first wave, 3 = on your own. */
    function tutStep() {
      if (ended || intro) return -1;
      if (turrets.length === 0) return 0;
      if (wave === 0) return 1;
      if (wave === 1 && phase === 'wave') return 2;
      return 3;
    }
    /**
     * The line that answers "what am I doing, and what happens next".
     * Returns [headline, detail, colour]; both the strip and the short-stage HUD draw it.
     */
    function statusText() {
      var t = tutStep(), n, pk, T = TYPES[sel];
      if (t === 0) return ['GOAL: HOLD THE CORE THROUGH ' + WAVES + ' WAVES',
        'STEP 1/2 · TAP THE RINGED + PAD TO PLACE ' + T.name + ' (' + T.cost + ' CR)', C.acid];
      if (t === 1) return ['GOAL: HOLD THE CORE THROUGH ' + WAVES + ' WAVES',
        'STEP 2/2 · TAP START WAVE 1 — THEY WALK IN, THEN STRAIGHT TO THE CORE', C.acid];
      if (t === 2) {
        n = enemies.length + spawnQ.length - spawnI;
        return ['WAVE ' + wave + ' INCOMING · ' + n + ' LEFT',
          'YOUR ' + turrets.length + ' TURRET' + (turrets.length > 1 ? 'S' : '') +
          ' FIRE ON THEIR OWN — DO NOT LET ANY REACH THE CORE', C.orange];
      }
      if (t === -1) return ['TOWER GUARD', '', C.cyan];
      if (phase === 'build') {
        pk = peek(wave + 1);
        return ['BUILD · WAVE ' + (wave + 1) + '/' + WAVES + ' INCOMING: ' + threatText(pk),
          'IF THEY ALL REACH THE CORE THAT COSTS ' + pk.leak + ' OF YOUR ' + lives + ' LIVES',
          lives <= 5 ? C.magenta : C.cyan];
      }
      n = enemies.length + spawnQ.length - spawnI;
      return ['WAVE ' + wave + '/' + WAVES + ' · ' + n + ' HOSTILES LEFT',
        'ANYTHING THAT REACHES THE CORE COSTS LIVES', C.orange];
    }
    /** Clip to maxW with an ellipsis rather than letting a line run into the wave pips. */
    function fit(s, weight, family, f, maxW) {
      ctx.font = weight + ' ' + f + 'px ' + family;
      if (ctx.measureText(s).width <= maxW) return s;
      while (s.length > 4 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
      return s + '…';
    }
    /**
     * Largest size at or below `f` at which `s` fits `maxW` in this exact font, floored at `min`.
     * Every on-canvas string that can grow longer than its box goes through here: a stage taller
     * than it is wide (a portrait phone) blows up any size derived from height alone.
     */
    function fitSize(weight, family, s, f, maxW, min) {
      var i = Math.round(f);
      while (i > min) {
        ctx.font = weight + ' ' + i + 'px ' + family;
        if (ctx.measureText(s).width <= maxW) return i;
        i--;
      }
      ctx.font = weight + ' ' + min + 'px ' + family;
      return min;
    }
    function drawHud(now) {
      var i, L = 8, R = cssW - 8, span = Math.max(20, R - L), pending, need, fits, cols, fs, lh, top;
      pending = phase === 'wave' ? enemies.length + spawnQ.length - spawnI : 0;
      fs = Math.round(clamp(cssH * (compact ? 0.055 : 0.032), 10, 15));
      lh = fs * 1.5;
      ctx.textBaseline = 'middle';
      if (compact) {
        // Short stage (a phone): one stats line, then the objective/threat line beneath it.
        // There is no room for a separate strip, so the objective lives in the HUD instead.
        var cells = ['CR ' + Math.floor(credits), 'WAVE ' + wave + '/' + WAVES,
          'CORE ' + lives, 'SCORE ' + score];
        do {
          need = 0;
          for (i = 0; i < cells.length; i++) need += hudTextW(cells[i], fs) + 12;
          if (need > span && fs > 8) fs--;
        } while (need > span && fs > 8);
        ctx.fillStyle = hexA(C.bg, 0.8); ctx.fillRect(0, 0, cssW, hudH);
        // Lay the cells out by measured width and share the slack: fixed quarters collide as
        // soon as one read-out grows a digit, which is exactly when you need to read it.
        var tot2 = 0, xs = L, g2;
        for (i = 0; i < cells.length; i++) { ctx.font = '700 ' + fs + 'px Rajdhani, system-ui, sans-serif'; tot2 += ctx.measureText(cells[i]).width; }
        g2 = Math.max(4, (span - tot2) / (cells.length - 1));
        ctx.textAlign = 'left';
        for (i = 0; i < cells.length; i++) {
          ctx.font = '700 ' + fs + 'px Rajdhani, system-ui, sans-serif';
          ctx.fillStyle = i === 0 ? (performance.now() - flashAt < 240 ? C.orange : C.acid)
            : (i === 2 ? (lives <= 5 ? C.magenta : C.ink) : C.ink);
          ctx.fillText(cells[i], xs, 11);
          xs += ctx.measureText(cells[i]).width + g2;
        }
        var st = statusText(), sfs = Math.round(clamp(Math.min(cssH * 0.045, cssW * 0.055), 9, 12));
        ctx.textAlign = 'left'; ctx.font = '800 ' + sfs + 'px Orbitron, system-ui, sans-serif';
        ctx.fillStyle = st[2];
        ctx.fillText(fit(st[0], '800', 'Orbitron, system-ui, sans-serif', sfs, cssW - 16), 8, 20 + (hudH - 20) * 0.5);
        return;
      }
      // Full labels first; the tight set is the same six readouts with the words cut back,
      // used when the stage is too narrow to hold three columns of the long ones side by side.
      var full = [['SCORE ' + score, 'BEST ' + (bestEver || 0)],
        [Math.floor(credits) + ' CR', '+' + CREDIT_RATE + '/s · WAVE ' + wave + '/' + WAVES],
        ['CORE ' + lives, phase === 'wave' ? 'LEFT ' + pending : 'BUILD PHASE']];
      var tight = [['S' + score, 'B' + (bestEver || 0)],
        [Math.floor(credits) + ' CR', '+' + CREDIT_RATE + ' · W' + wave + '/' + WAVES],
        ['CORE ' + lives, phase === 'wave' ? 'IN ' + pending : 'BUILD']];
      // The three columns are drawn left / centre / right, and the CENTRE one is pinned to the
      // midpoint while the outer two hug the edges — so the two clearances are independent
      // constraints, not one shared slack budget. Testing only the total let the centre sub-line
      // run flush into the right column on a 343px phone: in bounds, but reading as one line.
      var GUT = 14, mid = (L + R) / 2;
      function colsFit(c, f) {
        var w0 = Math.max(hudTextW(c[0][0], f), hudTextW(c[0][1], f));
        var w1 = Math.max(hudTextW(c[1][0], f), hudTextW(c[1][1], f));
        var w2 = Math.max(hudTextW(c[2][0], f), hudTextW(c[2][1], f));
        return L + w0 + GUT <= mid - w1 / 2 && mid + w1 / 2 + GUT <= R - w2;
      }
      do { // shrink the long labels a step at a time before giving up on them
        fits = colsFit(full, fs);
        if (!fits && fs > 10) fs--;
      } while (!fits && fs > 10);
      cols = full;
      if (!fits) { // still too wide — the short labels, then a stacked last resort
        cols = tight; fits = colsFit(tight, fs);
      }
      lh = fs * 1.5;
      top = Math.max(fs * 0.6, (hudH - lh) / 2);
      ctx.font = '700 ' + fs + 'px Rajdhani, system-ui, sans-serif';
      if (!fits) { // degenerate stage: one column per line, no chance of overlap
        ctx.textAlign = 'center';
        for (i = 0; i < 3; i++) {
          ctx.fillStyle = i === 0 ? C.ink : C.dim;
          ctx.fillText(cols[i][0] + '  ' + cols[i][1], (L + R) / 2, top + lh * i);
        }
        return;
      }
      ctx.textAlign = 'left';
      ctx.fillStyle = C.ink; ctx.fillText(cols[0][0], L, top);
      ctx.fillStyle = C.dim; ctx.fillText(cols[0][1], L, top + lh);
      ctx.textAlign = 'center';
      ctx.fillStyle = performance.now() - flashAt < 240 ? C.orange : C.acid;
      ctx.fillText(cols[1][0], (L + R) / 2, top);
      ctx.fillStyle = C.dim; ctx.fillText(cols[1][1], (L + R) / 2, top + lh);
      ctx.textAlign = 'right';
      ctx.fillStyle = lives <= 5 ? C.magenta : C.ink; ctx.fillText(cols[2][0], R, top);
      ctx.fillStyle = C.dim; ctx.fillText(cols[2][1], R, top + lh);
    }
    function drawNote(now) {
      if (compact) return; // folded into the HUD on a short stage
      var st = statusText(), i, k, y0 = hudH, h = noteH, done, cur, bl;
      ctx.fillStyle = 'rgba(4,6,16,.74)'; ctx.fillRect(0, y0, cssW, h);
      ctx.fillStyle = hexA(st[2], 0.5); ctx.fillRect(0, y0 + h - 1, cssW, 1);
      ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      var pw = 4, pgap = 2, pipW = WAVES * pw + (WAVES - 1) * pgap;
      var pxs = cssW - 10 - pipW, maxW = Math.max(60, pxs - 14);
      var fs = Math.round(clamp(Math.min(cssH * 0.030, cssW * 0.040), 11, 15));
      ctx.font = '800 ' + fs + 'px Orbitron, system-ui, sans-serif';
      ctx.fillStyle = st[2];
      ctx.fillText(fit(st[0], '800', 'Orbitron, system-ui, sans-serif', fs, maxW), 10, y0 + h * 0.36);
      if (st[1]) {
        var fs2 = Math.round(clamp(Math.min(cssH * 0.026, cssW * 0.036), 10, 13));
        ctx.font = '700 ' + fs2 + 'px Rajdhani, system-ui, sans-serif';
        ctx.fillStyle = C.ink;
        ctx.fillText(fit(st[1], '700', 'Rajdhani, system-ui, sans-serif', fs2, maxW), 10, y0 + h * 0.73);
      }
      // Wave pips: a progress bar for "how much of this run is left to hold".
      ctx.font = '800 9px Orbitron, system-ui, sans-serif'; ctx.textAlign = 'right';
      ctx.fillStyle = C.dim; ctx.fillText('WAVES', cssW - 10, y0 + h * 0.2);
      for (i = 0; i < WAVES; i++) {
        k = i + 1; done = wave > k; cur = wave + 1 === k;
        bl = cur && !reduced ? 0.55 + 0.45 * Math.sin(now / 200) : 1;
        ctx.fillStyle = done ? C.acid : (cur ? hexA(C.acid, 0.9 * bl) : hexA(C.ink, 0.2));
        ctx.fillRect(pxs + i * (pw + pgap), y0 + h * 0.46, pw, h * 0.4);
      }
    }
    function drawControls(now) {
      ctx.fillStyle = 'rgba(255,255,255,.03)'; ctx.fillRect(0, barY, cssW, cssH - barY);
      ctx.fillStyle = hexA(C.cyan, 0.25); ctx.fillRect(0, barY, cssW, 1);
      for (var i = 0; i < 3; i++) { // turret pickers show cost; unaffordable ones go dim
        var T = TYPES[i];
        button(btnT[i], T.name, T.cost + ' CR · ' + (i + 1), credits >= T.cost ? C[T.col] : C.dim, sel === i);
      }
      if (!compact) { // cursor/ACT row: a keyboard-equivalent fallback, only where it fits
        button(btnC[0], 'PREV', 'PAD', C.cyan, false);
        button(btnC[1], 'NEXT', 'PAD', C.cyan, false);
        button(btnC[2], 'ACT', 'BUILD / SELL', C.acid, false);
      }
      if (ended) {
        button(btnStart, won ? 'PLAY AGAIN' : 'RESTART', null, C.magenta, false);
      } else if (phase === 'build') {
        // The goalpost, permanently in the same thumb spot. Its own label pulses while the
        // tutorial is asking for it, so "what am I supposed to press" is never a question.
        var t0 = tutStep(), glow = t0 === 1 && !reduced && Math.floor(now / 320) % 2 === 0;
        if (compact) {
          button(btnStart, '▶ START WAVE ' + (wave + 1), t0 === 0 ? 'AFTER YOU BUILD' : 'SEND IT',
            C.acid, glow);
        } else {
          button(btnStart, '▶  START WAVE ' + (wave + 1), t0 === 0 ? 'AFTER YOU BUILD' : 'SEND THE NEXT WAVE',
            C.acid, glow);
        }
      } else {
        var left = enemies.length + spawnQ.length - spawnI;
        button(btnStart, compact ? 'WAVE ' + wave : 'WAVE ' + wave + ' RUNNING',
          left + (compact ? ' LEFT' : ' HOSTILES LEFT'), C.orange, false);
      }
    }
    function card(title, sub, color, hint) {
      ctx.fillStyle = hexA(C.bg, 0.80); ctx.fillRect(0, 0, cssW, cssH);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      // Height seeds the size, width has the final say. On a portrait phone the stage is the
      // LARGER dimension, so a height-only size blows 'TOWER GUARD' and its subtitle out through
      // both edges of a 343px canvas. fitSize walks it back until the line actually fits.
      var tfs = fitSize('900', 'Orbitron, system-ui, sans-serif', title,
        clamp(Math.min(cssH * 0.13, cssW * 0.14), 20, 58), cssW * 0.92, 15);
      ctx.font = '900 ' + tfs + 'px Orbitron, system-ui, sans-serif';
      ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 28;
      ctx.fillText(title, cssW / 2, cssH * 0.32); ctx.shadowBlur = 0;
      var subW = cssW * 0.90, subY = cssH * 0.43;
      var sfs = fitSize('700', 'Rajdhani, system-ui, sans-serif', sub,
        clamp(Math.min(cssH * 0.042, cssW * 0.055), 12, 20), subW, 10);
      // The end-of-run stat line ('SCORE 1234 · NEW BEST · WAVE 12/12 · CORE 3/20') is too long
      // for a 343px stage even at the smallest legible size, so it breaks on its separator and
      // stacks — clipped stats are worse than two short ones.
      var subs = [sub];
      if (sfs === 10) {
        ctx.font = '700 10px Rajdhani, system-ui, sans-serif';
        if (ctx.measureText(sub).width > subW) {
          var SEP = ' · ', cut = -1, at, best = 1e9, from = 0;
          while ((at = sub.indexOf(SEP, from)) >= 0) { // the separator nearest the midpoint
            if (Math.abs(at - sub.length / 2) < best) { best = Math.abs(at - sub.length / 2); cut = at; }
            from = at + SEP.length;
          }
          if (cut > 0) subs = [sub.slice(0, cut), sub.slice(cut + SEP.length)];
        }
      }
      ctx.font = '700 ' + sfs + 'px Rajdhani, system-ui, sans-serif';
      ctx.fillStyle = C.ink;
      for (var q = 0; q < subs.length; q++) {
        ctx.fillText(subs[q], cssW / 2, subY + (q - (subs.length - 1) / 2) * sfs * 1.3);
      }
      if (hint) {
        // A hint is a sentence or two: lay it out as wrapped lines, never as one run-on. It is
        // also FLOWED through the band between the subtitle and the control bar rather than
        // pinned to a fixed fraction of the height — on a tall portrait stage the old fixed anchor
        // dropped the paragraph straight on top of its own subtitle.
        var i, y, lines, LH = 1.35;
        var subBot = subY + ((subs.length - 1) / 2) * sfs * 1.3 + sfs * 0.7;
        var top = subBot + sfs * 1.2, bot = barY - 6, room = Math.max(34, bot - top);
        var hfs = Math.round(clamp(Math.min(cssH * 0.032, cssW * 0.045), 11, 16));
        for (;;) {
          lines = wrapLines(hint, hfs, cssW * 0.86);
          if ((lines.length - 1) * hfs * LH + hfs <= room || hfs <= 9) break;
          hfs -= 1;
        }
        var maxLines = Math.max(1, Math.floor((room - hfs) / (hfs * LH)) + 1);
        if (lines.length > maxLines) lines = lines.slice(0, maxLines);
        var blockH = (lines.length - 1) * hfs * LH;
        y = top + Math.max(0, (room - blockH) / 2);
        ctx.font = '600 ' + hfs + 'px Rajdhani, system-ui, sans-serif';
        ctx.fillStyle = C.dim;
        for (i = 0; i < lines.length; i++) { ctx.fillText(lines[i], cssW / 2, y + hfs * 0.5 + i * hfs * LH); }
      }
    }
    /** Greedy word wrap against the current font; keeps briefing copy readable on a 390px phone. */
    function wrapLines(s, f, maxW) {
      ctx.font = '600 ' + f + 'px Rajdhani, system-ui, sans-serif';
      var out = [], line = '', i, parts = String(s).split(/\s+/);
      for (i = 0; i < parts.length; i++) {
        if (parts[i] === '') continue;
        var t = line ? line + ' ' + parts[i] : parts[i];
        if (ctx.measureText(t).width > maxW && line) { out.push(line); line = parts[i]; }
        else line = t;
      }
      if (line) out.push(line);
      return out;
    }
    function draw(now) {
      ctx.fillStyle = C.bg; ctx.fillRect(0, 0, cssW, cssH);
      var ox = 0, oy = 0;
      if (shake > 0) { ox = (Math.random() - 0.5) * shake; oy = (Math.random() - 0.5) * shake; shake *= 0.86; }
      ctx.save(); ctx.translate(ox, oy);
      drawBoard(now); drawSlots(now); drawTurrets(now); drawEnemies(now); drawFx();
      if (phase === 'build' && !ended && tutStep() !== 0) { // ghost reach on the focused pad
        var f = slotAtIndex(cur);
        if (!f.turret && credits >= TYPES[sel].cost && performance.now() - builtAt > 220) {
          ctx.save(); ctx.globalAlpha = 0.32; ctx.strokeStyle = C[TYPES[sel].col]; ctx.lineWidth = 1.5;
          ctx.setLineDash([4, 4]); ctx.lineDashOffset = reduced ? 0 : -(now / 60) % 8;
          ctx.beginPath(); ctx.arc(bx + f.x * sc, by + f.y * sc, TYPES[sel].range * sc, 0, Math.PI * 2);
          ctx.stroke(); ctx.restore();
        }
      }
      ctx.restore();
      if (!reduced) { // CRT polish
        ctx.fillStyle = 'rgba(0,0,0,.14)';
        if (ctx.__pxH !== cssH) { var __px = document.createElement('canvas'); __px.width = 1; __px.height = 3;
          var __pxg = __px.getContext('2d'); __pxg.fillStyle = 'rgba(0,0,0,.14)'; __pxg.fillRect(0, 0, 1, 1);
          ctx.__pxP = ctx.createPattern(__px, 'repeat'); ctx.__pxH = cssH; }
        ctx.fillStyle = ctx.__pxP; ctx.fillRect(0, 0, cssW, cssH);
      }
      var vig = ctx.createRadialGradient(cssW / 2, cssH / 2, Math.min(cssW, cssH) * 0.35,
        cssW / 2, cssH / 2, Math.max(cssW, cssH) * 0.75);
      vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(0,0,0,.55)');
      ctx.fillStyle = vig; ctx.fillRect(0, 0, cssW, cssH);
      // Read-outs go on AFTER the scanlines and vignette, or they get dimmed by both and the
      // numbers stop being the brightest thing on screen — which is the whole point of a HUD.
      drawHud(now); drawNote(now); drawControls(now);
      if (intro) card('TOWER GUARD',
        'DEFEND THE CORE THROUGH ALL ' + WAVES + ' WAVES',
        C.cyan, 'Hostiles walk in from the left. Turrets on the pads shoot them by themselves. ' +
        'Credits trickle in, so keep building. You lose when CORE hits 0.');
      else if (paused && !ended) card('PAUSED',
        'WAVE ' + (phase === 'build' ? wave + 1 : wave) + ' · ' + Math.floor(credits) + ' CR · CORE ' + lives,
        C.cyan, 'Tap or press SPACE to resume');
      if (ended) card(won ? 'CORE HELD' : 'CORE BREACHED',
        'SCORE ' + score + (isRecord ? '  ·  NEW BEST' : '') + '  ·  WAVE ' + wave + '/' + WAVES +
        '  ·  CORE ' + lives + '/' + LIVES_MAX,
        won ? C.acid : C.magenta, 'TAP or press SPACE to play again');
    }
    /* -------------------------- Single rAF loop -------------------------- */
    function frame(now) {
      if (destroyed) return; // guard: destroy() can land between frames
      var dt = Math.min(0.05, (now - (frame.last || now)) / 1000); frame.last = now;
      update(dt);
      draw(now);
      if (destroyed) return; // destroy() may have been called from inside update()/draw()
      rafId = requestAnimationFrame(frame);
    }
    /* ------------------- Input: pointer, buttons, keyboard ------------------- */
    function wake() { booted = true; intro = false; paused = false; }
    function moveCursor(d) { cur = (cur + d + SLOTS.length) % SLOTS.length; }
    function onPointerDown(e) {
      if (destroyed || (e.button !== undefined && e.button !== 0)) return;
      wake();
      // The rect is in transformed (visual) px and the layout box is not, so scale the pointer
      // position into the same layout-space coordinates that layout() and draw() use.
      var r = canvas.getBoundingClientRect();
      var kx = r.width > 0 ? cssW / r.width : 1, ky = r.height > 0 ? cssH / r.height : 1;
      var px = (e.clientX - r.left) * kx, py = (e.clientY - r.top) * ky, i;
      if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (err) {} }
      if (ended) { if (inside(btnStart, px, py, 3)) { booted = true; resetRun(); } return; }
      for (i = 0; i < btnT.length; i++) if (inside(btnT[i], px, py, 3)) {
        if (credits >= TYPES[i].cost) sel = i; // unaffordable pickers keep the current selection
        return;
      }
      for (i = 0; i < btnC.length; i++) if (inside(btnC[i], px, py, 3)) {
        if (btnC[i].id === 'prev') moveCursor(-1); else if (btnC[i].id === 'act') act(); else moveCursor(1);
        return;
      }
      if (inside(btnStart, px, py, 3)) { if (phase === 'build') startWave(); return; }
      // Pads sit above the control bar, so a build tap can never be swallowed by a button. The
      // catch radius is in board units, so floor it in screen px: on a small board a thumb still
      // has a 40px target rather than a 14px one.
      var ux = (px - bx) / sc, uy = (py - by) / sc, hitR = Math.max(11, 21 / sc), near = -1, nd = hitR * hitR;
      for (i = 0; i < SLOTS.length; i++) {
        var q = (SLOTS[i].x - ux) * (SLOTS[i].x - ux) + (SLOTS[i].y - uy) * (SLOTS[i].y - uy);
        if (q < nd) { nd = q; near = i; }
      }
      if (near >= 0) { cur = near; build(SLOTS[near]); }
    }
    function onPointerCancel() { /* tap model only — nothing is held between frames */ }
    function onKeyDown(e) {
      if (destroyed || e.metaKey || e.ctrlKey || e.altKey) return;
      var a = document.activeElement;
      if (a && a !== canvas && /^(BUTTON|INPUT|SELECT|TEXTAREA|A|SUMMARY)$/.test(a.tagName)) return;
      if (e.code === 'Digit1' || e.code === 'Digit2' || e.code === 'Digit3') {
        e.preventDefault(); wake();
        var n = +e.code.slice(5) - 1; if (credits >= TYPES[n].cost) sel = n; return;
      }
      if (/^(ArrowLeft|ArrowUp|KeyA|KeyW)$/.test(e.code)) { e.preventDefault(); wake(); moveCursor(-1); return; }
      if (/^(ArrowRight|ArrowDown|KeyD|KeyS)$/.test(e.code)) { e.preventDefault(); wake(); moveCursor(1); return; }
      if (e.code === 'Space' || e.key === ' ') { // build / sell on the focused pad, or restart
        e.preventDefault(); wake();
        if (ended) { booted = true; resetRun(); } else act(); return;
      }
      if (/^(Enter|NumpadEnter|KeyN)$/.test(e.code)) { // send the wave
        e.preventDefault(); wake();
        if (ended) { booted = true; resetRun(); } else startWave();
      }
    }
    function onResize() { if (!destroyed) { resize(); layout(); } }
    function onBlur() { if (!destroyed && !ended) paused = true; } // auto-pause on focus loss
    function onVisibility() { if (document.hidden) onBlur(); }
    // Every listener the game owns, in one table so teardown cannot miss one.
    var BIND = [[document, 'keydown', onKeyDown], [canvas, 'pointerdown', onPointerDown],
      [canvas, 'pointercancel', onPointerCancel],
      [window, 'resize', onResize, { passive: true }], [window, 'orientationchange', onResize],
      [window, 'blur', onBlur], [document, 'visibilitychange', onVisibility]];
    BIND.forEach(function (b) { b[0].addEventListener(b[1], b[2], b[3]); });
    resize(); layout(); resetRun(); // resize() first: it is what sizes the backing store and
    // computes the letterbox transform every draw() depends on. The window resize event never
    // fires on a plain page load, so without this the stage renders into a 300x150 buffer.
    if (window.ResizeObserver) { // belt and braces: catches a host that re-parents or reflows
      ro = new window.ResizeObserver(onResize);
      ro.observe(wrap);
    }
    rafId = requestAnimationFrame(frame);
    return {
      destroy: function () {
        if (destroyed) return; // idempotent
        destroyed = true; cancelAnimationFrame(rafId);
        BIND.forEach(function (b) { b[0].removeEventListener(b[1], b[2], b[3]); });
        if (ro) { ro.disconnect(); ro = null; }
        var parent = wrap.parentNode;
        // Removing the wrapper drops the canvas, the live region and the <style> together.
        if (parent && typeof parent.removeChild === 'function') parent.removeChild(wrap);
        else if (typeof wrap.remove === 'function') wrap.remove();
      }
    };
  }
  /* ---------------------- Public module contract ---------------------- */
  window.PixelGame = {
    name: 'Tower Guard',
    instructions:
      'GOAL: hold the CORE through all 12 waves. Hostiles walk in from the left along the lane and ' +
      'head straight for the core — every one that arrives costs you core lives, and at zero lives the ' +
      'run ends. You win by clearing all twelve waves. Credits trickle in at ' + CREDIT_RATE + '/s at all ' +
      'times, so spend them. Tap a glowing + pad to build the selected turret (PULSE 50, ARC 100, RAIL 160; ' +
      'tap a built turret to sell it back for 65%); the START WAVE button sends the next wave whenever ' +
      'you are ready. Turrets pick their own targets and fire on their own, and the strip above the board ' +
      'always tells you what is coming and what it will cost. Keyboard: ARROWS move the pad cursor, ' +
      '1 / 2 / 3 pick a turret, SPACE builds or sells, ENTER starts the wave.',
    start: start
  };
})();
