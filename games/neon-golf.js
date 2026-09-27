/**
 * PIXEL RUSH — games/neon-golf.js — "Neon Golf"
 * Contract (SPEC.md): window.PixelGame = { name, instructions, start(root, api) } where
 * api = { setScore(n), setBest(n), gameOver(score) } and start() returns { destroy() }.
 * Top-down putting: five holes, walls, a slope field that bends the roll, a bent
 * aim preview, per-hole result cards and a running total. One <canvas>, one rAF,
 * every listener and id removed in destroy().
 */
(function () {
  'use strict';
  /* -------------------------------- Tuning -------------------------------- */
  var STORE_KEY = 'pixelrush.neon-golf.best';
  var W = 100, H = 140;            // world units of one hole
  var R = 1.7;                     // ball radius
  var CUP = 2.9;                   // cup radius
  var CAP = 12;                    // max speed the cup will swallow
  var MAXSPD = 46;                 // speed at full power
  var FRICTION = 8.6;              // units/s^2 — constant roll-off
  var REST = 0.62;                 // wall bounce
  var STEP = 1 / 120;              // fixed physics step
  var HOLE_CAP = 8;                // strokes at which a hole is conceded
  var DRAG_MAX = 48;               // world units of drag == 100% power
  var CHARGE_MS = 900;             // space / button hold to full power
  var PREVIEW_STEPS = 330;
  /* -------------------------------- Course -------------------------------- */
  function R_(x, y, w, h) { return { x: x, y: y, w: w, h: h }; }
  function S_(x, y, w, h, dx, dy, s) { return { x: x, y: y, w: w, h: h, dx: dx, dy: dy, s: s }; }
  var HOLES = [
    { par: 2, name: 'THE OPENER', ball: { x: 24, y: 116 }, cup: { x: 76, y: 26 }, walls: [], slopes: [] },
    { par: 3, name: 'THE GATE', ball: { x: 16, y: 122 }, cup: { x: 86, y: 20 },
      walls: [R_(48, 4, 6, 82)], slopes: [S_(0, 96, 100, 44, 1, 0, 0.55)] },
    { par: 3, name: 'THE DRAW', ball: { x: 16, y: 44 }, cup: { x: 84, y: 96 },
      walls: [R_(46, 0, 6, 14), R_(46, 74, 6, 62)], slopes: [S_(52, 0, 48, 140, 0, 1, 1.6)] },
    { par: 4, name: 'THE DOGLEG', ball: { x: 24, y: 122 }, cup: { x: 84, y: 20 },
      walls: [R_(0, 58, 72, 6), R_(72, 64, 6, 40)], slopes: [S_(0, 0, 100, 58, 0, 1, 1.45)] },
    { par: 5, name: 'THE GAUNTLET', ball: { x: 14, y: 112 }, cup: { x: 86, y: 28 },
      walls: [R_(30, 2, 6, 46), R_(30, 68, 6, 70), R_(64, 34, 6, 40), R_(64, 88, 6, 50)],
      slopes: [S_(0, 0, 30, 140, 0, 1, 1.0), S_(36, 0, 28, 140, 1, 0, 0.9), S_(70, 0, 30, 140, -1, 0, 0.5)] }
  ];
  var PAR_TOTAL = 0;
  /* The four course borders are prepended to every hole's wall list, so the
     physics loop can treat "the edge of the green" as just another wall. */
  for (var i = 0; i < HOLES.length; i++) {
    HOLES[i].walls = [R_(0, 0, W, 4), R_(0, H - 4, W, 4), R_(0, 0, 4, H), R_(W - 4, 0, 4, H)].concat(HOLES[i].walls);
    PAR_TOTAL += HOLES[i].par;
  }
  var STYLES = '.ng{position:relative;width:100%;height:100%;overflow:hidden;touch-action:none;' +
    'user-select:none;-webkit-tap-highlight-color:transparent;' +
    'font-family:var(--font-body,"Rajdhani",system-ui,sans-serif);color:var(--ink,#f2f5ff)}' +
    '.ng canvas{display:block;width:100%;height:100%;outline:none}';
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function len(x, y) { return Math.sqrt(x * x + y * y); }
  function readBest() {
    try { var v = parseInt(window.localStorage.getItem(STORE_KEY), 10);
      return isFinite(v) && v > 0 ? v : 0; } catch (e) { return 0; }   // private mode
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
    var setStatus   = typeof api.setStatus === 'function'  ? api.setStatus  : function () {};
    /* -------------------------------- DOM -------------------------------- */
    var wrap = document.createElement('div'); wrap.className = 'ng';
    var canvas = document.createElement('canvas');
    canvas.setAttribute('tabindex', '0'); canvas.setAttribute('role', 'application');
    canvas.setAttribute('aria-label', 'Neon Golf course. Arrow keys aim, hold space for power, release to putt. Drag from the ball on touch.');
    var live = document.createElement('div'); // screen-reader announcements
    live.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0)';
    live.setAttribute('aria-live', 'polite');
    wrap.appendChild(canvas); wrap.appendChild(live);
    var styleTag = document.createElement('style');
    styleTag.textContent = STYLES; wrap.appendChild(styleTag); root.appendChild(wrap);
    var ctx = canvas.getContext('2d');
    if (!ctx) { root.removeChild(wrap); return { destroy: function () {} }; }
    var rafId = 0, destroyed = false;
    var reduced = !!((window.PX && (window.PX.reduced === true || window.PX.motionOn === false)) ||
      (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches));
    /* ------------------------------ State ------------------------------ */
    var hole = HOLES[0], idx = 0, strokes = 0, banked = 0, score = 0, bestEver = readBest();
    var ball = { x: 0, y: 0 }, vel = { x: 0, y: 0 };
    var aim = -Math.PI / 4, power = 0.55, charging = false, chargeT = 0;
    var state = 'ready';           // ready | aim | roll | result | over
    var donePar = 0, doneStrokes = 0;   // completed holes, for the running card line
    var paused = false, over = false, isRecord = false, resultT = 0, lastScore = -1;
    var trail = [], parts = [], ace = false, shake = 0;
    var dragId = -1, dragX = 0, dragY = 0, dragging = false, holdBtn = '';
    var aimKey = 0;                // -1 / +1, continuous arrow-key rotation
    var btn = { rotL: null, rotR: null, putt: null };
    /* ----------------- Sizing (crisp devicePixelRatio) ----------------- */
    var dpr = 1, cssW = 1, cssH = 1, scale = 1, ox = 0, oy = 0, bandY = 0;
    function resize() {
      var r = wrap.getBoundingClientRect();
      cssW = Math.max(1, Math.round(r.width)); cssH = Math.max(1, Math.round(r.height));
      dpr = clamp(window.devicePixelRatio || 1, 1, 2);
      canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
      canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Thumb band eats the bottom strip; the course is letterboxed into the rest.
      bandY = cssH - Math.round(clamp(cssH * 0.14, 50, 82));
      scale = Math.min((cssW - 16) / W, (bandY - 16) / H);
      scale = Math.max(0.2, scale);
      ox = Math.round((cssW - W * scale) / 2);
      oy = Math.round((bandY - H * scale) / 2);
    }
    resize();
    function token(n, fb) {
      var v = getComputedStyle(document.documentElement).getPropertyValue(n);
      return (v && v.trim()) || fb;
    }
    var C = { bg: token('--bg', '#05060f'), ink: token('--ink', '#f2f5ff'), dim: token('--ink-dim', '#a7b0d0'),
      cyan: token('--cyan', '#22e7ff'), magenta: token('--magenta', '#ff2fb9'), acid: token('--acid', '#c8ff2e'),
      orange: token('--orange', '#ff8a3d'), violet: token('--violet', '#8b5cf6') };
    function hexA(hex, a) {
      hex = (hex || '#fff').trim().replace('#', '');
      var n = parseInt(hex, 16);
      return isFinite(n) ? 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')' : 'rgba(255,255,255,' + a + ')';
    }
    function rr(x, y, w, h, r) {
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
    }
    function sx(x) { return ox + x * scale; }
    function sy(y) { return oy + y * scale; }
    function wx(px) { return (px - ox) / scale; }
    function wy(py) { return (py - oy) / scale; }
    /* ---------------------------- Physics ---------------------------- */
    function slopeAt(h, x, y, out) {   // sum of every slope zone the point is inside
      out.x = 0; out.y = 0;
      for (var i = 0; i < h.slopes.length; i++) {
        var s = h.slopes[i];
        if (x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h) { out.x += s.dx * s.s; out.y += s.dy * s.s; }
      }
      return out;
    }
    var _s = { x: 0, y: 0 };
    function collideRect(p, v, r) {   // circle vs AABB, reflect + depenetrate
      var cx = clamp(p.x, r.x, r.x + r.w), cy = clamp(p.y, r.y, r.y + r.h);
      var dx = p.x - cx, dy = p.y - cy, d = len(dx, dy);
      if (d > R) return;
      var nx, ny;
      if (d > 0.0001) { nx = dx / d; ny = dy / d; p.x = cx + nx * R; p.y = cy + ny * R; }
      else { // dead centre: eject along the nearest face
        var m = Math.min(p.x - r.x, r.x + r.w - p.x, p.y - r.y, r.y + r.h - p.y);
        if (m === p.x - r.x) { nx = -1; ny = 0; p.x = r.x - R; }
        else if (m === r.x + r.w - p.x) { nx = 1; ny = 0; p.x = r.x + r.w + R; }
        else if (m === p.y - r.y) { nx = 0; ny = -1; p.y = r.y - R; }
        else { nx = 0; ny = 1; p.y = r.y + r.h + R; }
      }
      var dot = v.x * nx + v.y * ny;
      if (dot < 0) { v.x -= (1 + REST) * dot * nx; v.y -= (1 + REST) * dot * ny; }
      var sp = len(v.x, v.y); if (sp > MAXSPD) { v.x = v.x / sp * MAXSPD; v.y = v.y / sp * MAXSPD; }
    }
    function stepPhys(h, p, v, dt) {  // one fixed step; shared by the sim and the preview
      slopeAt(h, p.x, p.y, _s);
      v.x += _s.x * dt; v.y += _s.y * dt;
      // The cup is a shallow well with a flat-ish floor: strong enough to gather a ball
      // that stops nearby (so a good line always drops), far too weak to swallow a
      // fast one, and tuned so the pull itself never pushes a ball past CAP.
      var cx = h.cup.x - p.x, cy = h.cup.y - p.y, cd = len(cx, cy), well = CUP * 3;
      if (cd > 0.0001 && cd < well) { var g = 16 * (1 - cd / well); v.x += (cx / cd) * g * dt; v.y += (cy / cd) * g * dt; }
      var sp = len(v.x, v.y);
      if (sp > 0) { var ns = sp - FRICTION * dt; if (ns < 0) ns = 0; v.x = v.x / sp * ns; v.y = v.y / sp * ns; }
      p.x += v.x * dt; p.y += v.y * dt;
      for (var i = 0; i < h.walls.length; i++) collideRect(p, v, h.walls[i]);
    }
    function previewPath() {        // bent aim line: the same physics, drawn forward
      var pts = [], p = { x: ball.x, y: ball.y };
      var sp = power * MAXSPD, v = { x: Math.cos(aim) * sp, y: Math.sin(aim) * sp };
      pts.push(p);
      for (var i = 0; i < PREVIEW_STEPS; i++) {
        stepPhys(hole, p, v, STEP);
        if (i % 4 === 0) pts.push({ x: p.x, y: p.y });
        if (len(v.x, v.y) < 0.6) break;
      }
      pts.push({ x: p.x, y: p.y });
      return pts;
    }
    /* --------------------------- Run / holes --------------------------- */
    function loadHole(i) {
      idx = i; hole = HOLES[i];
      ball.x = hole.ball.x; ball.y = hole.ball.y; vel.x = 0; vel.y = 0;
      strokes = 0; trail.length = 0; parts.length = 0; ace = false; shake = 0;
      aim = Math.atan2(hole.cup.y - ball.y, hole.cup.x - ball.x);
      power = 0.55; charging = false; chargeT = 0;
      state = 'aim'; resultT = 0;
      updateScore();
      live.textContent = 'Hole ' + (i + 1) + ' of ' + HOLES.length + ', ' + hole.name + ', par ' + hole.par + '.';
    }
    function updateScore() {
      // SCORE is committed points only — the holes already holed out. A mid-hole
      // estimate would fall with every extra stroke and would let a round that
      // never finished write a "best" that outlives it, so the projection is gone:
      // points land when a hole closes and the record is written from that value.
      score = banked;
      if (score !== lastScore) { lastScore = score; setScore(score); }
      if (score > bestEver) { bestEver = score; isRecord = true; writeBest(score); setBest(score); }
    }
    function resetRun() {
      banked = 0; score = 0; lastScore = -1; isRecord = false; over = false;
      donePar = 0; doneStrokes = 0;
      paused = false; aimKey = 0; dragging = false; holdBtn = '';
      if (bestEver) setBest(bestEver); else setBest(0);
      loadHole(0);
    }
    function putt(p) {
      if (destroyed || state !== 'aim' || p < 0.08) return;   // a stray tap never putts
      power = clamp(p, 0.06, 1); strokes++;
      vel.x = Math.cos(aim) * power * MAXSPD; vel.y = Math.sin(aim) * power * MAXSPD;
      trail.length = 0; state = 'roll'; charging = false; chargeT = 0;
      updateScore();
      live.textContent = 'Stroke ' + strokes + ' on hole ' + (idx + 1) + '.';
    }
    function finishHole(conceded) {  // called when the ball drops or the hole is picked up
      ace = strokes === 1;
      donePar += hole.par; doneStrokes += strokes;
      // 110 per stroke under par+2: the old banked 100 plus the 10 the removed
      // mid-hole projection used to add on the closing stroke, so every final
      // per-hole and round score is unchanged.
      banked += Math.max(0, hole.par + 2 - strokes) * 110 + (ace ? 500 : 0);
      state = 'result'; resultT = 0; charging = false; power = 0;
      vel.x = 0; vel.y = 0;
      if (!reduced && ace) for (var i = 0; i < 46; i++) {
        var a = Math.random() * Math.PI * 2, s = 6 + Math.random() * 26;
        parts.push({ x: sx(hole.cup.x), y: sy(hole.cup.y), vx: Math.cos(a) * s, vy: Math.sin(a) * s, t: 0, c: i % 2 ? C.acid : C.cyan });
      }
      if (ace) shake = 1;
      updateScore();
      live.textContent = conceded
        ? 'Picked up on hole ' + (idx + 1) + ' after ' + HOLE_CAP + ' strokes.'
        : (ace ? 'Hole in one on hole ' : 'Holed in ') + strokes + (ace ? '.' : ' strokes on hole ' + (idx + 1) + '.');
    }
    function nextHole() {
      if (idx + 1 < HOLES.length) { loadHole(idx + 1); return; }
      state = 'over';
      if (!over) { over = true; setStatus('Game Over'); gameOverCb(score); }   // fires exactly once
    }
    function tick(dt) {
      if (state === 'aim') {
        // Aim sweeps from the arrow keys (held) or the on-canvas turn buttons (held).
        if (holdBtn === 'rotL') aim -= 2.0 * dt;
        else if (holdBtn === 'rotR') aim += 2.0 * dt;
        else if (aimKey) aim += aimKey * 2.1 * dt;
        if (charging) { chargeT += dt; power = clamp(chargeT / (CHARGE_MS / 1000), 0.06, 1); }
      } else if (state === 'roll') {
        // Step by the frame's real elapsed time (dt is clamped in frame()), and test
        // the cup after EVERY substep or a quick ball tunnels straight through it.
        var n = Math.min(12, Math.max(1, Math.round(dt / STEP))), sp2;
        for (var i = 0; i < n; i++) {
          stepPhys(hole, ball, vel, STEP);
          sp2 = len(vel.x, vel.y);
          if (len(hole.cup.x - ball.x, hole.cup.y - ball.y) < CUP && sp2 < CAP) { finishHole(false); return; }
          if (sp2 < 0.4) break;
        }
        trail.unshift({ x: sx(ball.x), y: sy(ball.y) });
        if (trail.length > (reduced ? 0 : 14)) trail.pop();
        if (len(vel.x, vel.y) < 0.4) {
          vel.x = 0; vel.y = 0; state = 'aim';   // the ball rests where it stopped
          if (strokes >= HOLE_CAP) { strokes = HOLE_CAP; finishHole(true); }
          else { power = 0.55; updateScore(); }
        }
      } else if (state === 'result') {
        resultT += dt;
        for (var j = 0; j < parts.length; j++) { var p = parts[j]; p.t += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 90 * dt; }
        if (shake > 0) shake = Math.max(0, shake - dt * 1.6);
      }
    }
    /* ---------------------------- Drawing ---------------------------- */
    function drawCourse() {
      var w = W * scale, h = H * scale, x = ox, y = oy;
      ctx.save(); rr(x, y, w, h, Math.min(16, 6 * scale)); ctx.clip();
      ctx.fillStyle = 'rgba(255,255,255,.028)'; ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = hexA(C.cyan, 0.06); ctx.lineWidth = 1; ctx.beginPath();
      for (var g = 10; g < W; g += 10) { ctx.moveTo(sx(g), y); ctx.lineTo(sx(g), y + h); }
      for (var k = 10; k < H; k += 10) { ctx.moveTo(x, sy(k)); ctx.lineTo(x + w, sy(k)); }
      ctx.stroke();
      // Slope zones: violet wash plus a clipped diagonal hatch so the bend reads at 390px.
      for (var i = 0; i < hole.slopes.length; i++) {
        var s = hole.slopes[i], x0 = sx(s.x), y0 = sy(s.y), x1 = sx(s.x + s.w), y1 = sy(s.y + s.h);
        ctx.fillStyle = hexA(C.violet, 0.13); ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        var step = Math.max(6, 9 * scale), span = (y1 - y0);
        ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, x1 - x0, span); ctx.clip();
        ctx.strokeStyle = hexA(C.violet, 0.45); ctx.lineWidth = 1.5; ctx.beginPath();
        for (var d = -span; d < (x1 - x0); d += step) {
          ctx.moveTo(x0 + d, y0); ctx.lineTo(x0 + d + span, y1);
          ctx.moveTo(x0 + d + span, y0); ctx.lineTo(x0 + d, y1);
        }
        ctx.stroke(); ctx.restore();
      }
      if (!reduced) for (var t = 0; t < trail.length; t++) {   // decaying roll trail
        var a = (1 - t / trail.length) * 0.32;
        ctx.fillStyle = hexA(C.cyan, a);
        ctx.beginPath(); ctx.arc(trail[t].x, trail[t].y, R * scale * (1 - t / trail.length * 0.5), 0, 6.2832); ctx.fill();
      }
      ctx.restore();
      ctx.save(); rr(x, y, w, h, Math.min(16, 6 * scale));
      ctx.strokeStyle = hexA(C.cyan, 0.3); ctx.lineWidth = 2;
      ctx.shadowColor = hexA(C.cyan, 0.55); ctx.shadowBlur = 16; ctx.stroke(); ctx.restore();
      // Walls
      for (var q = 0; q < hole.walls.length; q++) {
        var wq = hole.walls[q];
        ctx.save();
        ctx.shadowColor = hexA(C.magenta, 0.8); ctx.shadowBlur = 14;
        ctx.fillStyle = hexA(C.magenta, 0.28);
        ctx.strokeStyle = C.magenta; ctx.lineWidth = 1.5;
        rr(sx(wq.x), sy(wq.y), wq.w * scale, wq.h * scale, Math.min(6, 2 * scale));
        ctx.fill(); ctx.stroke(); ctx.restore();
      }
      // Cup: acid ring + flag, pulsing unless motion is reduced
      var beat = reduced ? 1 : 0.85 + 0.15 * Math.sin(performance.now() / 260);
      var cxp = sx(hole.cup.x), cyp = sy(hole.cup.y), cupR = CUP * scale;
      ctx.save();
      ctx.shadowColor = hexA(C.acid, 0.9); ctx.shadowBlur = 24;
      ctx.strokeStyle = C.acid; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cxp, cyp, cupR * beat, 0, 6.2832); ctx.stroke();
      ctx.globalAlpha = 0.4; ctx.beginPath(); ctx.arc(cxp, cyp, cupR * 2.1, 0, 6.2832); ctx.stroke();
      ctx.restore();
    }
    function drawAim() {
      if (state !== 'aim' || paused) return;
      var pts = previewPath(), bx = sx(ball.x), by = sy(ball.y);
      ctx.save();
      ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.shadowColor = hexA(C.cyan, 0.8); ctx.shadowBlur = 12;
      for (var i = 1; i < pts.length; i++) {
        ctx.strokeStyle = hexA(i < pts.length * 0.4 ? C.acid : C.cyan, 0.25 + 0.7 * (i / pts.length));
        ctx.beginPath(); ctx.moveTo(sx(pts[i - 1].x), sy(pts[i - 1].y)); ctx.lineTo(sx(pts[i].x), sy(pts[i].y)); ctx.stroke();
      }
      ctx.shadowBlur = 0;
      var ex = sx(pts[pts.length - 1].x), ey = sy(pts[pts.length - 1].y);
      ctx.fillStyle = C.acid; ctx.beginPath(); ctx.arc(ex, ey, 2.5, 0, 6.2832); ctx.fill();
      ctx.restore();
      // Power bar just under the ball
      var bw = 34, bhh = 4, bxx = bx - bw / 2, byy = by + R * scale + 7;
      ctx.fillStyle = hexA(C.ink, 0.2); rr(bxx, byy, bw, bhh, 2); ctx.fill();
      ctx.save(); ctx.shadowColor = hexA(C.orange, 0.8); ctx.shadowBlur = 10;
      ctx.fillStyle = power > 0.85 ? C.magenta : C.orange;
      rr(bxx, byy, Math.max(2, bw * power), bhh, 2); ctx.fill(); ctx.restore();
    }
    function drawBall() {
      if (state === 'result' || state === 'over') return;
      var bx = sx(ball.x), by = sy(ball.y);
      ctx.save();
      ctx.shadowColor = C.cyan; ctx.shadowBlur = 20; ctx.fillStyle = C.cyan;
      ctx.beginPath(); ctx.arc(bx, by, R * scale, 0, 6.2832); ctx.fill();
      ctx.shadowBlur = 0; ctx.fillStyle = C.bg;
      ctx.beginPath(); ctx.arc(bx, by, R * scale * 0.42, 0, 6.2832); ctx.fill();
      ctx.restore();
    }
    function fitFont(str, avail, start, weight, family) {   // largest size <= start at which `str` fits `avail`
      var w = weight || 700, fam = family || 'Rajdhani, system-ui, sans-serif';
      var fs = start;
      for (; fs > 9; fs--) {
        ctx.font = w + ' ' + fs + 'px ' + fam;
        if (ctx.measureText(str).width <= avail) return fs;
      }
      ctx.font = w + ' 9px ' + fam;
      return 9;
    }
    function tw(s) { return ctx.measureText(s).width; }
    function drawHud() {
      var top = Math.max(14, oy * 0.5 + 6), edge = 10, gap = 12;
      var start = Math.round(clamp(Math.min(cssH * 0.045, cssW * 0.05), 11, 17));
      // Opposed readouts are laid out against the space each one actually owns
      // rather than against a shared total, so the two can never print over each
      // other: a left-aligned string may grow until it reaches the centre line and
      // a right-aligned one until it reaches the centre from the other side.
      var half = Math.max(24, cssW / 2 - edge - gap);
      var l1 = 'HOLE ' + (idx + 1) + '/' + HOLES.length + '  PAR ' + hole.par;
      var r1 = 'STROKES ' + strokes;
      var fs = Math.min(fitFont(l1, half, start), fitFont(r1, half, start));
      ctx.font = '700 ' + fs + 'px Rajdhani, system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      // A soft dark halo keeps every readout legible wherever the course sits behind it.
      ctx.shadowColor = 'rgba(0,0,0,.9)'; ctx.shadowBlur = 5;
      ctx.fillStyle = C.ink; ctx.textAlign = 'left';
      ctx.fillText(l1, edge, top);
      ctx.textAlign = 'right';
      ctx.fillStyle = strokes > hole.par ? C.orange : C.acid;
      ctx.fillText(r1, cssW - edge, top);
      // Line two seats three strings: the flanking pair is shrunk to leave a middle
      // slot, and the centred string is only drawn when it genuinely fits that slot
      // (shrunk to the pair's size, or dropped entirely on a very narrow canvas).
      var cardName = donePar ? (doneStrokes - donePar === 0 ? 'EVEN' : (doneStrokes - donePar > 0 ? '+' : '') + (doneStrokes - donePar)) : 'E';
      var s2 = 'SCORE ' + score, c2 = 'CARD ' + cardName + '  ·  PAR ' + PAR_TOTAL, b2 = 'BEST ' + bestEver;
      var fs2 = Math.min(fitFont(s2, half, Math.max(9, Math.round(fs * 0.92))),
                         fitFont(b2, half, Math.max(9, Math.round(fs * 0.92))));
      ctx.font = '700 ' + fs2 + 'px Rajdhani, system-ui, sans-serif';
      var free = cssW - 2 * edge - 2 * gap - tw(s2) - tw(b2);
      var cfs = free > 0 ? fitFont(c2, free, fs2) : 9;
      if (free <= 0 || tw(c2) > free) c2 = null;
      var y2 = top + fs * 1.3;
      ctx.font = '700 ' + fs2 + 'px Rajdhani, system-ui, sans-serif';
      ctx.textAlign = 'left'; ctx.fillStyle = C.cyan;
      ctx.fillText(s2, edge, y2);
      if (c2) {
        ctx.font = '700 ' + cfs + 'px Rajdhani, system-ui, sans-serif';
        ctx.textAlign = 'center'; ctx.fillStyle = C.dim;
        ctx.fillText(c2, cssW / 2, y2);
      }
      ctx.font = '700 ' + fs2 + 'px Rajdhani, system-ui, sans-serif';
      ctx.textAlign = 'right'; ctx.fillStyle = C.dim;
      ctx.fillText(b2, cssW - edge, y2);
      ctx.shadowBlur = 0; ctx.shadowColor = 'rgba(0,0,0,0)';
    }
    function drawButtons() {
      if (state !== 'aim') return;
      var h = cssH - bandY, pad = 8, bh = h - 16, bw = Math.min(96, (cssW - pad * 4) * 0.24);
      if (bw < 44) return;                                  // too cramped to be usable
      var cy = bandY + 8, lbl = Math.max(10, Math.round(bh * 0.3));
      btn.rotL = { x: pad, y: cy, w: bw, h: bh };
      btn.rotR = { x: pad * 2 + bw, y: cy, w: bw, h: bh };
      btn.putt = { x: cssW - pad - bw * 1.5, y: cy, w: bw * 1.5, h: bh };
      var set = [['◀', btn.rotL, C.cyan], ['▶', btn.rotR, C.cyan], [charging ? 'PULL…' : 'PUTT', btn.putt, C.acid]];
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (var i = 0; i < set.length; i++) {
        var r = set[i][1];
        // The label is fitted to the button it sits in, so a narrow phone band
        // shrinks the glyphs instead of letting them spill past the rounded edge.
        var fl = fitFont(set[i][0], r.w - 12, lbl);
        ctx.font = '700 ' + fl + 'px Rajdhani, system-ui, sans-serif';
        ctx.save();
        ctx.shadowColor = set[i][2]; ctx.shadowBlur = 12;
        ctx.fillStyle = hexA(set[i][2], 0.12); ctx.strokeStyle = hexA(set[i][2], 0.65); ctx.lineWidth = 1.5;
        rr(r.x, r.y, r.w, r.h, 10); ctx.fill(); ctx.stroke();
        ctx.fillStyle = set[i][2]; ctx.fillText(set[i][0], r.x + r.w / 2, r.y + r.h / 2);
        ctx.restore();
      }
    }
    /* Card copy is sized from the SHORTER edge of the stage. A portrait phone gets a
       stage TALLER than it is wide, so cssH alone is the larger dimension and the
       type balloons until the title and the hint run off both edges. Width caps it,
       and fitFont shrinks it again until every line is measurably inside the frame;
       a line too long for even the smallest size is broken on its own '\n'. */
    function cardLines(str, y0, avail, start, weight, family, color) {
      var parts = String(str).split('\n'), fs = start, i, j;
      for (i = 0; i < parts.length; i++)
        for (j = 0; j < parts[i].length; j++) fs = Math.min(fs, fitFont(parts[i], avail, fs, weight, family));
      ctx.fillStyle = color;
      for (i = 0; i < parts.length; i++) {
        ctx.font = weight + ' ' + fs + 'px ' + family;
        ctx.fillText(parts[i], cssW / 2, y0 + i * fs * 1.3);
      }
    }
    function card(title, sub, color, hint) {
      var avail = cssW - 24;
      ctx.fillStyle = hexA(C.bg, 0.78); ctx.fillRect(0, 0, cssW, cssH);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      var tfs = Math.round(clamp(Math.min(cssH * 0.11, cssW * 0.16), 18, 54));
      var sfs = Math.round(clamp(Math.min(cssH * 0.05, cssW * 0.055), 11, 22));
      ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 28;
      ctx.font = '900 ' + fitFont(title, avail, tfs, 900, 'Orbitron, system-ui, sans-serif') + 'px Orbitron, system-ui, sans-serif';
      ctx.fillText(title, cssW / 2, cssH * 0.4); ctx.shadowBlur = 0;
      cardLines(sub, cssH * 0.5, avail, sfs, 600, 'Rajdhani, system-ui, sans-serif', C.ink);
      if (hint) cardLines(hint, cssH * 0.6, avail, sfs, 600, 'Rajdhani, system-ui, sans-serif', C.dim);
    }
    function draw() {
      var w = cssW, h = cssH;
      ctx.save();
      if (shake > 0 && !reduced) ctx.translate((Math.random() - 0.5) * 6 * shake, (Math.random() - 0.5) * 6 * shake);
      ctx.fillStyle = C.bg; ctx.fillRect(-10, -10, w + 20, h + 20);
      drawCourse(); drawAim(); drawBall();
      if (state === 'roll' || state === 'result') {            // particle burst (aces only)
        for (var i = 0; i < parts.length; i++) {
          var p = parts[i]; if (p.t > 1.5) continue;
          ctx.save(); ctx.globalAlpha = Math.max(0, 1 - p.t / 1.5);
          ctx.fillStyle = p.c; ctx.shadowColor = p.c; ctx.shadowBlur = 10;
          ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3); ctx.restore();
        }
      }
      // CRT treatment belongs to the world layer: scanlines then the radial vignette,
      // both applied before the HUD so the readouts and buttons stay bright over them.
      if (!reduced) { ctx.fillStyle = 'rgba(0,0,0,.15)';
        for (var sy2 = 0; sy2 < h; sy2 += 3) ctx.fillRect(0, sy2, w, 1); }
      var vig = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.32, w / 2, h / 2, Math.max(w, h) * 0.72);
      vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(0,0,0,.55)');
      ctx.fillStyle = vig; ctx.fillRect(0, 0, w, h);
      ctx.restore();
      drawHud(); drawButtons();
      if (state === 'ready') card('NEON GOLF', HOLES.length + ' HOLES · PAR ' + PAR_TOTAL, C.cyan,
        'HOLE 1 · ' + hole.name + ' · PAR ' + hole.par + '\nTAP or press SPACE to tee off');
      else if (paused && state !== 'over') card('PAUSED', 'Tap or press a key to resume', C.cyan, null);
      else if (state === 'result') {
        var d = strokes - hole.par, label = d <= -2 ? 'EAGLE' : d === -1 ? 'BIRDIE' : d === 0 ? 'PAR' : d === 1 ? 'BOGEY' : 'DOUBLE BOGEY+';
        card(ace ? 'HOLE IN ONE!' : label, 'HOLE ' + (idx + 1) + ' — ' + hole.name + ' · ' + strokes + ' STROKE' + (strokes === 1 ? '' : 'S'),
          ace ? C.acid : (d <= 0 ? C.cyan : C.orange), 'TAP or press SPACE to continue');
      }
      else if (state === 'over') card('ROUND OVER', 'FINAL SCORE ' + score + (isRecord ? '  ·  NEW BEST' : ''), C.magenta,
        'TAP or press SPACE to play again');
    }
    /* -------------------------- Single rAF loop -------------------------- */
    var last = 0;
    function frame(now) {
      if (destroyed) return;   // guard: destroy() can land between frames
      var dt = last ? Math.min(80, now - last) : 16;   // clamp so a backgrounded tab cannot fast-forward
      last = now;
      if (!paused && !over) tick(dt / 1000);
      if (destroyed) return;   // tick can reach gameOver() -> shell may destroy() us
      draw();
      if (destroyed) return;
      rafId = requestAnimationFrame(frame);
    }
    /* ------------------- Input: buttons, drag, keyboard ------------------- */
    function inBtn(r, x, y) { return !!r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h; }
    function localPt(e) {
      var r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }
    function resume() { if (paused) { paused = false; setStatus('Playing'); } }
    function confirm() {        // tap / space advances result, restarts a dead round
      if (destroyed) return;
      resume();
      if (state === 'result') { if (resultT > 0.45) nextHole(); return; }
      if (state === 'over') { resetRun(); return; }
      if (state === 'ready') { state = 'aim'; return; }
    }
    function onPointerDown(e) {
      if (e.button !== undefined && e.button > 0) return;
      var p = localPt(e);
      if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
      paused = false;
      setStatus('Playing');
      if (state === 'ready' || state === 'over' || state === 'result') { confirm(); return; }
      if (state !== 'aim') return;
      if (inBtn(btn.rotL, p.x, p.y)) { holdBtn = 'rotL'; aim -= 0.32; return; }
      if (inBtn(btn.rotR, p.x, p.y)) { holdBtn = 'rotR'; aim += 0.32; return; }
      if (inBtn(btn.putt, p.x, p.y)) { holdBtn = 'putt'; charging = true; chargeT = 0; power = 0.06; return; }
      // Drag anywhere on the course: direction + power, release to putt.
      dragId = e.pointerId; dragging = true;
      dragX = p.x; dragY = p.y; power = 0.06;
    }
    function onPointerMove(e) {
      if (destroyed || !dragging || e.pointerId !== dragId || state !== 'aim') return;
      var p = localPt(e), dx = wx(p.x) - wx(dragX), dy = wy(p.y) - wy(dragY), d = len(dx, dy);
      if (d < 3) return;
      aim = Math.atan2(dy, dx); power = clamp(d / DRAG_MAX, 0.06, 1);
    }
    function onPointerUp(e) {
      if (e.pointerId !== dragId && !holdBtn) return;
      if (holdBtn) { if (holdBtn === 'putt') putt(power); holdBtn = ''; }
      else if (dragging) { dragging = false; putt(power); }
      dragId = -1;
      if (state === 'aim') power = Math.max(0.06, power);
    }
    function onPointerCancel() { dragId = -1; dragging = false; holdBtn = ''; charging = false; }
    function onKeyDown(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var a = document.activeElement;
      if (a && a !== canvas && /^(BUTTON|INPUT|SELECT|TEXTAREA|A|SUMMARY)$/.test(a.tagName)) return;
      var c = e.code;
      if (c === 'ArrowLeft' || c === 'KeyA') { e.preventDefault(); aimKey = -1; return; }
      if (c === 'ArrowRight' || c === 'KeyD') { e.preventDefault(); aimKey = 1; return; }
      if (c === 'ArrowUp' || c === 'ArrowDown') {   // fine trim: 0.6° per press
        e.preventDefault();
        if (state === 'aim') aim += (c === 'ArrowUp' ? -1 : 1) * 0.0105;
        return;
      }
      if (c === 'Space' || c === 'Enter') {
        e.preventDefault();
        if (e.repeat) return;
        if (state === 'ready' || state === 'over') { confirm(); return; }
        if (state === 'result') { confirm(); return; }
        if (state === 'aim' && !charging) { charging = true; chargeT = 0; power = 0.06; }
      }
    }
    function onKeyUp(e) {
      if (e.code === 'ArrowLeft' || e.code === 'KeyA') { if (aimKey === -1) aimKey = 0; return; }
      if (e.code === 'ArrowRight' || e.code === 'KeyD') { if (aimKey === 1) aimKey = 0; return; }
      if ((e.code === 'Space' || e.code === 'Enter') && charging) { putt(power); charging = false; }
    }
    function onResize() { if (!destroyed) resize(); }
    function onBlur() { if (!destroyed) { paused = true; setStatus('Paused'); aimKey = 0; charging = false; holdBtn = ''; } }
    function onVisibility() { if (document.hidden) onBlur(); }
    // Every listener the game owns, in one table so teardown cannot miss one.
    var BIND = [[document, 'keydown', onKeyDown], [document, 'keyup', onKeyUp],
      [canvas, 'pointerdown', onPointerDown], [canvas, 'pointermove', onPointerMove],
      [canvas, 'pointerup', onPointerUp], [canvas, 'pointercancel', onPointerCancel],
      [window, 'resize', onResize, { passive: true }], [window, 'orientationchange', onResize],
      [window, 'blur', onBlur], [document, 'visibilitychange', onVisibility]];
    BIND.forEach(function (b) { b[0].addEventListener(b[1], b[2], b[3]); });
    setBest(bestEver);
    loadHole(0);
    state = 'ready';   // a tap or SPACE tees off
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
    name: 'Neon Golf',
    instructions:
      'Five holes. Aim with the ARROW KEYS (left/right sweep the line, up/down fine trim), HOLD SPACE to ' +
      'build power and RELEASE to putt. On touch, drag from the ball toward your target — direction and ' +
      'distance set the shot, release to putt — or use the on-screen turn and PUTT buttons. The dashed ' +
      'preview bends exactly where the slope will bend the roll, and the cup is a shallow well, so a ball ' +
      'that arrives too fast runs past instead of dropping. Every stroke under par+2 is worth points on ' +
      'the spot and a hole in one pays 500. Eight strokes and the hole is conceded. TAP or SPACE continues ' +
      'to the next hole and restarts after the round. Best score is saved on this device.',
    start: start
  };
})();
