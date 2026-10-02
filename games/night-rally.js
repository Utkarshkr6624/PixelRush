/**
 * PIXEL RUSH — games/night-rally.js — "Night Rally"
 * Contract (GAME-CONTRACT.md): window.PixelGame = { name, instructions, start(root, api) }
 * where api = { setScore(n), setBest(n), gameOver(score) } and start() returns { destroy() }.
 * Pseudo-3D road: segments are projected through a camera while a curve accumulator shifts the
 * road laterally (the classic outrun model). The world is drawn flat, then darkened by a single
 * headlight-cone gradient whose outer stop is the full blackout, so nothing outside the beam is
 * visible. The road bands are batched into one path per colour and the far field is drawn at a
 * coarser step; see drawRoad() and buildPaint().
 * Self-contained: no imports, no dependencies, no assets, no audio.
 */
(function () {
  'use strict';
  /* -------------------------------- Tuning -------------------------------- */
  var STORE_KEY = 'pixelrush.night-rally.best';
  var SEG_LEN = 200, SEG_COUNT = 340, DRAW_DIST = 190;  // segment length / ring size / draw range
  var HALF_ROAD = 1000, LANES = 3;                      // world units; road spans -HALF..+HALF
  var CAM_H = 1300, CAM_D = 1 / Math.tan((100 / 2) * Math.PI / 180);
  var SPEED_START = 4200, SPEED_ACC = 2300, SPEED_MAX = 13500, SPEED_PTS = 0.012;
  var LAT_MAX = 1.45;                                   // lane units / second of lateral travel
  var SLIP_RATE = 0.75, SLIP_MAX = 0.95;                // gravel drags the car toward the verge
  var GRAVEL_W = 0.42, PLAYER_HW = 0.17;                // half-widths, in lane units
  var OFFROAD_X = 1.08, TIRE_BURN = 0.42;               // past the shoulder: a life every ~2.4 s
  var START_LIVES = 3, INVULN = 1.35, NEAR_PTS = 55, COMBO_WINDOW = 3.4, COMBO_MAX = 9;
  var TIER_LEN = SEG_LEN * 220, TIER_MAX = 12;          // a difficulty tier every ~6 seconds
  var KEYS = { ArrowLeft: -1, KeyA: -1, ArrowRight: 1, KeyD: 1 };
  var STYLES = '.nr{position:relative;width:100%;height:100%;overflow:hidden;touch-action:none;' +
    'user-select:none;-webkit-tap-highlight-color:transparent;' +
    'font-family:var(--font-body,"Rajdhani",system-ui,sans-serif);color:var(--ink,#f2f5ff)}' +
    '.nr canvas{display:block;width:100%;height:100%;outline:none}';
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function hash(n) { var v = Math.sin(n * 12.9898) * 43758.5453; return v - Math.floor(v); } // stable speckle
  function readBest() {
    try { var v = parseInt(window.localStorage.getItem(STORE_KEY), 10);
      return isFinite(v) && v > 0 ? v : null; } catch (e) { return null; } // private mode throws
  }
  function writeBest(v) { try { window.localStorage.setItem(STORE_KEY, String(v)); } catch (e) { /* ignore */ } }
  /** Curvature as a function of absolute segment index, so recycled segments stay continuous. */
  function curveFor(i) { return (Math.sin(i * 0.0052) * 0.85 + Math.sin(i * 0.00131 + 2.2) * 1.7) * 0.00042; }

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
    var setStatus  = typeof api.setStatus === 'function'  ? api.setStatus  : function () {};
    var reduced = (window.PX && typeof window.PX.reduced === 'boolean') ? window.PX.reduced
      : !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    /* -------------------------------- DOM -------------------------------- */
    var wrap = document.createElement('div'); wrap.className = 'nr';
    var canvas = document.createElement('canvas');
    canvas.setAttribute('tabindex', '0'); canvas.setAttribute('role', 'application');
    canvas.setAttribute('aria-label', 'Night Rally. Steer with left and right arrows or A and D, or drag on touch.');
    var live = document.createElement('div');   // screen-reader score announcements
    live.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0)';
    live.setAttribute('aria-live', 'polite');
    var styleTag = document.createElement('style'); styleTag.textContent = STYLES;
    wrap.appendChild(canvas); wrap.appendChild(live); wrap.appendChild(styleTag);
    root.appendChild(wrap);
    // Left on the default transparent surface on purpose: alpha:false is faster, but it
    // switches the HUD to LCD subpixel text, which fringes the glyphs against the night sky.
    var ctx = canvas.getContext('2d');
    if (!ctx) { root.removeChild(wrap); return { destroy: function () {} }; }
    /* ------------------------------ State ------------------------------ */
    var rafId = 0, destroyed = false, dpr = 1, cssW = 1, cssH = 1, pads = [];
    var segments = [], nextIndex = SEG_COUNT, recycleSlot = 0, spawnSlot = 0, nextSpawnZ = 0;
    var marks = [];                                            // hazards queued for the retroreflective pass
    var position = 0, speed = SPEED_START, playerX = 0, latVel = 0, slip = 0, keyAxis = 0;
    var score = 0, shown = 0, lives = START_LIVES, invuln = 0, tier = 0, combo = 0, comboAt = 0;
    var bestEver = readBest(), bestMark = bestEver || 0, isRecord = false, hitAt = -1e9, last = 0;
    var over = false, paused = false, ready = true, dragTarget = null, hot = 0, dragId = null;
    var offroadT = 0, hudBottom = 1;
    /* ----------------- Sizing (crisp devicePixelRatio) ----------------- */
    function resize() {
      var r = wrap.getBoundingClientRect();
      cssW = Math.max(1, Math.round(r.width)); cssH = Math.max(1, Math.round(r.height));
      dpr = clamp(window.devicePixelRatio || 1, 1, 2);   // 2 is plenty; 3x phones choke on fill rate
      canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
      canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Thumb pads sit in the bottom corners — cached here so draw and hit-test agree.
      // A 44px floor keeps them a real touch target on the short letterbox strip phones get.
      var pw = Math.min(96, cssW * 0.24), ph = Math.min(76, Math.max(44, cssH * 0.14));
      var py = cssH - ph - Math.max(12, cssH * 0.05), m = Math.max(12, cssW * 0.05);
      pads = [{ x: m, y: py, w: pw, h: ph, ax: -1 }, { x: cssW - m - pw, y: py, w: pw, h: ph, ax: 1 }];
      // The bottom HUD row (lives, KM/H) rides above the pads instead of inside them.
      hudBottom = Math.max(28, py - Math.max(6, cssH * 0.025));
    }
    resize();
    function token(n, fb) { var v = getComputedStyle(document.documentElement).getPropertyValue(n);
      return (v && v.trim()) || fb; }
    var C = { bg: token('--bg', '#05060f'), ink: token('--ink', '#f2f5ff'), dim: token('--ink-dim', '#a7b0d0'),
      cyan: token('--cyan', '#22e7ff'), magenta: token('--magenta', '#ff2fb9'), acid: token('--acid', '#c8ff2e'),
      orange: token('--orange', '#ff8a3d'), violet: token('--violet', '#8b5cf6') };
    function hexA(hex, a) { hex = (hex || '#fff').trim().replace('#', '');
      var n = parseInt(hex, 16);
      return isFinite(n) ? 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')' : 'rgba(255,255,255,' + a + ')'; }
    /* Band colours, resolved once: the batching below reuses each string every frame. */
    var COL_VERGE = '#0b0f1e', COL_TAR_A = '#20243a', COL_TAR_B = '#272c46';
    var COL_TAR_FAR = '#242840';                          // far tarmac, alternation averaged away
    var COL_RUM_A = hexA(C.magenta, 0.6), COL_RUM_B = hexA(C.cyan, 0.55),
        COL_DASH = hexA(C.cyan, 0.55);
    /* Every other colour the frame loop paints. A fresh rgba() string per draw makes the
       canvas parse it again, and the loop used to mint ~50 of them a frame; the ones that
       scale with a mark's distance now ride on globalAlpha instead, which multiplies into
       the source alpha exactly the way baking the alpha into the string used to. */
    var HUE = [C.magenta, C.violet, C.orange];            // body hues 0/1/2; 2 doubles as rock
    var OB_BODY = [hexA(C.magenta, 0.92), hexA(C.violet, 0.92), hexA(C.orange, 0.92)];
    var OB_ROCK = hexA(C.orange, 0.85), OB_GLASS = hexA(C.ink, 0.35), TAIL = '#ff3a4e';
    var MK = [], mi;                                      // [hue][halo, tape, upright, brake]
    for (mi = 0; mi < HUE.length; mi++) {
      MK.push([hexA(HUE[mi], 0.16), hexA(HUE[mi], 0.8), hexA(HUE[mi], 0.3), hexA(HUE[mi], 0.85)]);
    }
    var BRAKE = 'rgba(255,58,78,0.85)';
    var PL_CAR = hexA(C.cyan, 0.95), PL_GLASS = hexA(C.bg, 0.65), PL_POD = hexA(C.acid, 0.95);
    var PAD_IDLE = hexA(C.cyan, 0.1), PAD_HOT = hexA(C.cyan, 0.4), PAD_EDGE = hexA(C.cyan, 0.45);
    var HUD_HALO = hexA(C.bg, 0.9), CARD_WASH = hexA(C.bg, 0.76);
    var HUD_FONT = {}, COMBO_FONT = {};                      // keyed by size, so resize-only
    /* ---------------------------- Road build ---------------------------- */
    function newSegment(i) {
      return { index: i, curve: 0, vis: false, gravel: 0, sprites: [],
        p1: { world: { y: 0, z: i * SEG_LEN }, camera: {}, screen: {} },
        p2: { world: { y: 0, z: (i + 1) * SEG_LEN }, camera: {}, screen: {} } };
    }
    function prep(s) { s.curve = curveFor(s.index) * (0.75 + tier * 0.16); s.vis = false; }
    function buildRoad() {
      segments.length = 0; nextIndex = SEG_COUNT; recycleSlot = 0; spawnSlot = 0;
      nextSpawnZ = SEG_LEN * 12;                          // a beat of clear road before the first hazard
      for (var i = 0; i < SEG_COUNT; i++) {
        var s = newSegment(i); prep(s); populate(s); segments.push(s);
      }
    }
    /**
     * Fill a segment. Spacing is measured in SECONDS OF DRIVING, not per segment: a per-segment
     * coin flip gave ~20 chances a second (a wall of traffic) and, because the opening ring was
     * never populated at all, nothing at all for the first fifteen seconds. Now there is a
     * hazard every ~0.9-1.5 s whatever the speed, and the whole ring is seeded in buildRoad.
     */
    function gapFor() {
      var lo = Math.max(0.55, 0.95 - tier * 0.03);
      return speed * (lo + Math.random() * 0.6);
    }
    function populate(s) {
      s.sprites.length = 0;                              // resolved traffic dies with the segment
      var idx = s.index, z0 = idx * SEG_LEN;
      s.gravel = (idx % 13 === 0) ? ((Math.floor(idx / 13) % 2) ? -0.66 : 0.66) : 0;
      if (z0 < nextSpawnZ) return;                        // still inside the gap the last hazard set
      if (s.gravel) return;                               // gravel runs stay clear of traffic
      nextSpawnZ = z0 + SEG_LEN + gapFor();
      var lanes = [-0.74, 0, 0.74], used = {}, n = (tier > 2 && Math.random() < 0.22) ? 2 : 1;
      for (var k = 0; k < n; k++) {                       // pairs leave a threadable gap
        var li = Math.floor(Math.random() * LANES), guard = 0;
        while (used[li] && guard++ < 6) li = (li + 1) % LANES;
        if (used[li]) break;
        used[li] = 1;
        var rock = k === 0 && Math.random() < 0.26 + tier * 0.02;
        s.sprites.push({ z: z0 + SEG_LEN * (0.35 + Math.random() * 0.3),
          lane: lanes[li] + (Math.random() - 0.5) * 0.1, w: rock ? 0.19 : 0.29, rock: rock,
          hue: k === 0 ? (spawnSlot % 3) : 2, resolved: false });
      }
      spawnSlot++;
    }
    /** Re-arm the segment the player has just driven past: fresh index, fresh contents. */
    function recycle(s) { s.index = nextIndex++; prep(s); populate(s); }
    function findSegment(z) { return segments[(((Math.floor(z / SEG_LEN) % SEG_COUNT) + SEG_COUNT) % SEG_COUNT)]; }
    function project(p, camX, camY, camZ) {              // world point -> screen point
      p.camera.x = (p.world.x || 0) - camX; p.camera.y = (p.world.y || 0) - camY;
      p.camera.z = (p.world.z || 0) - camZ;
      p.screen.scale = CAM_D / p.camera.z;
      p.screen.x = (cssW / 2) + (p.screen.scale * p.camera.x * cssW / 2);
      p.screen.y = (cssH / 2) - (p.screen.scale * p.camera.y * cssH / 2);
      p.screen.w = p.screen.scale * HALF_ROAD * cssW / 2;
    }
    function resetRun(fresh) {
      position = 0; speed = SPEED_START;            // set before buildRoad: gapFor() reads speed
      buildRoad();
      playerX = 0; latVel = 0; slip = 0; keyAxis = 0;
      score = 0; shown = 0; lives = START_LIVES; invuln = 0; tier = 0; combo = 0;
      hitAt = -1e9; over = false; isRecord = false; ready = !!fresh; paused = !!fresh;
      offroadT = 0;
      bestMark = bestEver || 0;
      dragTarget = null; hot = 0; last = performance.now();
      setScore(0);
      if (bestEver !== null) setBest(bestEver);
      live.textContent = 'New run. Score 0. Three lives.';
    }
    /* ---------------------------- Game logic ---------------------------- */
    function die() {
      if (over || destroyed) return;          // api.gameOver() may only fire once per run
      over = true; paused = false; combo = 0;
      var fl = Math.floor(score);
      if (isRecord && fl > bestMark) { bestMark = fl; writeBest(fl); setBest(fl); }
      live.textContent = 'Run over. Final score ' + fl + '.';
      gameOverCb(fl);
    }
    function hit() {
      if (invuln > 0 || over || destroyed) return;
      lives--; invuln = INVULN; combo = 0; hitAt = performance.now();
      speed = Math.max(SPEED_START * 0.6, speed * 0.45); latVel *= 0.2;
      if (lives <= 0) { die(); return; }
      live.textContent = 'Hit. ' + lives + ' lives left. Score ' + Math.floor(score) + '.';
    }
    function resolve(o) {
      o.resolved = true;
      var d = Math.abs(playerX - o.lane) - PLAYER_HW;
      if (d < o.w) { hit(); return; }
      if (d < o.w + (o.rock ? 0.14 : 0.2)) {              // threaded it
        combo = Math.min(COMBO_MAX, combo + 1); comboAt = performance.now();
        score += NEAR_PTS * combo;
        live.textContent = 'Near miss. Combo ' + combo + '.';
      }
    }
    function update(dt) {
      if (invuln > 0) invuln -= dt;
      tier = Math.min(TIER_MAX, Math.floor(position / TIER_LEN));
      speed = Math.min(Math.min(SPEED_START + tier * 480, SPEED_MAX), speed + SPEED_ACC * dt);
      var base = findSegment(position);
      var gravel = !!base.gravel && Math.abs(playerX - base.gravel) < GRAVEL_W;
      var axis = keyAxis;                                  // keyboard axis wins over a drag target
      if (!axis && dragTarget !== null) axis = clamp((dragTarget - playerX) * 2.4, -1, 1);
      var want = axis * LAT_MAX * (gravel ? 0.5 : 1);
      latVel += (want - latVel) * (gravel ? 1.8 : 7.5) * dt;   // gravel: heavy, laggy steering
      playerX += latVel * dt;
      if (gravel) {                                       // loose surface: drifts to the verge
        slip = clamp(slip + (playerX >= 0 ? 1 : -1) * SLIP_RATE * dt * (0.45 + Math.abs(latVel) / LAT_MAX),
          -SLIP_MAX, SLIP_MAX);
        playerX += slip * dt;
      } else slip *= Math.exp(-7 * dt);
      if (Math.abs(playerX) > 1.42) { playerX = clamp(playerX, -1.42, 1.42); latVel *= -0.25; slip = 0; }
      // Past the shoulder there is no tarmac under the tyres: the run costs a life every
      // TIRE_BURN seconds, so parking on the verge is not a scoring strategy any more.
      if (Math.abs(playerX) > OFFROAD_X && !over) {
        offroadT += dt;
        if (offroadT >= TIRE_BURN) { offroadT = 0; hit(); if (over) return; }
      } else offroadT = Math.max(0, offroadT - dt * 0.6);
      position += speed * dt;
      score += speed * dt * SPEED_PTS;
      if (performance.now() - comboAt > COMBO_WINDOW * 1000) combo = 0;
      var fl = Math.floor(score);
      if (fl !== shown) { shown = fl; setScore(fl); }
      // Persist on a 25-point ladder rather than every frame — localStorage writes are not free.
      if (bestEver === null || fl > bestEver) {
        bestEver = fl; isRecord = true;
        if (fl - bestMark >= 25) { bestMark = fl; writeBest(fl); setBest(fl); }
      }
      /* Traffic: resolve everything at or behind the car (4 segments of frame-skip guard). */
      for (var n = 0; n < 4; n++) {
        var seg = segments[(((base.index - n) % SEG_COUNT) + SEG_COUNT) % SEG_COUNT];
        for (var k = 0; k < seg.sprites.length; k++) {
          var o = seg.sprites[k];
          if (!o.resolved && o.z <= position) { resolve(o); if (over) return; }
        }
      }
      while (segments[recycleSlot].index < base.index) {    // only segments fully behind the car
        recycle(segments[recycleSlot]);
        recycleSlot = (recycleSlot + 1) % SEG_COUNT;
      }
    }
    /* ------------------------------ Drawing ------------------------------ */
    /**
     * Path sink. Every band the road draws is a quad, and quads that share a colour without
     * overlapping can ride in ONE path: nonzero winding unions them, so a single fill paints
     * exactly what filling them one by one would. Path2D also keeps the batching off the
     * context's per-path bookkeeping; the op list is a fallback for engines without it.
     */
    var HAS_P2 = typeof Path2D === 'function';
    function Sink() { this.p = HAS_P2 ? new Path2D() : null; this.ops = HAS_P2 ? null : []; }
    Sink.prototype.moveTo = function (x, y) { if (this.p) this.p.moveTo(x, y); else this.ops.push(0, x, y); };
    Sink.prototype.lineTo = function (x, y) { if (this.p) this.p.lineTo(x, y); else this.ops.push(1, x, y); };
    Sink.prototype.close = function () { if (this.p) this.p.closePath(); else this.ops.push(2, 0, 0); };
    Sink.prototype.quad = function (ax, ay, bx, by, cx, cy, dx, dy) {
      if (this.p) { var p = this.p;
        p.moveTo(ax, ay); p.lineTo(bx, by); p.lineTo(cx, cy); p.lineTo(dx, dy); p.closePath();
      } else { var o = this.ops; o.push(0, ax, ay, 1, bx, by, 1, cx, cy, 1, dx, dy, 2, 0, 0); }
    };
    /** A continuous band: left edge near-to-far, then the right edge back down. */
    Sink.prototype.strip = function (L, R) {
      var i;
      this.moveTo(L[0], L[1]);
      for (i = 2; i < L.length; i += 2) this.lineTo(L[i], L[i + 1]);
      for (i = R.length - 2; i >= 0; i -= 2) this.lineTo(R[i], R[i + 1]);
      this.close();
    };
    Sink.prototype.fill = function (color) {
      var i, o = this.ops;
      ctx.fillStyle = color;
      if (this.p) { ctx.fill(this.p); return; }
      ctx.beginPath();
      for (i = 0; i < o.length; i += 3) {
        if (o[i] === 0) ctx.moveTo(o[i + 1], o[i + 2]);
        else if (o[i] === 1) ctx.lineTo(o[i + 1], o[i + 2]);
        else ctx.closePath();
      }
      ctx.fill(); o.length = 0;
    };
    /* --------------------- Cached paint (size-dependent) --------------------- */
    /**
     * Sky wash, distance haze, both headlight cone gradients and the CRT/vignette overlay only
     * depend on the canvas size, so they are built here and reused until a resize changes it.
     * The frame loop no longer calls createRadialGradient at all.
     */
    var paint = { key: '', sky: null, haze: null, hazeY: 0, over: null, cone: null, warm: null, beam: 0 };
    function buildPaint() {
      var key = cssW + 'x' + cssH + '|' + C.bg + '|' + (reduced ? 1 : 0);
      if (paint.key === key) return;
      paint.key = key;
      var horizon = cssH * 0.5, camY = horizon + CAM_H, beam, o, oc, vig, i;
      // Sky and backdrop in one pass. The old pair — a full-frame fill plus the wash over the
      // top half — is the same pixels: the wash ends on C.bg exactly where the fill was, so one
      // gradient carrying C.bg all the way down replaces both.
      paint.sky = ctx.createLinearGradient(0, 0, 0, cssH);
      paint.sky.addColorStop(0, '#0a0720');
      paint.sky.addColorStop(0.5, C.bg); paint.sky.addColorStop(1, C.bg);
      // The haze lands on the same strip the far segments project into, and that strip is
      // fixed by the camera height: horizon .. (scale * camY * horizon) / distance. One
      // gradient covers the ~20px it actually spans, instead of one rect per segment.
      var hazeEnd = horizon + (CAM_D * camY * horizon) / (DRAW_DIST * 0.42 * SEG_LEN) + 2;
      paint.hazeY = hazeEnd - horizon;
      paint.haze = ctx.createLinearGradient(0, horizon, 0, hazeEnd);
      paint.haze.addColorStop(0, hexA(C.bg, 0.85)); paint.haze.addColorStop(1, hexA(C.bg, 0));
      beam = Math.min(cssW, cssH) * 0.7;                   // the cone is drawn in local space
      paint.beam = beam;
      paint.cone = ctx.createRadialGradient(0, 0, 0, 0, 0, beam);
      paint.cone.addColorStop(0, hexA(C.bg, 0));
      paint.cone.addColorStop(0.30, hexA(C.bg, 0.10));
      paint.cone.addColorStop(0.62, hexA(C.bg, 0.42));
      paint.cone.addColorStop(0.85, hexA(C.bg, 0.75));
      paint.cone.addColorStop(1, hexA(C.bg, DARK));
      paint.warm = ctx.createRadialGradient(0, 0, 0, 0, 0, beam);
      paint.warm.addColorStop(0, 'rgba(255,238,200,1)'); paint.warm.addColorStop(1, 'rgba(255,238,200,0)');
      /* Scanlines and vignette are both plain black over the same backdrop, and stacking two
         black source-overs multiplies the backdrop's survival, so baking them into a single
         RGBA layer reproduces the result exactly: on a scanline row the combined alpha is
         0.15 + v - 0.15v, on a clear row it is just v. Two full-screen fills become one blit.
         The scanlines keep the original per-row loop rather than a 3px tile: the layer is
         built once per resize, so the loop costs nothing, and it lands on exactly the rows
         the frame loop used to. */
      if (reduced) { paint.over = null; return; }
      o = document.createElement('canvas');
      o.width = canvas.width; o.height = canvas.height;
      oc = o.getContext('2d');
      oc.setTransform(dpr, 0, 0, dpr, 0, 0);
      vig = oc.createRadialGradient(cssW / 2, cssH / 2, Math.min(cssW, cssH) * 0.3,
        cssW / 2, cssH / 2, Math.max(cssW, cssH) * 0.72);
      vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(0,0,0,.6)');
      oc.fillStyle = vig; oc.fillRect(0, 0, cssW, cssH);
      oc.fillStyle = 'rgba(0,0,0,.15)';
      for (i = 0; i < cssH; i += 3) oc.fillRect(0, i, cssW, 1);
      paint.over = o;
    }
    /* Detail budget. Below a pixel of height a segment cannot show a rumble edge or a lane
       dash, so the far half of the road is stepped and its alternation folded to the average —
       which is what the eye already resolves at that scale. Widths are the smallest on-screen
       size, in px, at which a feature still reads as itself. These are deliberately tight:
       because the bands are batched, restoring detail costs path building, not draw calls. */
    var LOD_PX = 1.0, LOD_FAR_PX = 0.45;
    var RUMBLE_MIN = 1.1, DASH_MIN = 0.7, SPECK_MIN = 0.3;
    function glow(color, blur) { ctx.shadowColor = color; ctx.shadowBlur = reduced ? blur * 0.3 : blur; }
    function drawRoad() {
      marks.length = 0;
      var verge = new Sink(), tarA = new Sink(), tarB = new Sink(), tarFar = new Sink(),
          rumA = new Sink(), rumB = new Sink(), lane = new Sink();
      var vL = [], vR = [], fL = [], fR = [];              // verge outline, far tarmac outline
      var base = findSegment(position);
      var camY = cssH * 0.5 + CAM_H;                       // camera sits CAM_H above the road
      var maxy = cssH, curveX = 0, dx = -(base.curve * ((position % SEG_LEN) / SEG_LEN));
      var centrifugal = 0.35 + 1.25 * (speed / SPEED_MAX), loopZ = SEG_COUNT * SEG_LEN, n, s, cam;
      var lastN = -1, step = 1, dashes = false, i;
      for (n = 0; n < DRAW_DIST; n++) {
        s = segments[(base.index + n) % SEG_COUNT];
        cam = playerX * HALF_ROAD - curveX;
        project(s.p1, cam, camY, position - (s.index < base.index ? loopZ : 0));
        project(s.p2, cam - dx, camY, position - (s.index < base.index ? loopZ : 0));
        s.vis = false;
        if (s.p1.camera.z > CAM_D && s.p2.screen.y < s.p1.screen.y && s.p2.screen.y < maxy) {
          s.vis = true;
          var p1 = s.p1.screen, p2 = s.p2.screen;
          var y1 = p1.y, y2 = p2.y, x1 = p1.x, x2 = p2.x, w1 = p1.w, w2 = p2.w;
          var h = y1 - y2;
          step = h >= LOD_PX ? 1 : (h >= LOD_FAR_PX ? 2 : 4);
          if (n - lastN >= step) {                         // every 2nd/4th segment once sub-pixel
            lastN = n;
            // Verge: one continuous strip, both shoulders. Skipping a point just joins two
            // segments with a straight edge, and their edges differ by a fraction of a pixel.
            vL.push(x1 - w1 * 1.9, y1, x2 - w2 * 1.9, y2);
            vR.push(x1 + w1 * 1.9, y1, x2 + w2 * 1.9, y2);
            var dark = (Math.floor(s.index / 3) % 2) === 0;
            dashes = (Math.floor(s.index / 4) % 2) === 0 && w1 * 0.06 >= DASH_MIN;
            if (h >= LOD_FAR_PX) {                         // near field: alternate, two paths
              (dark ? tarA : tarB).quad(x1 - w1, y1, x1 + w1, y1, x2 + w2, y2, x2 - w2, y2);
            } else {                                       // far field: one averaged strip
              fL.push(x1 - w1, y1, x2 - w2, y2); fR.push(x1 + w1, y1, x2 + w2, y2);
            }
            if (w1 * 0.1 >= RUMBLE_MIN) {                  // rumble strips, only while they read
              var rum = dark ? rumA : rumB;
              rum.quad(x1 + w1, y1, x1 + w1 * 1.1, y1, x2 + w2 * 1.1, y2, x2 + w2, y2);
              rum.quad(x1 - w1 * 1.1, y1, x1 - w1, y1, x2 - w2, y2, x2 - w2 * 1.1, y2);
            }
            if (dashes) {                                  // dashed lane markers
              // Mirrors band(p1, p2, q / 3, q / 3 + 0.06) for q = +1 and q = -1, including
              // which side of the lane line each dash falls on.
              lane.quad(x1 - w1 / 3, y1, x1 - w1 / 3 - w1 * 0.06, y1,
                        x2 - w2 / 3 - w2 * 0.06, y2, x2 - w2 / 3, y2);
              lane.quad(x1 + w1 / 3, y1, x1 + w1 / 3 - w1 * 0.06, y1,
                        x2 + w2 / 3 - w2 * 0.06, y2, x2 + w2 / 3, y2);
            }
            if (s.gravel && w1 * 0.012 >= SPECK_MIN) {     // speckled patch
              for (i = 0; i < 9; i++) {
                var t = hash(s.index * 37 + i * 7.3), f = (i + 0.5) / 9;
                var gx = x1 + (x2 - x1) * f + (s.gravel + (t - 0.5) * GRAVEL_W * 2) * w1;
                var gs = (0.012 + t * 0.016) * w1, gy = y1 + (y2 - y1) * f;
                ctx.fillStyle = hexA(C.orange, 0.2 + t * 0.22);
                ctx.fillRect(gx - gs, gy - gs, gs * 2, gs * 2);
              }
            }
          }
          maxy = y2;
        }
        curveX += dx; dx += s.curve * centrifugal;
      }
      verge.strip(vL, vR); verge.fill(COL_VERGE);
      if (vL.length) tarA.fill(COL_TAR_A), tarB.fill(COL_TAR_B);
      if (fL.length) { tarFar.strip(fL, fR); tarFar.fill(COL_TAR_FAR); }
      rumA.fill(COL_RUM_A); rumB.fill(COL_RUM_B);
      if (vL.length) {                                      // lane dashes carry their own glow
        glow(C.cyan, 12); lane.fill(COL_DASH); ctx.shadowBlur = 0;
      }
      ctx.fillStyle = paint.haze; ctx.fillRect(0, cssH * 0.5, cssW, paint.hazeY);
      for (var m = DRAW_DIST - 1; m > 0; m--) {             // far-to-near, so cars occlude cars
        var sp = segments[(base.index + m) % SEG_COUNT];
        for (var j = 0; sp.vis && j < sp.sprites.length; j++) {
          if (!sp.sprites[j].resolved) drawObstacle(sp.sprites[j], sp);
        }
      }
    }
    function drawObstacle(o, seg) {
      var p1 = seg.p1.screen, p2 = seg.p2.screen, f = (o.z / SEG_LEN) % 1;
      var x = p1.x + (p2.x - p1.x) * f + (p1.scale + (p2.scale - p1.scale) * f) * o.lane * HALF_ROAD * cssW / 2;
      var y = p1.y + (p2.y - p1.y) * f, hw = (p1.w + (p2.w - p1.w) * f) * o.w;
      if (hw < 0.7) return;
      var hh = hw * (o.rock ? 0.75 : 0.55);
      if (o.rock) {
        glow(C.orange, 16); ctx.fillStyle = OB_ROCK;
        ctx.beginPath(); ctx.moveTo(x, y - hh * 1.4); ctx.lineTo(x + hw, y); ctx.lineTo(x - hw, y);
        ctx.closePath(); ctx.fill(); ctx.shadowBlur = 0;
        marks.push({ x: x, y: y, hw: hw, hh: hh, hue: 2, rock: true });
        return;
      }
      glow(HUE[o.hue], 18); ctx.fillStyle = OB_BODY[o.hue];
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x - hw, y - hh * 2.4, hw * 2, hh * 2.4, hh * 0.5);
      else ctx.rect(x - hw, y - hh * 2.4, hw * 2, hh * 2.4);
      ctx.fill(); ctx.shadowBlur = 0;
      ctx.fillStyle = OB_GLASS; ctx.fillRect(x - hw * 0.7, y - hh * 1.9, hw * 1.44, hh * 0.7);
      ctx.fillStyle = TAIL;                                 // tail lights, seen from behind
      ctx.fillRect(x - hw * 0.85, y - hh * 0.5, hw * 0.45, hh * 0.35);
      ctx.fillRect(x + hw * 0.4, y - hh * 0.5, hw * 0.45, hh * 0.35);
      marks.push({ x: x, y: y, hw: hw, hh: hh, hue: o.hue, rock: false });
    }
    /**
     * Retroreflective pass, drawn AFTER the blackout. The world fill alone leaves only a few
     * percent of a car's colour once the night fill lands on it, which is why hazards read as
     * nothing at speed. These are the reflective tape and tail lights on the back of each car:
     * they punch through the dark, so every obstacle announces itself before it is in reach.
     */
    function drawMarkers() {
      var i, m, w, a, k;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (i = 0; i < marks.length; i++) {
        m = marks[i];
        a = clamp(0.5 + m.hw / 70, 0.5, 1);                // far hazards keep a floor, not a fade-out
        w = Math.max(1.6, m.hw * 0.34);
        k = MK[m.hue];
        ctx.globalAlpha = a;                               // the distance fade, applied once
        if (m.rock) {
          ctx.fillStyle = k[2];
          ctx.beginPath();
          ctx.arc(m.x, m.y - m.hh * 0.7, Math.max(3, m.hw * 1.6), 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = k[3];
          ctx.fillRect(m.x - w / 2, m.y - m.hh * 1.5, w, Math.max(2, m.hh * 1.5));
          continue;
        }
        ctx.fillStyle = k[0];                             // soft halo so the shape survives the dark
        ctx.beginPath();
        ctx.ellipse(m.x, m.y - m.hh * 1.2, Math.max(5, m.hw * 1.7), Math.max(7, m.hh * 3), 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = k[1];                             // two reflective uprights
        ctx.fillRect(m.x - m.hw * 0.8, m.y - m.hh * 2.3, w, m.hh * 2.1);
        ctx.fillRect(m.x + m.hw * 0.8 - w, m.y - m.hh * 2.3, w, m.hh * 2.1);
        ctx.fillStyle = BRAKE;                             // brake bar across the pair
        ctx.fillRect(m.x - m.hw * 0.95, m.y - m.hh * 0.5, m.hw * 1.9, Math.max(1.5, m.hh * 0.3));
      }
      ctx.restore();
    }
    function drawPlayer(now) {
      var base = HALF_ROAD * cssW / 2 / CAM_H;             // world-to-screen scale at the car's z
      var x = cssW / 2 + playerX * base, y = cssH;
      var hw = base * PLAYER_HW * 1.15, hh = hw * 0.62;
      var lean = clamp(latVel * 0.1 + slip * 0.16, -0.42, 0.42);
      if (!(invuln > 0 && !reduced && Math.floor(now / 90) % 2 === 0)) {   // blink while invulnerable
        ctx.save(); ctx.translate(x, y); ctx.rotate(lean);
        glow(C.cyan, 22); ctx.fillStyle = PL_CAR;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(-hw, -hh * 2.6, hw * 2, hh * 2.6, hh * 0.6);
        else ctx.rect(-hw, -hh * 2.6, hw * 2, hh * 2.6);
        ctx.fill(); ctx.shadowBlur = 0;
        ctx.fillStyle = PL_GLASS; ctx.fillRect(-hw * 0.72, -hh * 2.1, hw * 1.44, hh * 0.75);
        ctx.fillStyle = PL_POD;                            // headlight pods
        ctx.fillRect(-hw * 0.9, -hh * 0.7, hw * 0.5, hh * 0.4);
        ctx.fillRect(hw * 0.4, -hh * 0.7, hw * 0.5, hh * 0.4);
        ctx.fillStyle = TAIL;
        ctx.fillRect(-hw * 0.85, -hh * 0.16, hw * 0.45, hh * 0.3);
        ctx.fillRect(hw * 0.4, -hh * 0.16, hw * 0.45, hh * 0.3);
        ctx.restore();
      }
      return { x: x, y: y - hh * 1.3, hw: hw };
    }
    /**
     * Night pass. A previous version filled the frame with a 0.955 blackout and then erased a
     * 0.98-alpha cone out of what was left, so the two passes multiplied: the lit road kept
     * 0.045 * 0.02 = 0.1% of its own colour. Darkness is now applied ONCE. It used to take two
     * full-frame passes to say it — a fill clipped to everything outside the headlight ellipse,
     * then the radial falloff inside it — but the falloff's outermost stop already IS that
     * blackout colour, and a radial gradient holds its last stop for every radius past it. So
     * the clipped fill was painting exactly what the cone already covers, and the whole night
     * pass is one gradient: falloff inside the beam, flat blackout outside, no seam, no clip.
     */
    var DARK = 0.92;
    function drawDarkness(car) {
      var cx = car.x, cy = car.y - car.hw;
      ctx.save();
      ctx.translate(cx, cy); ctx.scale(1, 2.2);              // the beam: a tall ellipse ahead
      // The canvas bounds expressed in that space, so one fill covers the frame edge to edge.
      ctx.fillStyle = paint.cone; ctx.fillRect(-cx, -cy / 2.2, cssW, cssH / 2.2);
      ctx.globalCompositeOperation = 'lighter';              // warm scatter, so it reads as light
      ctx.globalAlpha = reduced ? 0.05 : 0.1;
      ctx.fillStyle = paint.warm; ctx.fillRect(-cx, -cy / 2.2, cssW, cssH / 2.2);
      ctx.restore();
    }
    var TITLE_F = 'Orbitron, system-ui, sans-serif', BODY_F = 'Rajdhani, system-ui, sans-serif';
    var SIDE = 0.92;                                        // share of the width a card line may use
    var curFont = '';
    /** Assign ctx.font only when the string actually changes. The HUD re-selects the same
        font every frame, and each assignment makes the canvas drop its parsed font. */
    function useFont(s) { if (s !== curFont) { curFont = s; ctx.font = s; } }
    /**
     * The stage is taller than it is wide on a phone, so a height-only font scale balloons the
     * card type until it runs off both edges. Measure once at 100px and scale against the WIDTH
     * as well: a wide desktop stage keeps its height-derived size, a narrow phone stage shrinks.
     */
    function fitFont(text, weight, family, want, minPx) {
      useFont(weight + ' 100px ' + family);
      var perPx = ctx.measureText(text).width / 100 || 1;
      var px = clamp(Math.round(Math.min(want, cssW * SIDE / perPx)), minPx, want);
      useFont(weight + ' ' + px + 'px ' + family);
      return px;
    }
    /** Greedy word wrap; drops a size step only if the text still will not fit on two lines. */
    function wrapText(text, want, minPx) {
      var size = want, lines, rest, cut, sp;
      for (;;) {
        useFont('600 ' + size + 'px ' + BODY_F);
        lines = []; rest = text;
        while (rest.length) {
          cut = rest.length;
          while (cut > 1 && ctx.measureText(rest.slice(0, cut)).width > cssW * SIDE) {
            sp = rest.lastIndexOf(' ', cut - 1);
            if (sp < 1) break;
            cut = sp;
          }
          lines.push(rest.slice(0, cut).trim());
          rest = rest.slice(cut).trim();
        }
        if (lines.length <= 2 || size <= minPx) break;
        size = Math.max(minPx, Math.floor(size * 0.8));
      }
      return { lines: lines, size: size, h: lines.length * size * 1.2 };
    }
    function drawBlock(w, color, yc) {                       // yc = centre line of the block
      var i;
      useFont('600 ' + w.size + 'px ' + BODY_F); ctx.fillStyle = color;
      for (i = 0; i < w.lines.length; i++)
        ctx.fillText(w.lines[i], cssW / 2, yc + (i - (w.lines.length - 1) / 2) * w.size * 1.2);
    }
    /** Centred overlay: big neon title, one dim sub-line, optional hint — stacked, never overlapping. */
    function card(title, sub, color, hint) {
      var bsw = Math.round(clamp(cssH * 0.048, 12, 20));
      var tw = fitFont(title, '900', TITLE_F, Math.round(clamp(cssH * 0.13, 22, 58)), 16);
      var a = wrapText(sub, bsw, 12), b = hint ? wrapText(hint, bsw, 12) : null;
      var gap = Math.max(10, cssH * 0.035), th = tw * 1.05, y = (cssH - (th + gap + a.h + (b ? gap + b.h : 0))) / 2;
      ctx.fillStyle = CARD_WASH; ctx.fillRect(0, 0, cssW, cssH);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      useFont('900 ' + tw + 'px ' + TITLE_F);
      ctx.fillStyle = color; glow(color, 26);
      ctx.fillText(title, cssW / 2, y + th / 2); ctx.shadowBlur = 0;
      drawBlock(a, C.dim, y + th + gap + a.h / 2);
      if (b) drawBlock(b, C.dim, y + th + gap + a.h + gap + b.h / 2);
    }
    function drawPads() {                                    // always-visible thumb zones
      var i, p;
      for (i = 0; i < 2; i++) {
        p = pads[i];
        ctx.fillStyle = hot === p.ax ? PAD_HOT : PAD_IDLE;
        ctx.strokeStyle = PAD_EDGE; ctx.lineWidth = 2;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(p.x, p.y, p.w, p.h, 14); else ctx.rect(p.x, p.y, p.w, p.h);
        ctx.fill(); ctx.stroke();
        ctx.strokeStyle = C.ink; ctx.lineWidth = 3; ctx.lineCap = 'round';
        var cx = p.x + p.w / 2, cy = p.y + p.h / 2, s = p.h * 0.18;
        ctx.beginPath();
        ctx.moveTo(cx - p.ax * s, cy - s); ctx.lineTo(cx + p.ax * s, cy); ctx.lineTo(cx - p.ax * s, cy + s);
        ctx.stroke();
      }
    }
    function draw(now) {
      buildPaint();                                          // no-op unless the canvas changed size
      ctx.fillStyle = paint.sky; ctx.fillRect(0, 0, cssW, cssH);
      drawRoad();                                            // road first, car over the top of it
      var car = drawPlayer(now);
      drawDarkness(car);
      drawMarkers();                                         // reflective tape reads through the night
      if (now - hitAt < 380 && !reduced) {                   // impact flash — world layer
        ctx.fillStyle = hexA('#ff3a4e', 0.32 * (1 - (now - hitAt) / 380));
        ctx.fillRect(0, 0, cssW, cssH);
      }
      if (paint.over) ctx.drawImage(paint.over, 0, 0, cssW, cssH);   // scanlines + vignette
      /* HUD sits above the CRT overlay so it stays at full contrast over the vignette.
         A dark halo keeps it legible when a lit road or the car runs behind the text. */
      ctx.shadowColor = HUD_HALO; ctx.shadowBlur = 6;
      var fs = Math.round(clamp(Math.min(cssH * 0.042, cssW * 0.05), 11, 17)), m = Math.max(10, cssW * 0.04);
      var top = Math.max(14, cssH * 0.05), i, font = HUD_FONT[fs] || (HUD_FONT[fs] = '700 ' + fs + 'px Rajdhani, system-ui, sans-serif');
      ctx.textBaseline = 'middle'; useFont(font);
      ctx.textAlign = 'left'; ctx.fillStyle = C.ink;
      ctx.fillText('SCORE ' + Math.floor(score), m, top);
      ctx.textAlign = 'right'; ctx.fillStyle = C.dim;
      ctx.fillText('BEST ' + (bestEver || 0), cssW - m, top);
      ctx.textAlign = 'right'; ctx.fillStyle = C.cyan;
      ctx.fillText(Math.round(speed * 0.08) + ' KM/H', cssW - m, hudBottom);
      ctx.textAlign = 'left'; ctx.fillStyle = lives <= 1 ? C.magenta : C.acid;
      for (i = 0; i < START_LIVES; i++) {
        ctx.globalAlpha = i < lives ? 1 : 0.2;
        ctx.fillText('◆', m + i * fs * 1.1, hudBottom);
      }
      ctx.globalAlpha = 1;
      if (combo > 1) {                                        // combo flares, then cools
        var cooling = (now - comboAt) / 1000 > COMBO_WINDOW - 0.6;
        ctx.textAlign = 'center'; ctx.fillStyle = cooling ? C.dim : C.magenta;
        useFont(COMBO_FONT[fs] || (COMBO_FONT[fs] = '900 ' + Math.round(fs * 1.35) + 'px Orbitron, system-ui, sans-serif'));
        glow(C.magenta, 18); ctx.fillText('COMBO x' + combo, cssW / 2, top + fs * 1.6);
        ctx.shadowBlur = 0; useFont(font);
      }
      ctx.shadowBlur = 0; ctx.shadowColor = 'rgba(0,0,0,0)';
      drawPads();
      if (paused && !over) {
        card(ready ? 'NIGHT RALLY' : 'PAUSED',
          ready ? 'Dodge the traffic. Keep it on the tarmac.'
                : 'Tap or press a key to resume',
          C.cyan, ready ? 'Drag left/right or hold the pads · 3 lives' : null);
      }
      if (over) card('GAME OVER', 'SCORE ' + Math.floor(score) + (isRecord ? '  ·  NEW BEST' : ''),
        C.magenta, 'TAP or press SPACE to rally again');
    }
    /* -------------------------- Single rAF loop -------------------------- */
    function frame(now) {
      if (destroyed) return;                                 // guard: destroy() can land between frames
      var dt = Math.min(0.2, (now - last) / 1000); last = now;
      if (!paused && !over) update(dt);
      if (!destroyed) draw(now);
      if (destroyed) return;                                 // update() -> gameOver -> api -> destroy()
      rafId = requestAnimationFrame(frame);
    }
    /* ------------------- Input: keyboard + drag + pads ------------------- */
    function act() {                                                // the one place a run starts
      if (over) { resetRun(false); setStatus('Playing'); return; }
      paused = false;
      if (ready) { ready = false; setStatus('Playing'); }
    }
    /** SPACE is documented as the pause key, so it toggles; taps and arrows only ever resume. */
    function togglePause() {
      if (over) { resetRun(false); setStatus('Playing'); return; }
      if (ready) { ready = false; paused = false; }
      else { paused = !paused; if (paused) { keyAxis = 0; dragTarget = null; hot = 0; } }
      setStatus(paused ? 'Paused' : 'Playing');
    }
    function onKeyDown(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var a = document.activeElement;
      if (a && a !== canvas && /^(BUTTON|INPUT|SELECT|TEXTAREA|A|SUMMARY)$/.test(a.tagName)) return;
      if (e.code === 'Space' || e.code === 'Enter' || e.key === ' ') { e.preventDefault(); togglePause(); return; }
      var ax = KEYS[e.code] || KEYS[e.key];
      if (ax) { e.preventDefault(); keyAxis = ax; act(); }
    }
    function onKeyUp(e) { if (e.code in KEYS) keyAxis = 0; }
    function localXY(e) { var r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top, w: Math.max(1, r.width) }; }
    function onPointerDown(e) {
      if (e.button !== undefined && e.button !== 0) return;
      var p = localXY(e), i, pad = 0;
      act();
      for (i = 0; i < 2 && !pad; i++) {                     // corner pad beats drag on that touch
        var q = pads[i];
        if (p.x >= q.x && p.x <= q.x + q.w && p.y >= q.y && p.y <= q.y + q.h) pad = q.ax;
      }
      if (pad) { hot = pad; dragTarget = null; } else { hot = 0; dragTarget = (p.x / p.w) * 2.25 - 1.12; }
      dragId = e.pointerId;
      if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
    }
    function onPointerMove(e) {
      if (hot || e.pointerId !== dragId) return;            // a pad hold owns the steering
      var p = localXY(e);
      dragTarget = clamp((p.x / p.w) * 2.25 - 1.12, -1.12, 1.12);
    }
    function onPointerRelease(e) {
      if (e.pointerId !== dragId) return;
      dragId = null; dragTarget = null; hot = 0;
    }
    function onResize() { if (!destroyed) resize(); }
    function onBlur() { if (!destroyed) { paused = !over; ready = false; keyAxis = 0;
      dragTarget = null; dragId = null; hot = 0;
      if (!over) setStatus(paused ? 'Paused' : 'Playing'); } }         // auto-pause on focus loss
    function onVisibility() { if (document.hidden) onBlur(); }
    // Every listener the game owns, in one table so teardown cannot miss one.
    var BIND = [[document, 'keydown', onKeyDown], [document, 'keyup', onKeyUp],
      [canvas, 'pointerdown', onPointerDown], [canvas, 'pointermove', onPointerMove],
      [canvas, 'pointerup', onPointerRelease], [canvas, 'pointercancel', onPointerRelease],
      [window, 'resize', onResize, { passive: true }], [window, 'orientationchange', onResize],
      [window, 'blur', onBlur], [document, 'visibilitychange', onVisibility]];
    BIND.forEach(function (b) { b[0].addEventListener(b[1], b[2], b[3]); });
    resetRun(true); last = performance.now();
    rafId = requestAnimationFrame(frame);
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
    name: 'Night Rally',
    instructions:
      'Survive the night stage: swerve around the traffic and rocks ahead, and stay on the tarmac. ' +
      'Drag left/right anywhere on screen — or hold the on-screen arrow pads — to steer; on keyboard ' +
      'use LEFT/RIGHT or A/D. Hazards arrive every second or two, so read the reflective tape early. ' +
      'Gravel shoulders kill your grip, so the car slides toward the verge and you have to catch it. ' +
      'Distance scores every metre, and squeezing past an obstacle for a NEAR MISS builds a COMBO ' +
      'worth up to 9x. Three lives, one hit each. SPACE pauses. Best score is saved on this device.',
    start: start
  };
})();
