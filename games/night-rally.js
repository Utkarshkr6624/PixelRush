/**
 * PIXEL RUSH — games/night-rally.js — "Night Rally"
 * Contract (GAME-CONTRACT.md): window.PixelGame = { name, instructions, start(root, api) }
 * where api = { setScore(n), setBest(n), gameOver(score) } and start() returns { destroy() }.
 * Pseudo-3D road: segments are projected through a camera while a curve accumulator shifts the
 * road laterally (the classic outrun model). The world is drawn flat, then re-darkened with a
 * destination-out headlight cone, so nothing outside the beam is visible.
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
    /** A road-spanning quad between two fractions of the half-road width, from `from` to `to`. */
    function band(p1, p2, from, to, color) {
      ctx.fillStyle = color; ctx.beginPath();
      ctx.moveTo(p1.x - p1.w * from, p1.y); ctx.lineTo(p1.x - p1.w * to, p1.y);
      ctx.lineTo(p2.x - p2.w * to, p2.y); ctx.lineTo(p2.x - p2.w * from, p2.y);
      ctx.closePath(); ctx.fill();
    }
    function glow(color, blur) { ctx.shadowColor = color; ctx.shadowBlur = reduced ? blur * 0.3 : blur; }
    function drawRoad() {
      marks.length = 0;
      var base = findSegment(position);
      var camY = cssH * 0.5 + CAM_H;                       // camera sits CAM_H above the road
      var maxy = cssH, curveX = 0, dx = -(base.curve * ((position % SEG_LEN) / SEG_LEN));
      var centrifugal = 0.35 + 1.25 * (speed / SPEED_MAX), loopZ = SEG_COUNT * SEG_LEN, n, s;
      for (n = 0; n < DRAW_DIST; n++) {
        s = segments[(base.index + n) % SEG_COUNT];
        project(s.p1, playerX * HALF_ROAD - curveX, camY, position - (s.index < base.index ? loopZ : 0));
        project(s.p2, playerX * HALF_ROAD - curveX - dx, camY, position - (s.index < base.index ? loopZ : 0));
        s.vis = false;
        if (s.p1.camera.z > CAM_D && s.p2.screen.y < s.p1.screen.y && s.p2.screen.y < maxy) {
          s.vis = true;
          var p1 = s.p1.screen, p2 = s.p2.screen;
          var y1 = p1.y, y2 = p2.y, x1 = p1.x, x2 = p2.x, w1 = p1.w;
          var dark = (Math.floor(s.index / 3) % 2) === 0;
          band(p1, p2, -1.9, 1.9, '#0b0f1e');                                  // verge
          band(p1, p2, -1, 1, dark ? '#20243a' : '#272c46');                  // tarmac
          var rum = dark ? hexA(C.magenta, 0.6) : hexA(C.cyan, 0.55);
          band(p1, p2, 1, 1.1, rum); band(p1, p2, -1.1, -1, rum);             // rumble strips
          if (Math.floor(s.index / 4) % 2 === 0) {                            // dashed lane markers
            glow(C.cyan, 12);
            for (var q = -1; q <= 1; q += 2) band(p1, p2, q / 3, q / 3 + 0.06, hexA(C.cyan, 0.55));
            ctx.shadowBlur = 0;
          }
          if (s.gravel) {                                                     // speckled patch
            for (var q2 = 0; q2 < 9; q2++) {
              var t = hash(s.index * 37 + q2 * 7.3), f = (q2 + 0.5) / 9;
              var gx = x1 + (x2 - x1) * f + (s.gravel + (t - 0.5) * GRAVEL_W * 2) * w1;
              var gs = (0.012 + t * 0.016) * w1, gy = y1 + (y2 - y1) * f;
              ctx.fillStyle = hexA(C.orange, 0.2 + t * 0.22);
              ctx.fillRect(gx - gs, gy - gs, gs * 2, gs * 2);
            }
          }
          var fog = clamp((n - DRAW_DIST * 0.42) / (DRAW_DIST * 0.58), 0, 1);   // distance haze
          if (fog > 0) { ctx.fillStyle = hexA(C.bg, fog * 0.85); ctx.fillRect(0, y2, cssW, y1 - y2 + 1); }
          maxy = y2;
        }
        curveX += dx; dx += s.curve * centrifugal;
      }
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
        glow(C.orange, 16); ctx.fillStyle = hexA(C.orange, 0.85);
        ctx.beginPath(); ctx.moveTo(x, y - hh * 1.4); ctx.lineTo(x + hw, y); ctx.lineTo(x - hw, y);
        ctx.closePath(); ctx.fill(); ctx.shadowBlur = 0;
        marks.push({ x: x, y: y, hw: hw, hh: hh, color: C.orange, rock: true });
        return;
      }
      var body = o.hue === 0 ? C.magenta : (o.hue === 1 ? C.violet : C.orange);
      glow(body, 18); ctx.fillStyle = hexA(body, 0.92);
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x - hw, y - hh * 2.4, hw * 2, hh * 2.4, hh * 0.5);
      else ctx.rect(x - hw, y - hh * 2.4, hw * 2, hh * 2.4);
      ctx.fill(); ctx.shadowBlur = 0;
      ctx.fillStyle = hexA(C.ink, 0.35); ctx.fillRect(x - hw * 0.7, y - hh * 1.9, hw * 1.44, hh * 0.7);
      ctx.fillStyle = '#ff3a4e';                            // tail lights, seen from behind
      ctx.fillRect(x - hw * 0.85, y - hh * 0.5, hw * 0.45, hh * 0.35);
      ctx.fillRect(x + hw * 0.4, y - hh * 0.5, hw * 0.45, hh * 0.35);
      marks.push({ x: x, y: y, hw: hw, hh: hh, color: body, rock: false });
    }
    /**
     * Retroreflective pass, drawn AFTER the blackout. The world fill alone leaves only a few
     * percent of a car's colour once the night fill lands on it, which is why hazards read as
     * nothing at speed. These are the reflective tape and tail lights on the back of each car:
     * they punch through the dark, so every obstacle announces itself before it is in reach.
     */
    function drawMarkers() {
      var i, m, w, a;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (i = 0; i < marks.length; i++) {
        m = marks[i];
        a = clamp(0.5 + m.hw / 70, 0.5, 1);                // far hazards keep a floor, not a fade-out
        w = Math.max(1.6, m.hw * 0.34);
        if (m.rock) {
          ctx.fillStyle = hexA(m.color, 0.3 * a);
          ctx.beginPath();
          ctx.arc(m.x, m.y - m.hh * 0.7, Math.max(3, m.hw * 1.6), 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = hexA(m.color, 0.85 * a);
          ctx.fillRect(m.x - w / 2, m.y - m.hh * 1.5, w, Math.max(2, m.hh * 1.5));
          continue;
        }
        ctx.fillStyle = hexA(m.color, 0.16 * a);           // soft halo so the shape survives the dark
        ctx.beginPath();
        ctx.ellipse(m.x, m.y - m.hh * 1.2, Math.max(5, m.hw * 1.7), Math.max(7, m.hh * 3), 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = hexA(m.color, 0.8 * a);             // two reflective uprights
        ctx.fillRect(m.x - m.hw * 0.8, m.y - m.hh * 2.3, w, m.hh * 2.1);
        ctx.fillRect(m.x + m.hw * 0.8 - w, m.y - m.hh * 2.3, w, m.hh * 2.1);
        ctx.fillStyle = 'rgba(255,58,78,' + (0.85 * a) + ')';  // brake bar across the pair
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
        glow(C.cyan, 22); ctx.fillStyle = hexA(C.cyan, 0.95);
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(-hw, -hh * 2.6, hw * 2, hh * 2.6, hh * 0.6);
        else ctx.rect(-hw, -hh * 2.6, hw * 2, hh * 2.6);
        ctx.fill(); ctx.shadowBlur = 0;
        ctx.fillStyle = hexA(C.bg, 0.65); ctx.fillRect(-hw * 0.72, -hh * 2.1, hw * 1.44, hh * 0.75);
        ctx.fillStyle = hexA(C.acid, 0.95);                // headlight pods
        ctx.fillRect(-hw * 0.9, -hh * 0.7, hw * 0.5, hh * 0.4);
        ctx.fillRect(hw * 0.4, -hh * 0.7, hw * 0.5, hh * 0.4);
        ctx.fillStyle = '#ff3a4e';
        ctx.fillRect(-hw * 0.85, -hh * 0.16, hw * 0.45, hh * 0.3);
        ctx.fillRect(hw * 0.4, -hh * 0.16, hw * 0.45, hh * 0.3);
        ctx.restore();
      }
      return { x: x, y: y - hh * 1.3, hw: hw };
    }
    /**
     * Night pass. A previous version filled the frame with a 0.955 blackout and then erased a
     * 0.98-alpha cone out of what was left, so the two passes multiplied: the lit road kept
     * 0.045 * 0.02 = 0.1% of its own colour. Darkness is now applied ONCE — a full-frame fill
     * clipped to everything outside the headlight ellipse, then a radial falloff inside it whose
     * outermost stop matches the fill exactly, so the cone has no seam and no compounding.
     */
    var DARK = 0.92;
    function drawDarkness(car) {
      var beam = Math.min(cssW, cssH) * 0.7, cx = car.x, cy = car.y - car.hw, ry = beam * 2.2, g;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, cssW, cssH);
      ctx.ellipse(cx, cy, beam, ry, 0, 0, Math.PI * 2);
      ctx.clip('evenodd');
      ctx.fillStyle = hexA(C.bg, DARK); ctx.fillRect(0, 0, cssW, cssH);
      ctx.restore();
      ctx.save();
      ctx.translate(cx, cy); ctx.scale(1, ry / beam);        // the beam: a tall ellipse ahead
      g = ctx.createRadialGradient(0, 0, 0, 0, 0, beam);
      g.addColorStop(0, hexA(C.bg, 0));
      g.addColorStop(0.30, hexA(C.bg, 0.10));
      g.addColorStop(0.62, hexA(C.bg, 0.42));
      g.addColorStop(0.85, hexA(C.bg, 0.75));
      g.addColorStop(1, hexA(C.bg, DARK));
      ctx.fillStyle = g; ctx.fillRect(-beam, -beam, beam * 2, beam * 2);
      ctx.globalCompositeOperation = 'lighter';              // warm scatter, so it reads as light
      ctx.globalAlpha = reduced ? 0.05 : 0.1;
      g = ctx.createRadialGradient(0, 0, 0, 0, 0, beam);
      g.addColorStop(0, 'rgba(255,238,200,1)'); g.addColorStop(1, 'rgba(255,238,200,0)');
      ctx.fillStyle = g; ctx.fillRect(-beam, -beam, beam * 2, beam * 2);
      ctx.restore();
    }
    var TITLE_F = 'Orbitron, system-ui, sans-serif', BODY_F = 'Rajdhani, system-ui, sans-serif';
    var SIDE = 0.92;                                        // share of the width a card line may use
    /**
     * The stage is taller than it is wide on a phone, so a height-only font scale balloons the
     * card type until it runs off both edges. Measure once at 100px and scale against the WIDTH
     * as well: a wide desktop stage keeps its height-derived size, a narrow phone stage shrinks.
     */
    function fitFont(text, weight, family, want, minPx) {
      ctx.font = weight + ' 100px ' + family;
      var perPx = ctx.measureText(text).width / 100 || 1;
      var px = clamp(Math.round(Math.min(want, cssW * SIDE / perPx)), minPx, want);
      ctx.font = weight + ' ' + px + 'px ' + family;
      return px;
    }
    /** Greedy word wrap; drops a size step only if the text still will not fit on two lines. */
    function wrapText(text, want, minPx) {
      var size = want, lines, rest, cut, sp;
      for (;;) {
        ctx.font = '600 ' + size + 'px ' + BODY_F;
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
      ctx.font = '600 ' + w.size + 'px ' + BODY_F; ctx.fillStyle = color;
      for (i = 0; i < w.lines.length; i++)
        ctx.fillText(w.lines[i], cssW / 2, yc + (i - (w.lines.length - 1) / 2) * w.size * 1.2);
    }
    /** Centred overlay: big neon title, one dim sub-line, optional hint — stacked, never overlapping. */
    function card(title, sub, color, hint) {
      var bsw = Math.round(clamp(cssH * 0.048, 12, 20));
      var tw = fitFont(title, '900', TITLE_F, Math.round(clamp(cssH * 0.13, 22, 58)), 16);
      var a = wrapText(sub, bsw, 12), b = hint ? wrapText(hint, bsw, 12) : null;
      var gap = Math.max(10, cssH * 0.035), th = tw * 1.05, y = (cssH - (th + gap + a.h + (b ? gap + b.h : 0))) / 2;
      ctx.fillStyle = hexA(C.bg, 0.76); ctx.fillRect(0, 0, cssW, cssH);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '900 ' + tw + 'px ' + TITLE_F;
      ctx.fillStyle = color; glow(color, 26);
      ctx.fillText(title, cssW / 2, y + th / 2); ctx.shadowBlur = 0;
      drawBlock(a, C.dim, y + th + gap + a.h / 2);
      if (b) drawBlock(b, C.dim, y + th + gap + a.h + gap + b.h / 2);
    }
    function drawPads() {                                    // always-visible thumb zones
      var i, p;
      for (i = 0; i < 2; i++) {
        p = pads[i];
        ctx.fillStyle = hot === p.ax ? hexA(C.cyan, 0.4) : hexA(C.cyan, 0.1);
        ctx.strokeStyle = hexA(C.cyan, 0.45); ctx.lineWidth = 2;
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
      ctx.fillStyle = C.bg; ctx.fillRect(0, 0, cssW, cssH);
      var sky = ctx.createLinearGradient(0, 0, 0, cssH * 0.5);
      sky.addColorStop(0, '#0a0720'); sky.addColorStop(1, C.bg);
      ctx.fillStyle = sky; ctx.fillRect(0, 0, cssW, cssH * 0.5);
      drawRoad();                                            // road first, car over the top of it
      var car = drawPlayer(now);
      drawDarkness(car);
      drawMarkers();                                         // reflective tape reads through the night
      if (now - hitAt < 380 && !reduced) {                   // impact flash — world layer
        ctx.fillStyle = hexA('#ff3a4e', 0.32 * (1 - (now - hitAt) / 380));
        ctx.fillRect(0, 0, cssW, cssH);
      }
      if (!reduced) {                                        // CRT polish: world only
        ctx.fillStyle = 'rgba(0,0,0,.15)';
        for (var sy = 0; sy < cssH; sy += 3) ctx.fillRect(0, sy, cssW, 1);
      }
      var vig = ctx.createRadialGradient(cssW / 2, cssH / 2, Math.min(cssW, cssH) * 0.3,
        cssW / 2, cssH / 2, Math.max(cssW, cssH) * 0.72);
      vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(0,0,0,.6)');
      ctx.fillStyle = vig; ctx.fillRect(0, 0, cssW, cssH);
      /* HUD sits above the CRT overlay so it stays at full contrast over the vignette.
         A dark halo keeps it legible when a lit road or the car runs behind the text. */
      ctx.shadowColor = hexA(C.bg, 0.9); ctx.shadowBlur = 6;
      var fs = Math.round(clamp(Math.min(cssH * 0.042, cssW * 0.05), 11, 17)), m = Math.max(10, cssW * 0.04);
      var top = Math.max(14, cssH * 0.05), i;
      ctx.textBaseline = 'middle'; ctx.font = '700 ' + fs + 'px Rajdhani, system-ui, sans-serif';
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
        ctx.font = '900 ' + Math.round(fs * 1.35) + 'px Orbitron, system-ui, sans-serif';
        glow(C.magenta, 18); ctx.fillText('COMBO x' + combo, cssW / 2, top + fs * 1.6);
        ctx.shadowBlur = 0; ctx.font = '700 ' + fs + 'px Rajdhani, system-ui, sans-serif';
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
