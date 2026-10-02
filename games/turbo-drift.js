/**
 * PIXEL RUSH — games/turbo-drift.js — "Turbo Drift"
 * Contract (GAME-CONTRACT.md): window.PixelGame = { name, instructions, start(root, api) }
 * where api = { setScore(n), setBest(n), gameOver(score) } and start() returns { destroy() }.
 * Self-contained: no imports, no deps, no assets. One <canvas> + 2D ctx, one rAF loop,
 * and every rAF id / listener created in start() is torn down in destroy().
 *
 * Pseudo-3D: a flat road projected through a pinhole camera. Depth d (world units ahead of
 * the camera) maps with scale = CAM_DEPTH/d, so the road converges on the horizon at h/2.
 * Corners are a constant-radius bend, so the lateral road shift has a closed form:
 * shift(d) = curve * (0.048*d + 3.5e-5*d*d) — no per-segment accumulation needed.
 */
(function () {
  'use strict';
  /* -------------------------------- Tuning -------------------------------- */
  var STORE_KEY = 'pixelrush.turbo-drift.best';
  var SEG = 200, DRAW = 100, NEARZ = 40;   // road segment, segments drawn, closest depth
  var EDGE_PAD = 6;                        // px kept clear between the car body and the stage edge
  var FAR = SEG * DRAW;                    // draw distance in world units
  var CAM_D = 1000, CAM_H = 1000, CAM_DEPTH = 0.8391; // player depth, camera height, 1/tan(50deg)
  var LANE_W = 620, ROAD_HALF = 1.5, OFFROAD = 1.62; // lane width, half-road, shoulder start (lane units)
  var CAR_W = 0.84, VX_MAX = 2.2;          // car width, lateral speed cap (lane units/s)
  var SPEED0 = 3000, SPEED_MAX = 9800, RAMP_DIST = 90000, TRAFFIC_DIST = 70000;
  var SPAWN_AHEAD = 11000, SCORE_PER_UNIT = 0.013, MULT_MAX = 6, NEAR_MISS = 30;
  var PAD_R = 0.13, DRAG_SPAN = 0.22;      // touch pad radius, drag span for full lock (fractions)
  var STYLES = '.td{position:relative;width:100%;height:100%;overflow:hidden;touch-action:none;' +
    'user-select:none;-webkit-tap-highlight-color:transparent;' +
    'font-family:var(--font-body,"Rajdhani",system-ui,sans-serif);color:var(--ink,#f2f5ff)}' +
    '.td canvas{display:block;width:100%;height:100%;outline:none}';
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function randInt(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
  function readBest() {
    try { var v = parseInt(window.localStorage.getItem(STORE_KEY), 10);
      return isFinite(v) && v > 0 ? v : null; } catch (e) { return null; } // private mode
  }
  function writeBest(v) { try { window.localStorage.setItem(STORE_KEY, String(v)); } catch (e) { /* ignore */ } }
  /** Endless, deterministic, continuous curvature — the sum never kinks at a segment edge. */
  function curveRaw(i) {
    return 1.7 * Math.sin(i / 48) + 0.9 * Math.sin(i / 17.3 + 1.1) + 0.5 * Math.sin(i / 6.1 + 2.3);
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
    var wrap = document.createElement('div'); wrap.className = 'td';
    var canvas = document.createElement('canvas');
    canvas.setAttribute('tabindex', '0'); canvas.setAttribute('role', 'application');
    canvas.setAttribute('aria-label', 'Turbo Drift road. Arrow keys or A and D to steer, S to brake, ' +
      'space to pause. Drag left or right to steer on touch.');
    var live = document.createElement('div'); // screen-reader announcements
    live.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0)';
    live.setAttribute('aria-live', 'polite');
    var styleTag = document.createElement('style'); styleTag.textContent = STYLES;
    wrap.appendChild(canvas); wrap.appendChild(live); wrap.appendChild(styleTag); root.appendChild(wrap);
    var ctx = canvas.getContext('2d');
    if (!ctx) { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); return { destroy: function () {} }; }
    var rafId = 0, destroyed = false, reduced = false;
    /** Honours window.PX.reduced, the site's motion toggle, and the OS setting. */
    function motionOff() {
      var PX = window.PX;
      var mm = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      reduced = mm || !!(PX && (PX.reduced === true || PX.motionOn === false));
    }
    motionOff();
    /* ----------------------------- Run state ----------------------------- */
    var position = 0, playerX = 0, vx = 0, speed = SPEED0, slow = 1, brake = false;
    var curveNow = 0, score = 0, mult = 1, lives = 3, level = 0, lastWrite = 0;
    var cars = [], pops = [], shake = 0, invuln = 0;
    var bestEver = readBest(), isRecord = false;
    var paused = false, over = false;
    var keyDir = 0, padDir = 0, dragDir = 0, dragging = false, dragX = 0;
    /** The shell's HUD STATUS column has no idea what the game is doing unless we say so. */
    function syncStatus() { setStatus(over ? 'Game over' : (paused ? 'Paused' : 'Playing')); }
    /* ----------------- Sizing (crisp devicePixelRatio) ----------------- */
    var dpr = 1, cssW = 1, cssH = 1;
    /* Paint that does not move between frames is rendered once into an offscreen layer
       and blitted: the backdrop (sky, horizon band, horizon line, ground, grid) and the
       CRT pass (scanlines + vignette). Both were full-screen gradient/pattern fills every
       frame, and on a software rasteriser the per-pixel gradient maths is what costs, not
       the copy. The six road gradients carry the depth fog as a vertical ramp (see
       buildCaches), which is what lets the road batch into six fills instead of four path
       operations per segment. */
    var cachesReady = false, backdrop = {}, crt = {}, crtReduced = null, pads = {};
    var gradTarmacA = null, gradTarmacB = null, gradRumbleA = null, gradRumbleB = null;
    var gradLane = null, gradEdge = null;
    function resize() {
      var r = wrap.getBoundingClientRect();
      cssW = Math.max(1, Math.round(r.width)); cssH = Math.max(1, Math.round(r.height));
      dpr = clamp(window.devicePixelRatio || 1, 1, 2); // contract: cap DPR at 2
      canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
      canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (cachesReady) buildCaches();
    }
    resize();
    // The shell pins the canvas to 100% of the stage, so the stage can change size without
    // any window resize event (panel wrapping, font load, rotating the phone). Watching the
    // wrapper keeps cssW/cssH honest — stale values made the game lay text out against a
    // stage that no longer existed.
    var ro = (typeof ResizeObserver === 'function') ? new ResizeObserver(function () { if (!destroyed) resize(); }) : null;
    if (ro) ro.observe(wrap);
    function token(n, fb) {
      var v = getComputedStyle(document.documentElement).getPropertyValue(n);
      return (v && v.trim()) || fb;
    }
    var C = { bg: token('--bg', '#05060f'), ink: token('--ink', '#f2f5ff'), dim: token('--ink-dim', '#a7b0d0'),
      cyan: token('--cyan', '#22e7ff'), magenta: token('--magenta', '#ff2fb9'), acid: token('--acid', '#c8ff2e'),
      orange: token('--orange', '#ff8a3d'), violet: token('--violet', '#8b5cf6') };
    var CAR_COLS = [C.cyan, C.magenta, C.orange, C.violet, C.acid];
    function hexA(hex, a) {
      hex = (hex || '#fff').trim().replace('#', '');
      var n = parseInt(hex, 16);
      return isFinite(n) ? 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')' : 'rgba(255,255,255,' + a + ')';
    }
    /* ------------------------- Cached paint (resize) ------------------------- */
    /** Offscreen layer sized to the canvas backing store, so a blit is a straight 1:1 copy. */
    function layer(store) {
      if (!store.c) { store.c = document.createElement('canvas'); store.g = store.c.getContext('2d'); }
      store.c.width = canvas.width; store.c.height = canvas.height;
      store.g.setTransform(dpr, 0, 0, dpr, 0, 0);
      store.g.clearRect(0, 0, cssW, cssH);
      return store.g;
    }
    /**
     * The depth fog used to be a per-segment constant: every band built its own rgba()
     * string from the fog at its far edge. Fog is a pure function of the projected y
     * (fog = (K/(y-hz) - NEARZ)/FAR, because project() maps depth to y = hz + K/d), so the
     * same fade is a vertical gradient. Sampling it geometrically in y puts the stops
     * where the curve bends, and the same ramp serves every road surface because each one
     * is affine in fog: alpha = ka - kb*fog.
     */
    function buildCaches() {
      var w = cssW, h = cssH, hz = h * 0.5, i;
      var K = CAM_DEPTH * CAM_H * h / 2, y1 = h + 8, N = 24, g = 1.28;
      var gN = Math.pow(g, N), ramp = [];
      for (var j = 0; j <= N; j++) {
        var t = (Math.pow(g, j) - 1) / (gN - 1);
        ramp.push(clamp((t <= 0 ? FAR : K / (t * (y1 - hz)) - NEARZ) / FAR, 0, 1));
      }
      function roadGrad(colHex, ka, kb) {
        var gr = ctx.createLinearGradient(0, hz, 0, y1);
        for (j = 0; j <= N; j++) gr.addColorStop((Math.pow(g, j) - 1) / (gN - 1), hexA(colHex, ka - kb * ramp[j]));
        return gr;
      }
      gradTarmacA = roadGrad('#101228', 1, 0.92); gradTarmacB = roadGrad('#0c0e1e', 1, 0.92);
      gradRumbleA = roadGrad(C.magenta, 0.5, 0.5); gradRumbleB = roadGrad(C.ink, 0.5, 0.5);
      gradLane = roadGrad(C.acid, 0.55, 0.55); gradEdge = roadGrad(C.cyan, 0.85, 0.8);

      // Backdrop: nothing in it moves — the sun is painted on top of it every frame. The
      // glowing horizon line is left out: it has to sit over the sun.
      var b = layer(backdrop);
      var sky = b.createLinearGradient(0, 0, 0, hz);
      sky.addColorStop(0, hexA(C.violet, 0.55)); sky.addColorStop(0.45, C.magenta);
      sky.addColorStop(0.8, C.orange); sky.addColorStop(1, hexA(C.orange, 0.9));
      b.fillStyle = sky; b.fillRect(-20, -20, w + 40, hz + 20);
      b.fillStyle = C.bg; b.fillRect(-20, hz - h * 0.012, w + 40, h * 0.05);
      var gnd = b.createLinearGradient(0, hz, 0, h);
      gnd.addColorStop(0, '#0a0a1c'); gnd.addColorStop(1, C.bg);
      b.fillStyle = gnd; b.fillRect(-20, hz, w + 40, h - hz + 20);
      b.strokeStyle = hexA(C.violet, 0.35); b.lineWidth = 1; b.beginPath();
      for (i = -7; i <= 7; i++) { b.moveTo(w / 2 + i * w * 0.06, hz); b.lineTo(w / 2 + i * w * 0.9, h); }
      b.stroke();
      buildCrt();
      buildPads();
    }
    /**
     * CRT pass: scanlines then vignette, pre-composited into one layer. Both are black at
     * varying alpha, so stacking them is a single multiply — compositing them here gives the
     * same result as two full-screen fills and costs one blit. The vignette is painted even
     * when motion is reduced; only the scanlines are conditional, so the layer is rebuilt
     * when the flag flips.
     */
    function buildCrt() {
      var w = cssW, h = cssH;
      var c = layer(crt);
      if (!reduced) {
        c.fillStyle = 'rgba(0,0,0,.16)';
        for (var sy = 0; sy < h; sy += 3) c.fillRect(0, sy, w, 1);
      }
      var vig = c.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.34, w / 2, h / 2, Math.max(w, h) * 0.78);
      vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(0,0,0,.6)');
      c.fillStyle = vig; c.fillRect(-20, -20, w + 40, h + 40);
      crtReduced = reduced;
    }
    cachesReady = true; buildCaches();
    /**
     * One steering pad. The car can steer right under a pad, so the pad gets an opaque
     * backing disc: the control has to stay readable even with a 200 px wide sprite
     * underneath it.
     */
    function padShape(g, pxx, dirn, pr, pcy) {
      g.beginPath();
      g.moveTo(pxx + dirn * pr * 0.34, pcy); g.lineTo(pxx - dirn * pr * 0.16, pcy - pr * 0.36);
      g.lineTo(pxx - dirn * pr * 0.16, pcy + pr * 0.36); g.closePath();
    }
    function paintPad(pxx, dirn, pr, pcy, on) {
      ctx.globalAlpha = 0.72; ctx.fillStyle = C.bg;
      ctx.beginPath(); ctx.arc(pxx, pcy, pr, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = on ? 0.55 : 0.22; ctx.fillStyle = C.cyan;
      ctx.shadowColor = C.cyan; ctx.shadowBlur = on ? 18 : 0;
      ctx.beginPath(); ctx.arc(pxx, pcy, pr, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0; ctx.globalAlpha = 1; ctx.fillStyle = C.ink;
      padShape(ctx, pxx, dirn, pr, pcy); ctx.fill();
    }
    /**
     * The idle pads, baked into a layer only as big as the strip they occupy — a
     * full-canvas copy of an otherwise empty layer would cost both memory and several
     * hundred thousand wasted pixels a frame.
     */
    function buildPads() {
      var pr = Math.min(cssW, cssH) * PAD_R, pcy = cssH - pr * 1.15;
      var x0 = Math.max(0, Math.floor((pr * 0.15) * dpr) - 2);
      var y0 = Math.max(0, Math.floor((pcy - pr) * dpr) - 2);
      var x1 = Math.min(canvas.width, Math.ceil((cssW - pr * 0.15) * dpr) + 2);
      var y1 = Math.min(canvas.height, Math.ceil((pcy + pr) * dpr) + 2);
      if (!pads.c) { pads.c = document.createElement('canvas'); pads.g = pads.c.getContext('2d'); }
      pads.c.width = Math.max(1, x1 - x0); pads.c.height = Math.max(1, y1 - y0);
      pads.at = [x0, y0];
      var g = pads.g;
      g.setTransform(dpr, 0, 0, dpr, -x0, -y0);       // draw in stage coordinates
      g.clearRect(0, 0, cssW, cssH);
      for (var i = 0; i < 2; i++) {
        var pxx = i === 0 ? pr * 1.15 : cssW - pr * 1.15, dirn = i === 0 ? -1 : 1;
        g.globalAlpha = 0.72; g.fillStyle = C.bg;
        g.beginPath(); g.arc(pxx, pcy, pr, 0, Math.PI * 2); g.fill();
        g.globalAlpha = 0.22; g.fillStyle = C.cyan;
        g.beginPath(); g.arc(pxx, pcy, pr, 0, Math.PI * 2); g.fill();
        g.globalAlpha = 1; g.fillStyle = C.ink;
        padShape(g, pxx, dirn, pr, pcy); g.fill();
      }
      g.globalAlpha = 1;
    }
    function rr(x, y, w, h, r) { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h); }
    /**
     * On-canvas text is sized from min(cssH, cssW): the stage is 16/9 on a desktop but
     * taller than it is wide on a portrait phone, and a height-only scale makes the strings
     * run off both edges. `fit` then trims the last few px so a string that is still too
     * long at the smallest permitted size is shrunk rather than clipped.
     * Note the loop this replaces re-measured at the *starting* font size every pass (the
     * caller only assigns ctx.font once, with the result), so the width it tested never
     * changed and the function could only ever return the starting size or the 9px floor.
     * That is preserved exactly here, with one measureText instead of one per pixel tried.
     * @param {number} px starting size @param {string} s text @param {number} maxW
     */
    function fit(px, s, maxW) {
      return (px > 9 && ctx.measureText(s).width > maxW) ? 9 : Math.round(px);
    }
    /* One memo per HUD string: the best-score and level readouts rarely change, and
       measureText (which shapes the string) was costing more than the text it sized. */
    var fitMemo = ['', 0, 0, 0, '', 0, 0, 0, '', 0, 0, 0, '', 0, 0, 0];
    function fitAt(k, px, s, maxW) {
      var o = k * 4;
      if (fitMemo[o] === px && fitMemo[o + 1] === s && fitMemo[o + 2] === maxW) return fitMemo[o + 3];
      var r = fit(px, s, maxW);
      fitMemo[o] = px; fitMemo[o + 1] = s; fitMemo[o + 2] = maxW; fitMemo[o + 3] = r;
      return r;
    }
    /* ------------------------- Projection helpers ------------------------ */
    function camZ() { return position + CAM_D; }
    function shiftAt(d) { return curveNow * (0.048 * d + 3.5e-5 * d * d); } // constant-radius bend
    /** World point (x across, depth d) -> screen. Writes into `out` to avoid per-frame garbage. */
    function project(x, d, out) {
      var s = CAM_DEPTH / d;
      out.s = s;
      out.x = cssW / 2 + ((x - shiftAt(d)) * s) * cssW / 2;
      out.y = cssH / 2 + (s * CAM_H) * cssH / 2;
      out.w = (LANE_W * ROAD_HALF * 2 * s) * cssW / 2;
      return out;
    }
    var pA = { x: 0, y: 0, w: 0, s: 0 }, pB = { x: 0, y: 0, w: 0, s: 0 }, pC = { x: 0, y: 0, w: 0, s: 0 };
    /* Scratch for the batched road: 16 floats a band, reused every frame so the draw pass
       allocates nothing. BAND_MAX bounds the walk at the segment cap. */
    var BAND_MAX = DRAW + 2, band = new Float32Array(BAND_MAX * 16);
    /**
     * Lane offsets at which the car body still fits between the two stage edges, as a
     * signed [lo, hi] pair. The road is drawn relative to the corner shift, so the usable
     * range moves with the bend: a lane offset that fits on a straight can put the sprite
     * past the canvas border mid-corner, which is what clipped the car into the corner.
     */
    function laneLimits() {
      var f = (CAM_DEPTH / CAM_D) * cssW / 2;                       // world units -> css px
      var half = (cssW * 0.5 - EDGE_PAD - CAR_W * LANE_W * f * 0.5) / f;
      // project() puts the sprite at (playerX*LANE_W - shiftAt(CAM_D)) * f from the stage
      // centre, so the *shifted* road is the one with room: the limits add the corner
      // shift, they do not subtract it.
      var sh = shiftAt(CAM_D);
      var lo = Math.max(-ROAD_HALF, (sh - half) / LANE_W);
      var hi = Math.min(ROAD_HALF, (sh + half) / LANE_W);
      if (lo > hi) { var mid = (lo + hi) / 2; lo = hi = mid; }      // stage too narrow: pin to the middle
      return [lo, hi];
    }
    /* ---------------------------- Game logic ---------------------------- */
    function speedTarget() { var t = clamp(position / RAMP_DIST, 0, 1); return lerp(SPEED0, SPEED_MAX, t * t * 0.55 + t * 0.45); }
    function spawnAhead() {
      var t = clamp(position / TRAFFIC_DIST, 0, 1);
      var last = cars[cars.length - 1], lanes = [-1, 0, 1];
      if (last && Math.random() < 0.72) lanes = [-1, 0, 1].filter(function (l) { return l !== last.lane; });
      cars.push({
        z: (last ? last.z + lerp(3400, 1050, t) * rand(0.75, 1.35) : position + SPAWN_AHEAD),
        lane: lanes[randInt(0, lanes.length - 1)], spd: speed * rand(0.30, 0.70),
        col: CAR_COLS[randInt(0, CAR_COLS.length - 1)], hit: false, passed: false, off: 0
      });
    }
    function pop(text, color) { pops.push({ text: text, color: color, t: 0 }); if (pops.length > 6) pops.shift(); }
    function resetRun() {
      position = 0; playerX = 0; vx = 0; speed = SPEED0; slow = 1; brake = false;
      curveNow = 0; score = 0; mult = 1; lives = 3; level = 0;
      cars.length = 0; pops.length = 0; shake = 0; invuln = 0;
      isRecord = false; over = false; paused = false;
      keyDir = 0; padDir = 0; dragDir = 0; dragging = false;
      setScore(0);
      if (bestEver !== null) setBest(Math.floor(bestEver));
      syncStatus();
      live.textContent = 'New run. Score 0. Three lives.';
    }
    function die() {
      if (over || destroyed) return;      // api.gameOver() may only fire once per run
      over = true; paused = false;
      syncStatus();
      if (isRecord) writeBest(Math.floor(score));
      live.textContent = 'Out of lives. Final score ' + Math.floor(score) + '.';
      gameOverCb(Math.floor(score));
    }
    function crash(car) {
      if (invuln > 0 || over) return;
      car.hit = true; car.off = 2.4;      // shunted aside, and gone for good
      lives--; shake = 1; invuln = 1.5; slow = 0.45;
      pop('CRASH!', C.magenta);
      live.textContent = 'Crash. ' + lives + ' lives left.';
      if (lives <= 0) die();
    }
    function update(dt, now) {
      var i, car, d;
      var seg = Math.floor(position / SEG);   // smoothed curvature around the player
      curveNow += ((curveRaw(seg - 2) + curveRaw(seg - 1) + curveRaw(seg) + curveRaw(seg + 1) +
        curveRaw(seg + 2)) / 5 - curveNow) * Math.min(1, dt * 3.5);
      var want = speedTarget() * slow;        // longitudinal: ramp, brake, shoulder drag
      if (brake) want *= 0.45;
      if (Math.abs(playerX) > OFFROAD) want = Math.min(want, 3600);
      speed += (want - speed) * Math.min(1, dt * 1.6);
      slow = Math.min(1, slow + dt * 0.55);
      position += speed * dt;
      // lateral: input -> velocity, then centrifugal push out of the corner
      var input = clamp(keyDir + padDir + dragDir, -1, 1);
      vx += (input * VX_MAX - vx) * Math.min(1, dt * (input === 0 ? 20 : 12)); // coasts back to centre
      vx += Math.sign(curveNow) * Math.abs(curveNow) * 1.9 * dt * (speed / SPEED_MAX);
      playerX += vx * dt;
      // The car may not leave the drawn road (ROAD_HALF), and a corner shift narrows that
      // range further so the sprite is never clipped by the stage edge or hidden behind a pad.
      var lims = laneLimits();
      if (playerX < lims[0] || playerX > lims[1]) {
        playerX = clamp(playerX, lims[0], lims[1]);
        vx *= -0.25; shake = Math.max(shake, 0.35);
      }
      // drift multiplier: heat needs a real corner AND commitment to the inside line
      var aggr = clamp(Math.abs(vx) / VX_MAX, 0, 1);
      var inside = clamp(-Math.sign(curveNow) * (playerX / ROAD_HALF), 0, 1);
      var heat = clamp(Math.abs(curveNow) / 2.6, 0, 1) * (0.4 + 0.6 * aggr) * (0.55 + 0.45 * inside);
      if (heat > 0.18) mult = Math.min(MULT_MAX, mult + (heat - 0.18) * 2.8 * dt);
      else mult = Math.max(1, mult - 0.6 * dt);
      score += speed * dt * SCORE_PER_UNIT * mult;
      setScore(Math.floor(score));
      level = Math.floor(position / 6000);
      if (score > (bestEver || 0)) {        // throttle the storage write to ~1/s
        bestEver = score; isRecord = true; setBest(Math.floor(score));
        if (now - lastWrite > 900) { writeBest(Math.floor(score)); lastWrite = now; }
      }
      for (i = cars.length - 1; i >= 0; i--) {   // traffic
        car = cars[i];
        car.z += car.spd * dt; car.off *= Math.pow(0.2, dt);
        d = car.z - camZ();
        if (d < -600) { cars.splice(i, 1); continue; }
        if (car.hit || car.passed || d > CAM_D) continue;
        car.passed = true;
        var gap = Math.abs((car.lane - playerX) * LANE_W);
        if (gap < CAR_W * LANE_W) crash(car);
        else if (gap < CAR_W * LANE_W * 1.15) {  // only a genuinely tight pass pays
          score += NEAR_MISS * mult; pop('NEAR MISS +' + Math.floor(NEAR_MISS * mult), C.acid);
        }
      }
      if (!cars.length) spawnAhead();
      while (cars[cars.length - 1].z < position + SPAWN_AHEAD) spawnAhead();
      if (shake > 0) shake = Math.max(0, shake - dt * 2.4);
      if (invuln > 0) invuln -= dt;
      for (i = pops.length - 1; i >= 0; i--) { pops[i].t += dt; if (pops[i].t > 0.9) pops.splice(i, 1); }
    }
    /* ------------------------------ Render ------------------------------ */
    function draw(now) {
      var w = cssW, h = cssH, hz = h * 0.5, i, n, car;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.save();
      var shx = 0, shy = 0;
      if (!reduced && shake > 0) { shx = rand(-1, 1) * shake * 14; shy = rand(-1, 1) * shake * 14; ctx.translate(shx, shy); }
      /* sky, horizon and ground are one cached layer; only the sun moves, so it is the
         only thing painted on top of it. The blit runs in device space so it is a 1:1
         copy — drawImage under the DPR transform would rescale by a rounding error. */
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (shx || shy) ctx.translate(shx * dpr, shy * dpr);
      ctx.drawImage(backdrop.c, 0, 0);
      ctx.restore();
      /* Slatted synthwave sun. The old order was sky, horizon band, sun, horizon line,
         ground, grid — the opaque ground fill then hid everything the sun, its glow and
         the lower half of the horizon line put below the horizon. The ground now lives in
         the cached backdrop, so the same occlusion is one clip whose bottom edge is hz. */
      var sunR = Math.min(w, h) * 0.19, sunX = w / 2 - curveNow * Math.min(w, h) * 0.02, sunY = hz - sunR * 0.42;
      ctx.save();
      ctx.beginPath(); ctx.rect(-20, -20, w + 40, hz + 20); ctx.clip();
      ctx.fillStyle = hexA(C.bg, 0.85);
      ctx.save(); ctx.shadowColor = C.magenta; ctx.shadowBlur = 30; ctx.fillStyle = C.acid;
      ctx.beginPath(); ctx.arc(sunX, sunY, sunR, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      for (i = 0; i < 7; i++) ctx.fillRect(sunX - sunR, sunY + i * sunR * 0.19, sunR * 2, sunR * 0.075);
      ctx.strokeStyle = hexA(C.cyan, 0.5); ctx.lineWidth = 1;   // glowing horizon line
      ctx.beginPath(); ctx.moveTo(-20, hz); ctx.lineTo(w + 20, hz); ctx.stroke();
      ctx.restore();
      /* Road strips, far to near. Every band used to open its own path for the tarmac, the
         glowing edges, the rumble and the lane dividers — about four beginPath a segment,
         plus a fresh rgba() string and a shadowed stroke. The road is now walked once into
         a flat band buffer and replayed as six batched paths, and the depth fog rides on
         cached vertical gradients instead of per-band constants, so a band costs a few
         numbers to gather and the whole road costs six fills.
         The edges and the lane dashes are emitted as quads offset along their own line
         normal, which is exactly the footprint of the old butt-capped stroke at that line
         width. Width mattered: the old edge stroke inherited the *previous* band's lane
         lineWidth (edgeH below) and so fattened as the road came toward the camera. Each
         of the four lines has its own normal — left and right diverge because the road
         fans out — so the buffer carries one per line. */
      var base = Math.floor(position / SEG), drawnY = 0, bottomY = h, bands = 0;
      var laneH = 0.5, edgeH = 0.5, sxd, swd, syd, len;
      for (n = DRAW; n >= 0 && bands < BAND_MAX; n--) {
        var idx = base + n, zf = (idx + 1) * SEG - camZ(), zn = (idx + 2) * SEG - camZ();
        if (zf > FAR || zn < NEARZ) continue;
        project(0, clamp(zf, NEARZ, FAR), pA); project(0, clamp(zn, NEARZ, FAR), pB);
        if (pA.y <= drawnY) continue;                    // already covered by a nearer strip
        var even = (n % 2) === 0;
        sxd = pB.x - pA.x; swd = pB.w - pA.w; syd = pB.y - pA.y;
        var o = bands * 16;
        band[o] = pA.x; band[o + 1] = pA.y; band[o + 2] = pA.w;
        band[o + 3] = pB.x; band[o + 4] = pB.y; band[o + 5] = pB.w;
        // left/right road edge normals (at +-p.w), already scaled to the stroke half width
        len = Math.sqrt((sxd - swd) * (sxd - swd) + syd * syd) || 1;
        band[o + 12] = -syd / len * edgeH; band[o + 13] = (sxd - swd) / len * edgeH;
        len = Math.sqrt((sxd + swd) * (sxd + swd) + syd * syd) || 1;
        band[o + 14] = -syd / len * edgeH; band[o + 15] = (sxd + swd) / len * edgeH;
        band[o + 7] = (Math.floor(idx / 3) % 2) === 0 ? 1 : 0;
        if (even) {                                        // lane dividers, dashed by parity
          var t3 = swd / 1.5;                               // the lane sits at +-p.w/1.5
          laneH = Math.max(1, pA.w * 0.02) * 0.5;
          len = Math.sqrt((sxd - t3) * (sxd - t3) + syd * syd) || 1;
          band[o + 8] = -syd / len; band[o + 9] = (sxd - t3) / len;
          len = Math.sqrt((sxd + t3) * (sxd + t3) + syd * syd) || 1;
          band[o + 10] = -syd / len; band[o + 11] = (sxd + t3) / len;
          band[o + 6] = laneH;
          band[o + 7] += 2;
        }
        bands++;
        edgeH = laneH;                                    // the old edge stroke used this width
        drawnY = pA.y; bottomY = pB.y;
      }
      /* Paint order matters and is the original one: tarmac, then the glowing edges, then
         the rumble strips (which cover the inner half of an edge), then the lane dividers.
         Two shades of tarmac and two rumble colours, one batched path each: pass 0/1 walk
         the odd/even tarmac bands, pass 2/3 the odd/even rumble ones. */
      for (var pass = 0; pass < 4; pass += 2) {
        var altOn = (pass & 1) === 0;
        ctx.fillStyle = altOn ? gradTarmacA : gradTarmacB;
        ctx.beginPath();
        for (i = 0; i < bands; i++) {
          var b = i * 16;
          if (altOn ? !(band[b + 7] & 1) : (band[b + 7] & 1)) continue;
          var ax = band[b], ay = band[b + 1], aw = band[b + 2];
          var bxx = band[b + 3], byy = band[b + 4], bw = band[b + 5];
          ctx.moveTo(ax - aw, ay); ctx.lineTo(ax + aw, ay);
          ctx.lineTo(bxx + bw, byy); ctx.lineTo(bxx - bw, byy);
        }
        ctx.fill();
      }
      if (!reduced) {                                     // glowing road edges, one shadow pass
        ctx.fillStyle = gradEdge;
        ctx.shadowColor = C.cyan; ctx.shadowBlur = 10;
        ctx.beginPath();
        for (i = 0; i < bands; i++) {
          var eb = i * 16;
          var fx = band[eb], fy = band[eb + 1], fw = band[eb + 2];
          var gx = band[eb + 3], gy = band[eb + 4], gw = band[eb + 5];
          var ex = band[eb + 12], ey = band[eb + 13];
          ctx.moveTo(fx - fw + ex, fy + ey); ctx.lineTo(gx - gw + ex, gy + ey);
          ctx.lineTo(gx - gw - ex, gy - ey); ctx.lineTo(fx - fw - ex, fy - ey);
          ex = band[eb + 14]; ey = band[eb + 15];
          ctx.moveTo(fx + fw + ex, fy + ey); ctx.lineTo(gx + gw + ex, gy + ey);
          ctx.lineTo(gx + gw - ex, gy - ey); ctx.lineTo(fx + fw - ex, fy - ey);
        }
        ctx.fill(); ctx.shadowBlur = 0;
      }
      for (var rpass = 2; rpass < 4; rpass++) {            // rumble strips, 13% proud of the edge
        var rAlt = (rpass & 1) === 0;
        ctx.fillStyle = rAlt ? gradRumbleA : gradRumbleB;
        ctx.beginPath();
        for (i = 0; i < bands; i++) {
          var rb = i * 16;
          if (rAlt ? !(band[rb + 7] & 1) : (band[rb + 7] & 1)) continue;
          var rx = band[rb], ry = band[rb + 1], rw = band[rb + 2];
          var sx = band[rb + 3], sy = band[rb + 4], sw = band[rb + 5];
          ctx.moveTo(rx - rw * 1.13, ry); ctx.lineTo(rx - rw, ry);
          ctx.lineTo(sx - sw, sy); ctx.lineTo(sx - sw * 1.13, sy);
          ctx.moveTo(rx + rw * 1.13, ry); ctx.lineTo(rx + rw, ry);
          ctx.lineTo(sx + sw, sy); ctx.lineTo(sx + sw * 1.13, sy);
        }
        ctx.fill();
      }
      ctx.fillStyle = gradLane; ctx.beginPath();          // lane dividers
      for (i = 0; i < bands; i++) {
        var lb = i * 16;
        if (!(band[lb + 7] & 2)) continue;
        var lh = band[lb + 6], q;
        for (q = -1; q <= 1; q += 2) {
          var jx = band[lb + 8 + (q < 0 ? 0 : 2)] * lh, jy = band[lb + 9 + (q < 0 ? 0 : 2)] * lh;
          var lx = band[lb] + band[lb + 2] * (q / 1.5), ly = band[lb + 1];
          var mx = band[lb + 3] + band[lb + 5] * (q / 1.5), my = band[lb + 4];
          ctx.moveTo(lx + jx, ly + jy); ctx.lineTo(mx + jx, my + jy);
          ctx.lineTo(mx - jx, my - jy); ctx.lineTo(lx - jx, ly - jy);
        }
      }
      ctx.fill();
      ctx.fillStyle = '#0c0e1e'; ctx.fillRect(-20, bottomY, w + 40, h - bottomY + 20);
      /* traffic, far to near */
      for (i = cars.length - 1; i >= 0; i--) {
        car = cars[i];
        var d = car.z - camZ();
        if (d < NEARZ || d > FAR) continue;
        project((car.lane + car.off) * LANE_W, d, pC);
        var cw = CAR_W * LANE_W * pC.s * w / 2, ch = cw * 0.62;
        if (cw < 1) continue;
        ctx.save();
        ctx.globalAlpha = 1 - clamp((d - NEARZ) / FAR, 0, 1) * 0.85;
        ctx.shadowColor = car.col; ctx.shadowBlur = reduced ? 4 : 14;
        ctx.fillStyle = car.hit ? hexA(C.dim, 0.5) : car.col;
        rr(pC.x - cw / 2, pC.y - ch, cw, ch, cw * 0.18); ctx.fill(); ctx.shadowBlur = 0;
        ctx.fillStyle = 'rgba(4,4,12,.72)';               // windscreen
        rr(pC.x - cw * 0.34, pC.y - ch * 0.82, cw * 0.68, ch * 0.34, cw * 0.1); ctx.fill();
        ctx.fillStyle = car.hit ? hexA(C.dim, 0.4) : hexA(C.bg, 0.9);  // wheels
        ctx.beginPath();
        ctx.rect(pC.x - cw * 0.6, pC.y - ch * 0.34, cw * 0.14, ch * 0.34);
        ctx.rect(pC.x + cw * 0.46, pC.y - ch * 0.34, cw * 0.14, ch * 0.34);
        ctx.fill();
        if (!car.hit) {                                   // tail lights
          ctx.fillStyle = '#ff2b4d';
          ctx.beginPath();
          ctx.rect(pC.x - cw * 0.42, pC.y - ch * 0.2, cw * 0.16, ch * 0.1);
          ctx.rect(pC.x + cw * 0.26, pC.y - ch * 0.2, cw * 0.16, ch * 0.1);
          ctx.fill();
        }
        ctx.restore();
      }
      /* player car */
      project(playerX * LANE_W, CAM_D, pC);
      var pw = CAR_W * LANE_W * pC.s * w / 2, ph = pw * 0.66, py = pC.y + ph * 0.28;
      var blink = invuln > 0 && !reduced && Math.floor(now / 90) % 2 === 0;
      if (Math.abs(playerX) > OFFROAD) py += ph * 0.05;
      ctx.save();
      if (Math.abs(curveNow) > 0.6 && Math.abs(vx) > 0.6 && !reduced) {   // skid marks while sliding
        ctx.strokeStyle = hexA(C.magenta, 0.35); ctx.lineWidth = Math.max(2, pw * 0.06);
        ctx.beginPath();
        ctx.moveTo(pC.x - pw * 0.45, py); ctx.lineTo(pC.x - pw * 0.55, py + ph * 0.5);
        ctx.moveTo(pC.x + pw * 0.45, py); ctx.lineTo(pC.x + pw * 0.55, py + ph * 0.5);
        ctx.stroke();
      }
      ctx.translate(pC.x, py); ctx.rotate(clamp(-vx * 0.12, -0.24, 0.24));
      ctx.globalAlpha = blink ? 0.45 : 1;
      ctx.shadowColor = C.orange; ctx.shadowBlur = reduced ? 5 : 22; ctx.fillStyle = C.orange;
      rr(-pw / 2, -ph * 0.86, pw, ph, pw * 0.2); ctx.fill(); ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(4,4,12,.75)';
      rr(-pw * 0.33, -ph * 0.66, pw * 0.66, ph * 0.32, pw * 0.1); ctx.fill();
      ctx.fillStyle = C.bg;                                // wheels
      ctx.fillRect(-pw * 0.58, -ph * 0.24, pw * 0.16, ph * 0.3);
      ctx.fillRect(pw * 0.42, -ph * 0.24, pw * 0.16, ph * 0.3);
      ctx.fillStyle = mult > 1.05 ? C.acid : '#ff2b4d';    // tail lights brighten with the multiplier
      ctx.fillRect(-pw * 0.44, -ph * 0.2, pw * 0.2, ph * 0.11);
      ctx.fillRect(pw * 0.24, -ph * 0.2, pw * 0.2, ph * 0.11);
      ctx.restore();
      /* floaters (near miss, crash) */
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      var popPx = Math.round(clamp(Math.min(h * 0.045, w * 0.05), 11, 22));
      for (i = 0; i < pops.length; i++) {
        var p = pops[i];
        ctx.font = '900 ' + fit(popPx, p.text, w * 0.92) + 'px Orbitron, system-ui, sans-serif';
        ctx.globalAlpha = 1 - p.t / 0.9; ctx.fillStyle = p.color;
        ctx.shadowColor = p.color; ctx.shadowBlur = 12;
        ctx.fillText(p.text, w / 2, h * 0.3 - p.t * h * 0.06);
      }
      ctx.globalAlpha = 1; ctx.shadowBlur = 0;
      /* CRT polish: scanlines + vignette — applied to the WORLD only, before the HUD,
         so the on-canvas readouts and touch pads stay bright and legible. Pre-composited
         into one layer; window.PX.reduced drops the scanlines (not the vignette) and
         rebuilds it. */
      if (crtReduced !== reduced) buildCrt();
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (shx || shy) ctx.translate(shx * dpr, shy * dpr);
      ctx.drawImage(crt.c, 0, 0);
      ctx.restore();
      /* HUD: score, best, level, lives, multiplier, speed — drawn ABOVE the CRT overlay */
      var fs = Math.round(clamp(Math.min(h * 0.05, w * 0.055), 11, 20));
      ctx.fillStyle = 'rgba(5,6,15,.55)';                     // backing plate keeps text off the bright sky
      ctx.fillRect(0, 0, w, fs * 3.8);
      var scTxt = 'SCORE ' + Math.floor(score), beTxt = 'BEST ' + Math.floor(bestEver || 0);
      var kmTxt = Math.round(speed * 0.06) + ' KM/H';
      ctx.font = '800 ' + fs + 'px Rajdhani, system-ui, sans-serif'; ctx.textAlign = 'left';
      ctx.shadowColor = 'rgba(0,0,0,.9)'; ctx.shadowBlur = 4;  // text shadow for extra separation
      ctx.font = '800 ' + fitAt(0, fs, scTxt, w * 0.3) + 'px Rajdhani, system-ui, sans-serif';
      ctx.fillStyle = C.ink; ctx.fillText(scTxt, 12, fs * 1.1);
      ctx.textAlign = 'right'; ctx.fillStyle = C.dim;
      ctx.font = '800 ' + fitAt(1, fs, beTxt, w * 0.3) + 'px Rajdhani, system-ui, sans-serif';
      ctx.fillText(beTxt, w - 12, fs * 1.1);
      ctx.textAlign = 'center'; ctx.fillStyle = Math.abs(curveNow) > 0.8 ? C.acid : C.ink;
      var lvTxt = 'LV ' + level;
      ctx.font = '800 ' + fitAt(2, fs, lvTxt, w * 0.3) + 'px Rajdhani, system-ui, sans-serif';
      ctx.fillText(lvTxt, w / 2, fs * 1.1);
      for (i = 0; i < 3; i++) {                            // lives as pips
        ctx.fillStyle = i < lives ? C.magenta : hexA(C.dim, 0.25);
        rr(12 + i * (fs * 0.85), fs * 2.1, fs * 0.62, fs * 0.42, 3); ctx.fill();
      }
      var mw = Math.min(w * 0.5, 190), mx = w / 2 - mw / 2, my = fs * 2.25;   // drift multiplier bar
      ctx.fillStyle = hexA(C.dim, 0.2); rr(mx, my, mw, fs * 0.5, fs * 0.25); ctx.fill();
      ctx.fillStyle = mult > 1.05 ? C.acid : hexA(C.cyan, 0.6);
      rr(mx, my, mw * ((mult - 1) / (MULT_MAX - 1)), fs * 0.5, fs * 0.25); ctx.fill();
      ctx.font = '800 ' + Math.round(fs * 0.85) + 'px Rajdhani, system-ui, sans-serif';
      ctx.fillStyle = mult > 1.05 ? C.acid : C.ink;
      ctx.fillText('x' + mult.toFixed(1), w / 2, my + fs * 1.05);
      ctx.textAlign = 'right'; ctx.fillStyle = C.ink;
      ctx.font = '800 ' + fitAt(3, fs * 0.85, kmTxt, w * 0.3) + 'px Rajdhani, system-ui, sans-serif';
      ctx.fillText(kmTxt, w - 12, fs * 2.35);
      ctx.shadowBlur = 0;
      /* Touch pads, bottom thumb zone. The pads never move and their idle look never
         changes, so it is baked into a layer on resize and blitted. Note the old test
         `(i === 0 ? padDir : -padDir) !== 0` is true for *both* pads whenever either one is
         held — pressing one lights the pair — and that is kept. */
      var pr = Math.min(w, h) * PAD_R, pcy = h - pr * 1.15;
      if (!padDir) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        if (shx || shy) ctx.translate(shx * dpr, shy * dpr);
        ctx.drawImage(pads.c, pads.at[0], pads.at[1]);   // 1:1, layer is already device-sized
        ctx.restore();
      } else {
        paintPad(pr * 1.15, -1, pr, pcy, true);
        paintPad(w - pr * 1.15, 1, pr, pcy, true);
      }
      ctx.globalAlpha = 1;
      ctx.restore();
      if (paused && !over) card('PAUSED', 'Tap, drag or press a key to resume', C.cyan, null);
      if (over) card('GAME OVER', 'SCORE ' + Math.floor(score) + (isRecord ? '  ·  NEW BEST' : '') +
        '  ·  ' + Math.floor(position / 10) + ' M', C.magenta, 'TAP or press SPACE to play again');
    }
    /** Centred overlay: neon title, sub-copy, optional restart hint. */
    function card(title, sub, color, hint) {
      ctx.fillStyle = hexA(C.bg, 0.7); ctx.fillRect(0, 0, cssW, cssH);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      var tpx = Math.round(clamp(Math.min(cssH * 0.13, cssW * 0.13), 16, 60));
      var spx = Math.round(clamp(Math.min(cssH * 0.05, cssW * 0.055), 10, 22));
      ctx.font = '900 ' + tpx + 'px Orbitron, system-ui, sans-serif';
      ctx.font = '900 ' + fit(tpx, title, cssW * 0.92) + 'px Orbitron, system-ui, sans-serif';
      ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 28;
      ctx.fillText(title, cssW / 2, cssH * 0.4); ctx.shadowBlur = 0;
      ctx.font = '600 ' + spx + 'px Rajdhani, system-ui, sans-serif';
      ctx.fillStyle = C.dim;
      if (fit(spx, sub, cssW * 0.94) < spx) {        // too long for one line: break it in two
        var brk = wrapText(sub);
        ctx.fillText(brk[0], cssW / 2, cssH * 0.47);
        if (brk[1]) ctx.fillText(brk[1], cssW / 2, cssH * 0.53);
      } else {
        ctx.fillText(sub, cssW / 2, cssH * 0.5);
      }
      if (hint) {
        ctx.font = '600 ' + spx + 'px Rajdhani, system-ui, sans-serif';
        ctx.font = '600 ' + fit(spx, hint, cssW * 0.9) + 'px Rajdhani, system-ui, sans-serif';
        ctx.fillText(hint, cssW / 2, cssH * 0.62);
      }
    }
    /** Balance a sub-copy string onto the two most even lines that both fit the stage. */
    function wrapText(s) {
      var words = s.split(' '), maxW = cssW * 0.94, best = null, bestWidest = Infinity;
      for (var i = 1; i < words.length; i++) {
        var a = words.slice(0, i).join(' '), b = words.slice(i).join(' ');
        var wa = ctx.measureText(a).width, wb = ctx.measureText(b).width;
        if (Math.max(wa, wb) > maxW) continue;
        if (Math.max(wa, wb) < bestWidest) { bestWidest = Math.max(wa, wb); best = [a, b]; }
      }
      if (!best) {   // even the shortest word pair is too wide — hard character split
        var half = s.length >> 1;
        best = [s.slice(0, half), s.slice(half)];
      }
      return best;
    }
    /* -------------------------- Single rAF loop -------------------------- */
    var last = 0;
    function frame(now) {
      if (destroyed) return;                 // guard: destroy() can land between frames
      if (!last) last = now;
      var dt = Math.min(100, now - last) / 1000;  // clamp so a hidden tab cannot fast-forward
      last = now;
      if (!paused && !over) update(dt, now);
      if (destroyed) return;                 // the shell may destroy() from inside api.gameOver()
      draw(now);
      rafId = requestAnimationFrame(frame);
    }
    /* ------------------- Input: keyboard + drag + pads ------------------- */
    function padHit(x, y) {                  // which steering pad, if any, is under this point
      var r = Math.min(cssW, cssH) * PAD_R, cy = cssH - r * 1.15;
      if (Math.abs(x - r * 1.15) < r && Math.abs(y - cy) < r) return -1;
      if (Math.abs(x - (cssW - r * 1.15)) < r && Math.abs(y - cy) < r) return 1;
      return 0;
    }
    function local(e) { var r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
    function onKeyDown(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var a = document.activeElement;         // never steal keys from a real control
      if (a && a !== canvas && /^(BUTTON|INPUT|SELECT|TEXTAREA|A|SUMMARY)$/.test(a.tagName)) return;
      if (e.code === 'Space' || e.code === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (over) resetRun(); else { paused = !paused; syncStatus(); }
        return;
      }
      // Steering keys never restart: the on-screen prompt only advertises TAP / SPACE, and
      // silently discarding a finished score by holding Left is a bug, not a feature.
      if (over) return;
      if (e.code === 'ArrowLeft' || e.code === 'KeyA') keyDir = -1;
      else if (e.code === 'ArrowRight' || e.code === 'KeyD') keyDir = 1;
      else if (e.code === 'ArrowDown' || e.code === 'KeyS') brake = true;
      else if (e.code === 'ArrowUp' || e.code === 'KeyW') brake = false;
      else return;
      e.preventDefault();
      if (paused) { paused = false; syncStatus(); }
    }
    function onKeyUp(e) {
      if (e.code === 'ArrowLeft' || e.code === 'KeyA') { if (keyDir === -1) keyDir = 0; }
      else if (e.code === 'ArrowRight' || e.code === 'KeyD') { if (keyDir === 1) keyDir = 0; }
      else if (e.code === 'ArrowDown' || e.code === 'KeyS') brake = false;
    }
    function onPointerDown(e) {
      if (e.button !== undefined && e.button !== 0) return;
      if (over) resetRun(); else if (paused) { paused = false; syncStatus(); }
      var p = local(e), pd = padHit(p.x, p.y);
      if (pd) padDir = pd; else { dragging = true; dragX = p.x; dragDir = 0; }
      if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
      e.preventDefault();
    }
    function onPointerMove(e) {
      if (!dragging) return;
      dragDir = clamp((local(e).x - dragX) / (cssW * DRAG_SPAN), -1, 1);  // hold the drag for full lock
      e.preventDefault();
    }
    function onPointerEnd() { dragging = false; dragDir = 0; padDir = 0; }
    /**
     * The canvas never sees the tap that restarts a phone run: the shell's round-over
     * card is drawn over the stage and its own box takes pointer events, so on a short
     * phone stage the box covers the canvas completely. Honour the prompt the game
     * prints ("TAP or press SPACE to play again") by restarting when the press lands
     * anywhere over the canvas rect, whatever element happens to be on top of it.
     * Real controls (the card's own buttons/links) and anything off-stage are left
     * alone, so the shell's Play again / All games / HUD buttons behave as before.
     */
    function onStageTap(e) {
      if (!over) return;
      var t = e.target;
      if (t && t.closest && t.closest('button, a[href], input, select, textarea')) return;
      var r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return;
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
      resetRun();
    }
    function onResize() { if (!destroyed) resize(); }
    function onBlur() {
      if (destroyed) return;
      paused = true; onPointerEnd(); keyDir = 0; brake = false; syncStatus();
    }
    function onVisibility() { if (document.hidden) onBlur(); }
    function onMotion() { motionOff(); }
    // Every listener the game owns, in one table so teardown cannot miss one.
    var BIND = [[document, 'keydown', onKeyDown], [document, 'keyup', onKeyUp],
      [document, 'pointerdown', onStageTap, { capture: true }],
      [canvas, 'pointerdown', onPointerDown], [canvas, 'pointermove', onPointerMove],
      [canvas, 'pointerup', onPointerEnd], [canvas, 'pointercancel', onPointerEnd],
      [window, 'resize', onResize, { passive: true }], [window, 'orientationchange', onResize],
      [window, 'blur', onBlur], [document, 'visibilitychange', onVisibility],
      [window, 'px:motionchange', onMotion]];
    BIND.forEach(function (b) { b[0].addEventListener(b[1], b[2], b[3]); });
    resetRun(); last = 0; rafId = requestAnimationFrame(frame);
    return {
      destroy: function () {
        if (destroyed) return;               // idempotent
        destroyed = true; cancelAnimationFrame(rafId);
        if (ro) ro.disconnect();
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
    name: 'Turbo Drift',
    instructions:
      'Hold a curve to build the drift multiplier — hug the inside line and slide for up to x6, then ' +
      'let it bleed off when you drive straight. Score comes from distance and near-misses pay a ' +
      'bonus; traffic costs one of three lives. Drag left or right anywhere to steer on touch (or use ' +
      'the on-screen pads), ARROWS / WASD on a keyboard, DOWN to brake. SPACE pauses. Best score is ' +
      'saved on this device.',
    start: start
  };
})();
