/**
 * PIXEL RUSH — games/apex-velocity.js — "Apex Velocity"
 * Contract (SPEC.md): window.PixelGame = { name, instructions, start(root, api) } where
 * api = { setScore(n), setBest(n), gameOver(score) } and start() returns { destroy() }.
 * Self-contained: no imports, no dependencies, no assets — one <canvas> + 2D ctx, and
 * every rAF id, listener and timer created in start() is torn down in destroy().
 */
(function () {
  'use strict';
  /* -------------------------------- Tuning -------------------------------- */
  var STORE_KEY = 'pixelrush.apex-velocity.best'; // must match the shell's key: pixelrush.<slug>.best
  var LAPS = 3;               // race distance
  var ROAD = 86;              // track half-width (world units, ~10u = 1 m)
  var RUNOFF = 150;           // grass ring; past this sits a barrier
  var V0 = 430;               // top speed on lap 1
  var ACCEL = 340, BRAKE = 560, DRAG = 0.5, QDRAG = 0.0011, TURN = 2.25, GRIP = 9.5;
  var GRASS_VMAX = 0.58, GRASS_DRAG = 0.95, GRASS_GRIP = 3.0;
  // Road-keeping assist (rad/s of yaw pulled back toward the local track tangent, at
  // full weight). Open-loop throttle left the road inside 3 s and the runoff then held
  // the car at a crawl, which is exactly the "the controls do nothing" report. This is
  // faded out near the centreline and at a standstill, so it never fights a real line.
  // Road-keeping assist. ASSIST is capped below TURN (2.25 rad/s of steering) so the
  // player can always overrule it; ASSIST_LOOK is ~190 world units of lookahead. The
  // authority fades out above ASSIST_V0, because a helper that can hold the circuit at
  // full throttle deletes the whole game — the fast corners have to stay the player's
  // problem, which is the one thing this game is actually about.
  var ASSIST = 2.6, ASSIST_KICK = 90, ASSIST_LOOK = 13, ASSIST_V0 = 190, ASSIST_VFADE = 400;
  var LAUNCH = 170;           // speed the car is already doing when the lights go green
  var GHOST_DT = 0.05;        // ghost recording interval (s)
  var APEX_R = 36, APEX_PTS = 120, LAP_PTS = 600, STUCK_LIMIT = 8;
  // Circuit control points — PTS[0] sits on the start/finish straight.
  var PTS = [[700, 180], [1250, 200], [1750, 300], [2050, 640], [1950, 1050], [1600, 1230],
    [1300, 1120], [1080, 1330], [700, 1420], [350, 1230], [250, 800], [300, 470]];
  // Everything the spec does not name, prefixed `av-` so it cannot collide with the shell.
  var STYLES = '.av{position:relative;width:100%;height:100%;overflow:hidden;touch-action:none;' +
    'user-select:none;-webkit-tap-highlight-color:transparent;' +
    'font-family:var(--font-body,"Rajdhani",system-ui,sans-serif);color:var(--ink,#f2f5ff)}' +
    '.av canvas{display:block;width:100%;height:100%;outline:none}';
  var ghostBest = null;   // best run's lap lines + total time, kept for the page session
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  /** Shortest signed angular distance from `a` to `b`, in (-PI, PI]. */
  function angDiff(a, b) {
    var d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d <= -Math.PI) d += Math.PI * 2;
    return d;
  }
  function readBest() {
    try { var v = parseInt(window.localStorage.getItem(STORE_KEY), 10);
      return isFinite(v) && v > 0 ? v : null; } catch (e) { return null; } // private mode
  }
  function writeBest(v) {
    try { window.localStorage.setItem(STORE_KEY, String(v)); } catch (e) { /* ignore */ }
  }
  /** Weighted box blur over a circular array, in place. */
  function smooth(arr, key, radius, passes) {
    var L = arr.length, n = new Float64Array(L), i, d, g;
    for (var p = 0; p < passes; p++) {
      for (i = 0; i < L; i++) {
        var sum = 0, w = 0;
        for (d = -radius; d <= radius; d++) { g = 1 - Math.abs(d) / (radius + 1);
          sum += arr[(i + d + L) % L][key] * g; w += g; }
        n[i] = sum / w;
      }
      for (i = 0; i < L; i++) arr[i][key] = n[i];
    }
  }
  /* ------------------------- Circuit construction ------------------------- */
  /** Catmull-Rom through PTS, resampled to uniform arc length, with curvature + racing line. */
  function buildTrack() {
    var raw = [], n = PTS.length, SUB = 28, i, s, t, t2, t3;
    for (i = 0; i < n; i++) {
      var p0 = PTS[(i - 1 + n) % n], p1 = PTS[i], p2 = PTS[(i + 1) % n], p3 = PTS[(i + 2) % n];
      for (s = 0; s < SUB; s++) {
        t = s / SUB; t2 = t * t; t3 = t2 * t;
        raw.push({
          x: 0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
          y: 0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)
        });
      }
    }
    var cum = [0], total = 0;
    for (i = 1; i <= raw.length; i++) {
      var a = raw[i - 1], b = raw[i % raw.length];
      total += Math.sqrt((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y)); cum.push(total);
    }
    var count = Math.max(64, Math.round(total / 14)), step = total / count, out = [], si = 0;
    for (i = 0; i < count; i++) {
      var target = i * step;
      while (si + 1 < cum.length - 2 && cum[si + 1] < target) si++;
      var seg = (cum[si + 1] - cum[si]) || 1, u = clamp((target - cum[si]) / seg, 0, 1);
      var p = raw[si], q = raw[(si + 1) % raw.length];
      out.push({ x: p.x + (q.x - p.x) * u, y: p.y + (q.y - p.y) * u, s: target, tx: 0, ty: 0, k: 0, off: 0 });
    }
    var L = count;
    for (i = 0; i < L; i++) { // unit tangents
      var nx = out[(i + 1) % L], dx = nx.x - out[i].x, dy = nx.y - out[i].y;
      var m = Math.sqrt(dx * dx + dy * dy) || 1; out[i].tx = dx / m; out[i].ty = dy / m;
    }
    for (i = 0; i < L; i++) { // signed curvature, radians per world unit (1 / corner radius)
      // Menger curvature through three consecutive samples. Dividing the chord/tangent
      // cross product by step^3 gave a correctly-shaped value that was 28x too small, so
      // the apex threshold below was unreachable and the racing line sat on the centreline.
      var a2 = out[(i - 1 + L) % L], b2 = out[(i + 1) % L], c2 = out[i];
      var e1x = c2.x - a2.x, e1y = c2.y - a2.y, e2x = b2.x - c2.x, e2y = b2.y - c2.y;
      var l1 = Math.sqrt(e1x * e1x + e1y * e1y) || 1;
      var l2 = Math.sqrt(e2x * e2x + e2y * e2y) || 1;
      var l3 = Math.sqrt((b2.x - a2.x) * (b2.x - a2.x) + (b2.y - a2.y) * (b2.y - a2.y)) || 1;
      out[i].k = 2 * (e1x * e2y - e1y * e2x) / (l1 * l2 * l3);
    }
    smooth(out, 'k', 4, 3);
    // Racing line: offset toward the inside of each corner, then relaxed twice.
    // Positive lateral offset is the right of travel (see project()), and a positive
    // curvature is a right-hand turn, so the inside is on the +k side.
    for (i = 0; i < L; i++) out[i].off = clamp(out[i].k * 5200, -ROAD * 0.5, ROAD * 0.5);
    smooth(out, 'off', 10, 2);
    // Apex markers: curvature maxima, thinned out so they never cluster.
    var apexes = [], lastA = -1e9;
    for (i = 0; i < L; i++) {
      var kk = Math.abs(out[i].k);
      if (kk < 0.0022 || i - lastA < 16) continue;
      var isMax = true;
      for (var d = -8; d <= 8; d++) if (Math.abs(out[(i + d + L) % L].k) > kk) { isMax = false; break; }
      if (!isMax) continue;
      lastA = i;
      // dir orients the chevron so its point faces into the corner: a positive
      // curvature turns right, and the inside of that corner is the +off side.
      apexes.push({ i: i, s: out[i].s, x: out[i].x, y: out[i].y, dir: out[i].k > 0 ? -1 : 1, mark: -1 });
    }
    return { pts: out, L: L, step: step, len: total, apexes: apexes,
      par: (total / V0 * 1000) * LAPS * 1.4 }; // par: unreachable at a flat-out pace, so it rewards a clean race
  }
  function fmt(ms) {
    if (ms == null) return '--:--.---';
    var m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60, x = Math.floor(ms) % 1000;
    return m + ':' + (s < 10 ? '0' : '') + s + '.' + ('00' + x).slice(-3);
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
    var wrap = document.createElement('div'); wrap.className = 'av';
    var canvas = document.createElement('canvas');
    canvas.setAttribute('tabindex', '0'); canvas.setAttribute('role', 'application');
    canvas.setAttribute('aria-label', 'Apex Velocity circuit racer. Up or W accelerates, down or S brakes, ' +
      'left and right arrows steer. On touch, use the four on-screen buttons.');
    var live = document.createElement('div'); // screen-reader announcements
    live.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0)';
    live.setAttribute('aria-live', 'polite');
    wrap.appendChild(canvas); wrap.appendChild(live);
    var styleTag = document.createElement('style');
    styleTag.textContent = STYLES; wrap.appendChild(styleTag); root.appendChild(wrap); // one <style>, scoped to .av
    var ctx = canvas.getContext('2d');
    if (!ctx) { root.removeChild(wrap); return { destroy: function () {} }; }
    var rafId = 0, destroyed = false, last = performance.now();
    var launchTimer = 0;   // auto-launch: nobody should have to read anything to get moving
    var tookOver = false;  // has the player touched anything yet?
    var reduced = !!(window.PX && window.PX.reduced) ||
      !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    var TRK = buildTrack();
    /* -------------------------------- State -------------------------------- */
    var car = { x: 0, y: 0, a: 0, vf: 0, vl: 0 };
    var cam = { x: 0, y: 0, z: 1 };
    var state = 'ready';        // ready | run | paused | over
    var lap = 0, sProg = 0, prevS = 0, hint = 0, crossMid = false, stuck = 0;
    var elapsed = 0, lapStart = 0, bestLap = null, lapTimes = [];
    var score = 0, bestEver = readBest(), apexGot = 0, off = 0, grass = false;
    var ghost = ghostBest, lapGhost = [[]], gAcc = 0, delta = 0, deltaAt = 0, dnf = false, beaten = false;
    var crashAt = -1e9, hitAt = -1e9, flashAt = -1e9, shake = 0, parts = [];
    var over = false;           // hard latch: api.gameOver() fires at most once per run
    var keys = { acc: 0, brk: 0, lft: 0, rgt: 0 };
    var touch = { acc: 0, brk: 0, lft: 0, rgt: 0 };
    var dpr = 1, cssW = 1, cssH = 1, B = {};
    /* ----------------- Sizing (crisp devicePixelRatio) ----------------- */
    function resize() {
      // Measured from the wrapper's own box, not from the canvas: the canvas is sized
      // from this measurement, so reading it back here would be circular.
      var r = wrap.getBoundingClientRect();
      var w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
      var d = clamp(window.devicePixelRatio || 1, 1, 2); // contract: cap DPR at 2
      if (w === cssW && h === cssH && d === dpr) return; // no-op writes can retrigger layout
      cssW = w; cssH = h; dpr = d;
      canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
      canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // World view: ~740 units wide and never less than ~400 tall. It used to be 980x560,
      // which framed the car as a 38px speck in a wide empty field rather than a car.
      cam.z = Math.max(cssW / 760, cssH / 400);
      var side = clamp(Math.min(cssW, cssH) * 0.115, 34, 66) * 1.7, pad = side * 0.2;
      var by = cssH - side - pad * 0.8;
      B = { ll: { x: pad, y: by, w: side, h: side }, lr: { x: pad * 2 + side, y: by, w: side, h: side },
        bk: { x: cssW - pad * 2 - side * 2, y: by, w: side, h: side },
        ac: { x: cssW - pad - side, y: by, w: side, h: side } };
    }
    resize();
    /* A `resize` event can fire before layout has settled, which latched a stale
       container height and left the backing store permanently half-size. Observe the
       wrapper so the canvas re-measures itself whenever its real box changes, and give
       the window handler a rAF settle pass for the DPR-only cases RO cannot see. */
    var ro = null, settleRaf = 0;
    if (window.ResizeObserver) {
      ro = new ResizeObserver(function () { if (!destroyed) resize(); });
      ro.observe(wrap);
    }
    function scheduleResize() {
      if (destroyed || settleRaf) return;
      settleRaf = requestAnimationFrame(function () { settleRaf = 0; if (!destroyed) resize(); });
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
      return isFinite(n) ? 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')' : 'rgba(255,255,255,' + a + ')';
    }
    /**
     * Set ctx.font to the largest size at or below `size` that keeps `text` inside
     * `maxW`, and leave it set. The stage is taller than it is wide on a phone, so a
     * font sized from cssH alone balloons and the string runs off both edges; the
     * caller therefore passes a cssW-capped `size`, and this shrinks it further when
     * the string is simply too long for the width available.
     */
    function fitFont(weight, family, size, maxW, text) {
      var f = Math.max(10, Math.round(size));
      ctx.font = weight + ' ' + f + 'px ' + family;
      var w = ctx.measureText(text).width;
      if (w > maxW && w > 0) {
        f = Math.max(10, Math.floor(f * (maxW / w)));
        ctx.font = weight + ' ' + f + 'px ' + family;
      }
      return f;
    }
    function rr(x, y, w, h, r) {
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
    }
    /* ---------------------------- Track query ---------------------------- */
    /** Project a world point onto the centreline, searching locally from `hint`. */
    function project(x, y) {
      var P = TRK.pts, L = TRK.L, bestI = 0, bestD = 1e18, bestT = 0, SPAN = 26, d, i;
      for (d = -SPAN; d <= SPAN; d++) {
        i = (hint + d + L * 4) % L;
        var a = P[i], b = P[(i + 1) % L];
        var vx = b.x - a.x, vy = b.y - a.y, wx = x - a.x, wy = y - a.y;
        var len2 = vx * vx + vy * vy || 1, t = clamp((wx * vx + wy * vy) / len2, 0, 1);
        var px = a.x + vx * t - x, py = a.y + vy * t - y, dd = px * px + py * py;
        if (dd < bestD) { bestD = dd; bestI = i; bestT = t; }
      }
      var a2 = P[bestI], b2 = P[(bestI + 1) % L];
      var ex = b2.x - a2.x, ey = b2.y - a2.y, len = Math.sqrt(ex * ex + ey * ey) || 1;
      hint = bestI;
      // Signed lateral offset, positive to the right of the direction of travel.
      return { s: a2.s + bestT * len, off: -((x - a2.x) * ey - (y - a2.y) * ex) / len,
        x: a2.x + ex * bestT, y: a2.y + ey * bestT };
    }
    /* ---------------------------- Game logic ---------------------------- */
    function speedCap() { return V0 * (1 + 0.07 * lap); }     // ramp: each lap is quicker…
    function accelCap() { return ACCEL * (1 + 0.09 * lap); }
    function gripCap() { return GRIP * (1 - 0.09 * lap); }    // …and looser, so apexes bite harder
    function addScore(v) { score += v; setScore(score); }
    function resetRun(go) {
      var p = TRK.pts[0];
      car.x = p.x; car.y = p.y; car.a = Math.atan2(p.ty, p.tx);
      car.vf = go ? LAUNCH : 0; car.vl = 0;   // the lights go green with the car already rolling
      cam.x = car.x; cam.y = car.y;
      hint = 0; lap = 0; sProg = 0; prevS = 0; crossMid = false; stuck = 0;
      elapsed = 0; lapStart = 0; bestLap = null; lapTimes = []; lapGhost = [[]];
      score = 0; apexGot = 0; off = 0; grass = false; dnf = false; over = false; beaten = false;
      gAcc = 0; delta = 0; shake = 0; parts.length = 0; held = {}; tookOver = false;
      for (var i = 0; i < TRK.apexes.length; i++) TRK.apexes[i].mark = -1;
      // Touch pads are dropped (the finger lifts to restart), but the keyboard state is
      // kept so a key held across the restart keeps driving.
      touch.acc = touch.brk = touch.lft = touch.rgt = 0;
      crashAt = -1e9; hitAt = -1e9; flashAt = -1e9; last = performance.now();
      state = go ? 'run' : 'ready';
      setScore(0);
      if (bestEver !== null) setBest(bestEver);
      live.textContent = 'Race ready. Three laps.';
    }
    function onLap() {
      // elapsed is kept in SECONDS for the physics; every display/scoring value is ms.
      var t = (elapsed - lapStart) * 1000; lapStart = elapsed; lapTimes.push(t);
      if (bestLap == null || t < bestLap) bestLap = t;
      lap++; crossMid = false; lapGhost.push([]);
      for (var i = 0; i < TRK.apexes.length; i++) TRK.apexes[i].mark = -1; // apexes re-arm each lap
      addScore(600);
      if (lap >= LAPS) { finish(false); return; }
      live.textContent = 'Lap ' + lap + ' of ' + LAPS + '. Time ' + fmt(t) + '. Score ' + score + '.';
    }
    function finish(dnfRun) {
      if (over || destroyed) return;   // api.gameOver() may only fire once per run
      over = true; dnf = dnfRun; state = 'over';
      var bonus = 0, beat = false;
      if (!dnfRun) {
        var totalMs = elapsed * 1000;
        bonus = Math.max(0, Math.round((TRK.par - totalMs) * 0.4));
        if (ghost && elapsed < ghost.t) beat = true;
        if (!ghost || elapsed < ghost.t) { ghostBest = { t: elapsed, laps: lapGhost }; ghost = ghostBest; }
        beaten = beat;   // latched before `ghost` is replaced, so the overlay can still show it
        addScore(bonus + (beat ? 2500 : 0));
      }
      if (bestEver === null || score > bestEver) { bestEver = score; writeBest(score); setBest(score); }
      live.textContent = (dnfRun ? 'Retired. ' : 'Finished in ' + fmt(elapsed * 1000) + '. ') + 'Score ' + score + '.';
      gameOverCb(score);
    }
    function crossApexes(from, to) { // award apexes whose arc length we just passed
      var A = TRK.apexes, i, hit;
      for (i = 0; i < A.length; i++) {
        hit = (from <= to) ? (A[i].s > from && A[i].s <= to) : (A[i].s > from || A[i].s <= to);
        if (!hit || A[i].mark === lap) continue;
        A[i].mark = lap;
        var dx = car.x - A[i].x, dy = car.y - A[i].y, d = Math.sqrt(dx * dx + dy * dy);
        if (d < APEX_R && Math.abs(car.vf) > speedCap() * 0.45 && !grass) {
          apexGot++; flashAt = performance.now(); addScore(APEX_PTS);
        }
      }
    }
    /** Ghost sample list for the lap we are on, clamped to the laps it actually has. */
    function ghostLap() {
      if (!ghost || !ghost.laps.length) return null;
      return ghost.laps[Math.min(lap, ghost.laps.length - 1)] || null;
    }
    function update(dt, now) {
      elapsed += dt;
      // The rolling start holds the throttle for the player until the first input, and
      // gives up by itself after 20 s so it can never quietly race the whole grid. A run
      // nobody ever touched is not allowed to retire either — a "stranded in the runoff"
      // card for a race the player never played is just a confusing dead screen.
      if (!tookOver && (keys.acc || keys.brk || keys.lft || keys.rgt ||
        touch.acc || touch.brk || touch.lft || touch.rgt)) tookOver = true;
      var maxV = speedCap();
      var thr = (keys.acc || touch.acc || (!tookOver && elapsed < 20)) ? 1 : 0, brk = (keys.brk || touch.brk) ? 1 : 0;
      var steer = ((keys.rgt || touch.rgt) ? 1 : 0) - ((keys.lft || touch.lft) ? 1 : 0);
      // Longitudinal: throttle, brakes, engine braking, aero drag.
      if (thr) car.vf += accelCap() * dt * (1 - 0.45 * Math.min(1, Math.abs(car.vf) / maxV));
      if (brk) car.vf -= BRAKE * dt * (car.vf > 0 ? 1 : -0.7);
      if (!thr && !brk) car.vf -= Math.sign(car.vf) * Math.min(Math.abs(car.vf), 150 * dt);
      car.vf -= car.vf * (DRAG + QDRAG * Math.abs(car.vf)) * dt;
      if (grass) { // off-track: brutal drag plus a hard speed cap
        car.vf *= Math.exp(-GRASS_DRAG * dt);
        car.vf = clamp(car.vf, -maxV * GRASS_VMAX, maxV * GRASS_VMAX);
      }
      car.vf = clamp(car.vf, -maxV, maxV);
      // Steering strength scales with speed: at a crawl the car barely turns, and at
      // full speed it rotates fast but slides wide — so every apex must be braked for.
      var sf = 0.34 + 0.66 * Math.min(1, Math.abs(car.vf) / maxV);
      car.a += steer * TURN * sf * dt * (car.vf < -1 ? -1 : 1);
      car.vl *= Math.exp(-(grass ? GRASS_GRIP : gripCap()) * dt);
      var fx = Math.cos(car.a), fy = Math.sin(car.a);
      car.x += (fx * car.vf - fy * car.vl) * dt; car.y += (fy * car.vf + fx * car.vl) * dt;
      if (Math.abs(car.vf) < 2.5 && Math.abs(car.vl) < 2.5) { car.vf = 0; car.vl = 0; }
      for (var q = parts.length - 1; q >= 0; q--) { // integrate sparks
        var sp = parts[q];
        sp.x += sp.vx * dt; sp.y += sp.vy * dt; sp.vx *= 0.94; sp.vy *= 0.94;
        if (now - sp.t > 620) parts.splice(q, 1);
      }
      // Track containment
      var p = project(car.x, car.y);
      off = p.off; grass = Math.abs(off) > ROAD + 3;
      // Road-keeping. Open-loop throttle used to leave the road inside 3 s and the runoff
      // then held the car at walking pace, which is exactly the "the controls do nothing"
      // report. This is a pure-pursuit controller onto the racing line: the heading is eased
      // toward a point on the target line a fixed distance ahead, which is zero-error when
      // the car is on the line and proportional to the error when it is not. Aiming at the
      // *tangent* instead (the obvious thing) has a standing error and parks the car on the
      // kerb; aiming at the tangent also points along the barrier, so a car in the runoff
      // had nothing to steer back toward.
      var P0 = TRK.pts[hint], A = TRK.pts[(hint + ASSIST_LOOK) % TRK.L];
      var aimX = A.x - A.ty * A.off, aimY = A.y + A.tx * A.off;
      var av = Math.abs(car.vf);
      var ramp = clamp((Math.abs(off - P0.off) - ROAD * 0.06) / (ROAD * 0.35), 0, 1);
      var kick = clamp(av / ASSIST_KICK, 0, 1);
      var fade = clamp((ASSIST_VFADE - av) / (ASSIST_VFADE - ASSIST_V0), 0, 1);
      // Once the car is genuinely off the road the fade is waived: climbing back onto the
      // tarmac is never the player's problem, only holding the line at speed is.
      var aw = ramp * kick * (Math.abs(off) > ROAD ? Math.max(fade, 0.8) : fade);
      if (aw > 0) car.a += angDiff(car.a, Math.atan2(aimY - car.y, aimX - car.x)) *
        aw * (1 - Math.exp(-ASSIST * dt));
      if (Math.abs(off) > RUNOFF) { // barrier: scrub speed, kick the car back inboard
        var sgn = off < 0 ? -1 : 1, nx = -fy * sgn, ny = fx * sgn;
        car.x = p.x + nx * RUNOFF; car.y = p.y + ny * RUNOFF;
        if (now - hitAt > 380) {
          hitAt = now; crashAt = now; shake = reduced ? 0 : 1; car.vf *= 0.7; car.vl = 0;
          for (var i = 0; i < 16; i++) {
            parts.push({ x: car.x, y: car.y, t: now, c: C.orange,
              vx: -nx * (60 + Math.random() * 260) + (Math.random() - 0.5) * 200,
              vy: -ny * (60 + Math.random() * 260) + (Math.random() - 0.5) * 200 });
          }
        }
      }
      // Lap counting: a bare wrap is not enough, you must also have crossed halfway.
      prevS = sProg; sProg = p.s;
      if (sProg > TRK.len * 0.4 && sProg < TRK.len * 0.6) crossMid = true;
      if (crossMid && prevS > TRK.len * 0.6 && sProg < TRK.len * 0.4) onLap();
      crossApexes(prevS, sProg);
      // DNF: stranded in the runoff with no way to recover
      if (tookOver && grass && Math.abs(car.vf) < 8) stuck += dt; else stuck = 0;
      if (stuck > STUCK_LIMIT) { finish(true); return; }
      // Ghost recording + live gap
      gAcc += dt;
      if (gAcc >= GHOST_DT) {
        gAcc = 0;
        lapGhost[lapGhost.length - 1].push({ t: elapsed - lapStart, s: p.s, x: car.x, y: car.y });
        if (now - deltaAt > 100) {
          deltaAt = now;
          var gl = ghostLap();
          if (gl && gl.length) {
            var gt = gl[0].t, i2;
            for (i2 = 0; i2 < gl.length; i2++) { if (gl[i2].s >= p.s) { gt = gl[i2].t; break; } gt = gl[i2].t; }
            delta = (elapsed - lapStart) - gt;   // positive = behind the ghost
          }
        }
      }
    }
    function updateCamera(dt) {
      var k = 1 - Math.pow(0.0016, dt);
      var tx = car.x + Math.cos(car.a) * car.vf * 0.45, ty = car.y + Math.sin(car.a) * car.vf * 0.45;
      cam.x += (tx - cam.x) * k; cam.y += (ty - cam.y) * k;
      if (shake > 0) shake = Math.max(0, shake - dt * 3.2);
    }
    /* ------------------------------ Drawing ------------------------------ */
    /** Polyline along the circuit, offset `width` to one side (0/falsy = the racing line). */
    function linePath(width, side) {
      var P = TRK.pts, L = TRK.L, i, p, nx, ny, w, X, Y;
      ctx.beginPath();
      for (i = 0; i <= L; i++) {
        p = P[i % L]; nx = -p.ty; ny = p.tx; w = width ? width * side : p.off;
        X = p.x + nx * w; Y = p.y + ny * w;
        if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
      }
    }
    function drawTrack(now) {
      var P = TRK.pts, i;
      // Asphalt: one thick stroke along the centreline gives the whole road slab.
      ctx.save(); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      linePath(0, 1); ctx.strokeStyle = '#0b1030'; ctx.lineWidth = ROAD * 2; ctx.stroke();
      linePath(0, 1); ctx.strokeStyle = hexA(C.cyan, 0.07); ctx.lineWidth = 1; ctx.stroke(); ctx.restore();
      // Kerbs marking where grip ends, then the outer barriers.
      ctx.save(); ctx.setLineDash([30, 26]); ctx.strokeStyle = hexA(C.cyan, 0.5); ctx.lineWidth = 3;
      for (i = 0; i < 2; i++) { linePath(ROAD + 3, i ? -1 : 1); ctx.stroke(); }
      ctx.restore();
      for (i = 0; i < 2; i++) {
        ctx.save(); linePath(RUNOFF, i ? -1 : 1);
        ctx.strokeStyle = hexA(C.orange, 0.5); ctx.lineWidth = 3;
        ctx.shadowColor = C.orange; ctx.shadowBlur = 12; ctx.stroke(); ctx.restore();
      }
      // Racing line
      ctx.save(); ctx.setLineDash([26, 22]); ctx.lineWidth = 5;
      ctx.strokeStyle = hexA(C.violet, 0.75); ctx.shadowColor = C.violet; ctx.shadowBlur = 14;
      linePath(0, 1); ctx.stroke(); ctx.restore();
      // Apex markers: chevrons across the turn-in side
      for (i = 0; i < TRK.apexes.length; i++) {
        var A = TRK.apexes[i], P0 = P[A.i];
        var hot = now - flashAt < 420 && Math.sqrt((car.x - A.x) * (car.x - A.x) + (car.y - A.y) * (car.y - A.y)) < 170;
        var pulse = reduced ? 1 : 0.75 + 0.25 * Math.sin(now / 260 + i);
        ctx.save();
        ctx.strokeStyle = hot ? C.acid : C.magenta; ctx.shadowColor = ctx.strokeStyle; ctx.shadowBlur = 20 * pulse;
        ctx.lineWidth = 7; ctx.lineCap = 'round';
        ctx.translate(A.x, A.y); ctx.rotate(Math.atan2(P0.ty, P0.tx));
        for (var c2 = 0; c2 < 2; c2++) { // two nested chevrons
          var d2 = c2 * 26 - 13;
          ctx.beginPath(); ctx.moveTo(d2 - 16, -22 * A.dir); ctx.lineTo(d2 + 8, 0); ctx.lineTo(d2 - 16, 22 * A.dir); ctx.stroke();
        }
        ctx.restore();
      }
      // Start / finish line
      var q = P[0];
      ctx.save(); ctx.translate(q.x, q.y); ctx.rotate(Math.atan2(q.tx, -q.ty));
      for (var k2 = 0; k2 < 8; k2++) {
        ctx.fillStyle = k2 % 2 ? C.ink : '#0b1030';
        ctx.fillRect(-8, -ROAD + k2 * (ROAD * 2 / 8), 16, ROAD * 2 / 8);
      }
      ctx.restore();
    }
    function drawGhost(now) {
      if (!ghost || !ghost.laps.length) return;
      ctx.save(); ctx.lineJoin = 'round';
      ctx.strokeStyle = hexA(C.magenta, 0.4); ctx.lineWidth = 7;
      ctx.shadowColor = C.magenta; ctx.shadowBlur = 14;
      for (var l = 0; l < ghost.laps.length; l++) { // the whole best run, every lap
        var arr = ghost.laps[l];
        if (arr.length < 2) continue;
        ctx.beginPath();
        for (var i = 0; i < arr.length; i++) { if (i === 0) ctx.moveTo(arr[i].x, arr[i].y); else ctx.lineTo(arr[i].x, arr[i].y); }
        ctx.stroke();
      }
      ctx.restore();
      var gl = ghostLap();                 // ghost car, placed by time on the lap we are on
      if (!gl || gl.length < 2) return;
      var t = elapsed - lapStart, a = gl[0], b = gl[gl.length - 1], i2;
      for (i2 = 1; i2 < gl.length; i2++) { if (gl[i2].t >= t) { a = gl[i2 - 1]; b = gl[i2]; break; } }
      var f = b.t > a.t ? clamp((t - a.t) / (b.t - a.t), 0, 1) : 0;
      var pulse = reduced ? 1 : 0.85 + 0.15 * Math.sin(now / 220);
      ctx.save();
      ctx.translate(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f);
      ctx.globalAlpha = 0.75; ctx.fillStyle = hexA(C.magenta, 0.5);
      ctx.shadowColor = C.magenta; ctx.shadowBlur = 22;
      ctx.fillRect(-22 * pulse, -13, 44, 26); ctx.restore();
    }
    function drawCar(now) {
      for (var i = 0; i < parts.length; i++) { // sparks
        var p = parts[i], age = (now - p.t) / 620;
        ctx.save(); ctx.globalAlpha = 1 - age; ctx.fillStyle = p.c;
        ctx.shadowColor = p.c; ctx.shadowBlur = 12;
        ctx.beginPath(); ctx.arc(p.x, p.y, 6 * (1 - age) + 1.5, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      }
      ctx.save();
      ctx.translate(car.x + (shake ? (Math.random() - 0.5) * 18 * shake : 0),
        car.y + (shake ? (Math.random() - 0.5) * 18 * shake : 0));
      ctx.rotate(car.a);
      if (!reduced) { // headlight cone, so heading reads at a glance on a phone
        var cone = ctx.createLinearGradient(20, 0, 190, 0);
        cone.addColorStop(0, hexA(C.acid, 0.16)); cone.addColorStop(1, hexA(C.acid, 0));
        ctx.fillStyle = cone; ctx.beginPath();
        ctx.moveTo(20, -12); ctx.lineTo(190, -60); ctx.lineTo(190, 60); ctx.lineTo(20, 12);
        ctx.closePath(); ctx.fill();
      }
      ctx.shadowColor = C.cyan; ctx.shadowBlur = 26; ctx.fillStyle = C.cyan;
      rr(-22, -13, 44, 26, 7); ctx.fill();
      ctx.shadowBlur = 0; ctx.fillStyle = '#061024';
      rr(-6, -8, 18, 16, 4); ctx.fill();          // cockpit
      ctx.fillStyle = C.acid; ctx.fillRect(12, -9, 5, 18); // nose stripe
      if (keys.brk || touch.brk) {
        ctx.fillStyle = C.magenta; ctx.shadowColor = C.magenta; ctx.shadowBlur = 18;
        ctx.fillRect(-24, -11, 5, 7); ctx.fillRect(-24, 4, 5, 7);
      }
      ctx.restore();
    }
    function button(box, label, on, color, hot) {
      var hx = box.w / 2, hy = box.h / 2;
      ctx.save();
      rr(box.x, box.y, box.w, box.h, box.w * 0.26);
      // The idle pads were a 5%-white outline and read as decoration, not as the only
      // controls in the game. They now sit on a visible plate at all times.
      ctx.fillStyle = on ? hexA(color, 0.32) : (hot ? hexA(color, 0.13) : 'rgba(255,255,255,.10)');
      ctx.fill();
      ctx.strokeStyle = on ? color : hexA(color, hot ? 0.9 : 0.7);
      ctx.lineWidth = hot ? 3 : 2;
      ctx.shadowColor = color; ctx.shadowBlur = on ? 20 : (hot ? 12 : 8); ctx.stroke();
      ctx.shadowColor = 'rgba(0,0,0,.9)'; ctx.shadowBlur = 5; // label stays readable over the world
      ctx.fillStyle = on ? C.ink : hexA(color, 1);
      ctx.font = '700 ' + Math.round(hy * 0.48) + 'px Rajdhani, system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(label, box.x + hx, box.y + hy + 1);
      ctx.restore();
    }
    function drawHUD(now) {
      var fs = Math.round(clamp(Math.min(cssH * 0.030, cssW * 0.042), 11, 17)), pad = Math.max(8, cssW * 0.035);
      ctx.textBaseline = 'top'; ctx.textAlign = 'left';
      // Text shadow, not a colour change: keeps the readouts legible over bright track bits
      // while the fills stay at their existing (already AA-passing) hues.
      ctx.shadowColor = 'rgba(0,0,0,.9)'; ctx.shadowBlur = 5; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 1;
      ctx.font = '700 ' + fs + 'px Rajdhani, system-ui, sans-serif';
      ctx.fillStyle = C.dim; ctx.fillText('LAP ' + Math.min(lap + 1, LAPS) + '/' + LAPS, pad, pad);
      ctx.fillStyle = C.ink; ctx.fillText(fmt((elapsed - lapStart) * 1000), pad, pad + fs * 1.25);
      ctx.fillStyle = C.dim; ctx.fillText('BEST ' + fmt(bestLap), pad, pad + fs * 2.5);
      ctx.textAlign = 'right';
      ctx.fillStyle = C.dim; ctx.fillText('SCORE ' + score, cssW - pad, pad);
      ctx.fillStyle = C.ink; ctx.fillText('BEST ' + (bestEver || 0), cssW - pad, pad + fs * 1.25);
      ctx.fillStyle = C.violet; ctx.fillText('APEX x' + apexGot, cssW - pad, pad + fs * 2.5);
      if (ghost && ghost.laps.length) { // gap to the ghost, top centre
        var ahead = delta <= 0;
        ctx.textAlign = 'center';
        ctx.font = '700 ' + Math.round(fs * 1.15) + 'px Rajdhani, system-ui, sans-serif';
        ctx.fillStyle = state === 'run' ? (ahead ? C.acid : C.orange) : C.dim;
        ctx.fillText((ahead ? '- ' : '+ ') + Math.abs(delta).toFixed(2), cssW / 2, pad);
        ctx.font = '700 ' + fs + 'px Rajdhani, system-ui, sans-serif';
        ctx.fillStyle = C.dim; ctx.fillText('GHOST', cssW / 2, pad + fs * 1.35);
      }
      // The bar sat at fs*2.7, only 0.2fs below the BEST readout it starts under, and on a
      // phone the smaller HUD font made the two collide — the bar painted over the time.
      var bw = Math.min(cssW * 0.42, 190), bx = (cssW - bw) / 2, by = pad + fs * 3.7;
      ctx.fillStyle = 'rgba(255,255,255,.08)'; rr(bx, by, bw, 7, 3.5); ctx.fill();
      var pct = clamp(Math.abs(car.vf) / speedCap(), 0, 1);
      ctx.save(); ctx.shadowColor = grass ? C.orange : C.cyan; ctx.shadowBlur = 12;
      ctx.fillStyle = grass ? C.orange : C.cyan;
      rr(bx, by, Math.max(4, bw * pct), 7, 3.5); ctx.fill(); ctx.restore();
      ctx.textAlign = 'left'; ctx.fillStyle = C.dim;
      ctx.fillText(Math.round(Math.abs(car.vf) * 0.36) + ' KM/H', bx, by + 11);
      if (grass) { ctx.textAlign = 'right'; ctx.fillStyle = C.orange; ctx.fillText('OFF TRACK', bx + bw, by + 11); }
      if (now - crashAt < 500) {
        // Its own band below the speed readout. "off track" and "wall" are independent
        // booleans, so this used to land on top of OFF TRACK and the KM/H number.
        var wf = Math.round(fs * 1.5), wy = by + fs * 3.6, ww;
        ctx.save();
        ctx.font = '900 ' + wf + 'px Orbitron, system-ui, sans-serif';
        ww = ctx.measureText('WALL').width;
        ctx.shadowBlur = 0;
        ctx.fillStyle = 'rgba(5,6,15,.72)';
        rr(cssW / 2 - ww / 2 - 12, wy - 5, ww + 24, wf + 10, 6); ctx.fill();
        ctx.textAlign = 'center'; ctx.fillStyle = C.orange;
        ctx.fillText('WALL', cssW / 2, wy);
        ctx.restore();
        ctx.font = '700 ' + fs + 'px Rajdhani, system-ui, sans-serif';
        ctx.shadowColor = 'rgba(0,0,0,.9)'; ctx.shadowBlur = 5; ctx.shadowOffsetY = 1;
      }
      ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    }
    function card(title, sub, color, hint) {
      var maxW = cssW * 0.92;
      ctx.fillStyle = hexA(C.bg, 0.74); ctx.fillRect(0, 0, cssW, cssH);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      fitFont('900', 'Orbitron, system-ui, sans-serif',
        clamp(Math.min(cssH * 0.13, cssW * 0.105), 18, 56), maxW, title);
      ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 28;
      ctx.fillText(title, cssW / 2, cssH * 0.4); ctx.shadowBlur = 0;
      var bf = clamp(Math.min(cssH * 0.045, cssW * 0.062), 12, 20);
      var scoreLine = 'SCORE ' + score +
        (bestEver != null && score > 0 && score >= bestEver ? '  -  NEW BEST' : '');
      fitFont('600', 'Rajdhani, system-ui, sans-serif', bf, maxW, sub);
      ctx.fillStyle = C.dim; ctx.fillText(sub, cssW / 2, cssH * 0.49);
      ctx.fillStyle = C.ink;
      fitFont('600', 'Rajdhani, system-ui, sans-serif', bf, maxW, scoreLine);
      ctx.fillText(scoreLine, cssW / 2, cssH * 0.555);
      if (hint) {
        ctx.fillStyle = C.cyan;
        fitFont('600', 'Rajdhani, system-ui, sans-serif', bf, maxW, hint);
        ctx.fillText(hint, cssW / 2, cssH * 0.64);
      }
      if (state === 'over' && lapTimes.length) {
        ctx.fillStyle = C.dim;
        var lapsLine = 'LAPS ' + lapTimes.map(fmt).join('   ');
        fitFont('600', 'Rajdhani, system-ui, sans-serif',
          clamp(Math.min(cssH * 0.038, cssW * 0.052), 11, 17), maxW, lapsLine);
        ctx.fillText(lapsLine, cssW / 2, cssH * 0.72);
      }
    }
    /**
     * The control legend. Drawn on the title card and again, faded, over the opening
     * stretch of the race — the pads alone are not discoverable enough, and a keyboard
     * player previously got no on-canvas hint at all after the card cleared.
     */
    function controlHint(alpha, yCentre) {
      if (alpha <= 0.01) return;
      var fs = Math.round(clamp(Math.min(cssH * 0.034, cssW * 0.045), 12, 20));
      var txt = cssW >= 560
        ? '↑ / W  GAS      ↓ / S  BRAKE      ← / →  STEER'
        : '↑ GAS   ↓ BRAKE   ← → STEER';
      ctx.save();
      ctx.globalAlpha = clamp(alpha, 0, 1);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      fs = fitFont('700', 'Rajdhani, system-ui, sans-serif', fs, cssW * 0.95 - fs * 2, txt);
      var w = Math.min(cssW * 0.95, ctx.measureText(txt).width + fs * 2), h = fs * 2.2;
      var x = (cssW - w) / 2, y = yCentre - h / 2;
      ctx.fillStyle = 'rgba(5,6,15,.86)';
      rr(x, y, w, h, h * 0.34); ctx.fill();
      ctx.strokeStyle = hexA(C.cyan, 0.65); ctx.lineWidth = 2;
      ctx.shadowColor = C.cyan; ctx.shadowBlur = 10; ctx.stroke();
      ctx.shadowColor = 'rgba(0,0,0,.9)'; ctx.shadowBlur = 4; ctx.fillStyle = C.ink;
      ctx.fillText(txt, cssW / 2, yCentre + 1);
      ctx.restore();
    }
    function draw(now) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = C.bg; ctx.fillRect(0, 0, cssW, cssH);
      ctx.save();
      ctx.translate(cssW / 2 + (shake ? (Math.random() - 0.5) * 14 * shake : 0),
        cssH / 2 + (shake ? (Math.random() - 0.5) * 14 * shake : 0));
      ctx.scale(cam.z, cam.z); ctx.translate(-cam.x, -cam.y);
      var G = 2600, gx, gy; // ground field + grid
      ctx.fillStyle = grass ? '#0a1a12' : '#08131b';
      ctx.fillRect(cam.x - G, cam.y - G, G * 2, G * 2);
      ctx.strokeStyle = hexA(C.cyan, 0.06); ctx.lineWidth = 2; ctx.beginPath();
      for (gx = Math.floor((cam.x - G) / 160) * 160; gx < cam.x + G; gx += 160) { ctx.moveTo(gx, cam.y - G); ctx.lineTo(gx, cam.y + G); }
      for (gy = Math.floor((cam.y - G) / 160) * 160; gy < cam.y + G; gy += 160) { ctx.moveTo(cam.x - G, gy); ctx.lineTo(cam.x + G, gy); }
      ctx.stroke();
      drawTrack(now);
      drawGhost(now);
      drawCar(now);
      ctx.restore();
      if (!reduced) { // CRT polish — world layer only; the HUD is painted on top of it
        ctx.fillStyle = 'rgba(0,0,0,.15)';
        if (ctx.__pxH !== cssH) { var __px = document.createElement('canvas'); __px.width = 1; __px.height = 3;
          var __pxg = __px.getContext('2d'); __pxg.fillStyle = 'rgba(0,0,0,.15)'; __pxg.fillRect(0, 0, 1, 1);
          ctx.__pxP = ctx.createPattern(__px, 'repeat'); ctx.__pxH = cssH; }
        ctx.fillStyle = ctx.__pxP; ctx.fillRect(0, 0, cssW, cssH);
        var vig = ctx.createRadialGradient(cssW / 2, cssH / 2, Math.min(cssW, cssH) * 0.35, cssW / 2, cssH / 2, Math.max(cssW, cssH) * 0.75);
        vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(0,0,0,.55)');
        ctx.fillStyle = vig; ctx.fillRect(0, 0, cssW, cssH);
      }
      drawHUD(now);
      var on = state === 'run'; // thumb-zone pads
      button(B.ll, '<', on && (keys.lft || touch.lft), C.cyan);
      button(B.lr, '>', on && (keys.rgt || touch.rgt), C.cyan);
      button(B.bk, 'BRK', on && (keys.brk || touch.brk), C.orange);
      button(B.ac, 'GAS', on && (keys.acc || touch.acc), C.acid, true);
      if (state === 'ready') {
        card('APEX VELOCITY', 'Three laps. Clip the chevrons, beat your ghost.', C.cyan,
          'HOLD GAS TO GO — or just watch, it launches');
        controlHint(1, cssH * 0.735);
      } else if (state === 'paused') {
        card('PAUSED', 'Tap a pad or press SPACE to resume', C.cyan, null);
      } else if (state === 'over') {
        card(dnf ? 'RETIRED' : 'FINISH',
          dnf ? 'Stranded in the runoff' : 'Total ' + fmt(elapsed * 1000) +
            (beaten ? '  -  GHOST BEATEN' : ''),
          dnf ? C.orange : C.magenta, 'TAP or press SPACE to race again');
      } else {
        // Opening-lap legend, above the pads, faded out by the end of lap 1.
        var t = elapsed - lapStart, hf = Math.round(clamp(Math.min(cssH * 0.034, cssW * 0.045), 12, 20));
        controlHint(t < 7 ? 1 : (t < 9.5 ? 1 - (t - 7) / 2.5 : 0), B.ll.y - hf * 2.4);
      }
    }
    /* -------------------------- Single rAF loop -------------------------- */
    function frame(now) {
      if (destroyed) return;   // guard: destroy() can land between frames
      var dt = Math.min(0.05, Math.max(0, (now - last) / 1000)); // a backgrounded tab cannot fast-forward
      last = now;
      if (state === 'run') { update(dt, now); updateCamera(dt); }
      draw(now);
      // Re-check before arming: api.gameOver() may have called destroy() inside update().
      if (!destroyed) rafId = requestAnimationFrame(frame);
    }
    /* ------------------ Input: keyboard + on-canvas pads ------------------ */
    function act() { // one place that (re)starts or unpauses a run
      if (destroyed) return;
      if (launchTimer) { clearTimeout(launchTimer); launchTimer = 0; }
      if (state === 'over') { resetRun(true); tookOver = true; return; }   // a restart is deliberate
      if (state === 'ready' || state === 'paused') {
        if (state === 'ready') { car.vf = LAUNCH; live.textContent = 'Go. Three laps.'; }
        state = 'run'; last = performance.now();
      }
    }
    var KEYS = { ArrowUp: 'acc', KeyW: 'acc', ArrowDown: 'brk', KeyS: 'brk',
      ArrowLeft: 'lft', KeyA: 'lft', ArrowRight: 'rgt', KeyD: 'rgt' };
    function onKeyDown(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === 'Space' || e.code === 'Enter' || e.key === ' ') {
        var a = document.activeElement; // never steal Space from a real control
        if (a && a !== canvas && /^(BUTTON|INPUT|SELECT|TEXTAREA|A|SUMMARY)$/.test(a.tagName)) return;
        e.preventDefault(); act(); return;
      }
      if (e.code === 'KeyR') { e.preventDefault(); resetRun(true); return; }
      var k = KEYS[e.code];
      if (k) { e.preventDefault(); keys[k] = 1; act(); }
    }
    function onKeyUp(e) {
      var k = KEYS[e.code];
      if (k) { e.preventDefault(); keys[k] = 0; }
    }
    var held = {}; // pointerId -> pad key, so multi-touch steering works
    function padAt(x, y) {
      var names = [['ll', 'lft'], ['lr', 'rgt'], ['bk', 'brk'], ['ac', 'acc']], i, b;
      for (i = 0; i < names.length; i++) {
        b = B[names[i][0]];
        if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return names[i][1];
      }
      return null;
    }
    function recomputeTouch() { // a pad stays held while ANY pointer is on it
      touch.lft = touch.rgt = touch.brk = touch.acc = 0;
      for (var id in held) { if (held.hasOwnProperty(id)) touch[held[id]] = 1; }
    }
    function onPointerDown(e) {
      if (e.button !== undefined && e.button > 0) return;
      var r = canvas.getBoundingClientRect();
      var pad = padAt(e.clientX - r.left, e.clientY - r.top);
      if (pad && canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
      if (pad) { held[e.pointerId] = pad; recomputeTouch(); act(); }
      else if (state !== 'run') act();   // tap elsewhere: start / unpause / restart
    }
    function onPointerUp(e) { if (held[e.pointerId]) { delete held[e.pointerId]; recomputeTouch(); } }
    function onResize() { if (!destroyed) { resize(); scheduleResize(); } }
    function onBlur() {
      if (!destroyed && state === 'run') { state = 'paused'; held = {}; recomputeTouch(); }
    }
    function onVisibility() { if (document.hidden) onBlur(); }
    function onFocus() { if (!destroyed && state === 'paused') act(); }
    // Every listener the game owns, in one table so teardown cannot miss one.
    var BIND = [[document, 'keydown', onKeyDown], [document, 'keyup', onKeyUp],
      [canvas, 'pointerdown', onPointerDown], [canvas, 'pointerup', onPointerUp],
      [canvas, 'pointercancel', onPointerUp], [canvas, 'lostpointercapture', onPointerUp],
      [window, 'resize', onResize, { passive: true }], [window, 'orientationchange', onResize],
      [window, 'blur', onBlur], [window, 'focus', onFocus], [document, 'visibilitychange', onVisibility]];
    BIND.forEach(function (b) { b[0].addEventListener(b[1], b[2], b[3]); });
    resetRun(false);
    // The car launches by itself 1.9 s after load, so a new player is moving before they
    // have finished reading the title card. Any key, tap or pad press gets there sooner.
    launchTimer = setTimeout(function () {
      launchTimer = 0;
      if (!destroyed && state === 'ready') act();
    }, 1900);
    rafId = requestAnimationFrame(frame);
    return {
      destroy: function () {
        if (destroyed) return;
        destroyed = true; cancelAnimationFrame(rafId);
        if (launchTimer) { clearTimeout(launchTimer); launchTimer = 0; }
        if (settleRaf) { cancelAnimationFrame(settleRaf); settleRaf = 0; }
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
    name: 'Apex Velocity',
    instructions:
      'Hold GAS (UP or W) to drive and BRAKE (DOWN or S) to slow; LEFT/RIGHT (or A/D) steer. ' +
      'The car launches by itself a moment after the page loads, so you are moving straight away. ' +
      'A light assist keeps it tracking the road, so you can throttle and steer by feel; brake for ' +
      'the magenta chevron markers to clip them for +120 each. Going off is survivable — the runoff ' +
      'is slow but the car steers itself back on. Win by finishing 3 laps: every lap is +600, every ' +
      'chevron clipped at speed is +120, and beating your ghost line is +2500. Touch: the GAS and ' +
      'BRK pads sit bottom-right, the < and > steer pads bottom-left.',
    start: start
  };
})();
