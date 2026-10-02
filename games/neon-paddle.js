/**
 * PIXEL RUSH — games/neon-paddle.js — "Neon Paddle", a one-paddle breakout.
 * Contract (SPEC.md §"games/reaction.js contract"):
 *   window.PixelGame = { name, instructions, start(root, api) -> { destroy() } }
 *   api = { setScore(n), setBest(n), gameOver(score) }. No imports, no deps, no
 *   assets, one 2D canvas; every rAF id and listener dies in destroy().
 */
(function () {
  'use strict';
  var STORE_KEY = 'pixelrush.neon-paddle.best', LIVES_MAX = 3, ROWS = 5, COLS = 9;
  var BALL_R = 0.014, BALL_MIN = 0.34, BALL_MAX = 1.15;   // stage-heights per second
  var RALLY_STEP = 0.028, KEY_SPEED = 0.85, EASE = 26;    // hit boost, key aim, paddle chase
  var PAD_H = 0.022, PAD_W = 0.16, PAD_Y = 0.90;
  // Brick types: `hp` is hits to destroy, `pts` is paid on destruction.
  var TYPES = [{ color: 'cyan', hp: 1, pts: 50 }, { color: 'magenta', hp: 1, pts: 100 },
    { color: 'violet', hp: 2, pts: 140 }, { color: 'acid', hp: 3, pts: 300 }];
  var FALLBACK = { bg: '#05060f', ink: '#f2f5ff', dim: '#a7b0d0', mute: '#6b7599',
    cyan: '#22e7ff', magenta: '#ff2fb9', acid: '#c8ff2e', violet: '#8b5cf6', orange: '#ff8a3d' };
  // STYLE BLOCK — `np-` prefixed and scoped to the wrapper this file creates, so
  // it can never collide with base.css / games.css.
  var STYLES = ['.np{position:relative;width:100%;height:100%;overflow:hidden;user-select:none;',
    '-webkit-user-select:none;color:var(--ink,#f2f5ff);}',
    '.np canvas{display:block;width:100%;height:100%;touch-action:none;cursor:none;}',
    '.np__sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;clip:rect(0 0 0 0);overflow:hidden;}'].join('\n');
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function readBest() {
    try { var v = parseInt(window.localStorage.getItem(STORE_KEY), 10); return isFinite(v) && v > 0 ? v : 0; }
    catch (e) { return 0; } }                                   // private mode / disabled storage
  function writeBest(n) { try { window.localStorage.setItem(STORE_KEY, String(n)); } catch (e) { /* ignore */ } }
  /** start(root, api) — build the game inside `root` and return { destroy }. */
  function start(root, api) {
    api = api || {};
    var setScore = typeof api.setScore === 'function' ? api.setScore : function () {};
    var setBest = typeof api.setBest === 'function' ? api.setBest : function () {};
    var overCb = typeof api.gameOver === 'function' ? api.gameOver : function () {};
    // Decorative motion is optional; the game is not. Site toggle first, OS second.
    var mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    var reduced = !!(window.PX && window.PX.reduced) || !!(mq && mq.matches);
    var wrap = document.createElement('div');
    wrap.className = 'np';
    var canvas = document.createElement('canvas');
    canvas.setAttribute('tabindex', '0');
    canvas.setAttribute('role', 'application');
    canvas.setAttribute('aria-label', 'Neon Paddle. Steer with mouse, drag, arrows or A/D. Space serves.');
    var live = document.createElement('div');                  // screen-reader feedback
    live.className = 'np__sr'; live.setAttribute('aria-live', 'polite');
    var styleTag = document.createElement('style');
    styleTag.textContent = STYLES;
    wrap.appendChild(styleTag); wrap.appendChild(canvas); wrap.appendChild(live); root.appendChild(wrap);
    var ctx = canvas.getContext('2d');
    if (!ctx) { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); return { destroy: function () {} }; }

    var SERVE = 0, PLAY = 1, OVER = 2, state = SERVE;
    var rafId = 0, destroyed = false, over = false;          // `over` latches gameOver()
    var paused = false, prevTime = 0, elapsed = 0, score = 0, lives = LIVES_MAX, wave = 1, rally = 0;
    var bricks = [], bricksLeft = 0, trail = [], listeners = [], best = readBest();
    var flashUntil = 0, flashText = '', flashColor = '#22e7ff', shakeUntil = 0, shakeMag = 0;
    // Paddle aim lives in normalised units; ball and field geometry are CSS pixels,
    // all derived from the live size, so a resize never distorts a run.
    var bx = 0.5, by = 0.5, vx = 0, vy = 0, speed = 0, px = 0.5, aim = 0.5, keyL = false, keyR = false;
    function on(t, type, fn) { t.addEventListener(type, fn); listeners.push([t, type, fn]); }
    /* ---- Sizing: crisp devicePixelRatio, capped at 3 for 3x phones ---- */
    // `sizeGen` stamps the offscreen layers; a resize invalidates every one of them.
    var dpr = 1, cssW = 1, cssH = 1, sizeGen = 0;
    var L = { field: null, fldY: 0, fldDirty: true, fldGen: -1, layers: null,       // baked brick wall
      ball: null, ballM: 0, disc: null, discR: 0, actGen: -1,                      // ball + trail dot
      paddle: null, paddleM: 0, plate: null, pips: null, pipX: 0, pipY: 0,
      hudGen: -1, hudLives: -1, vig: null, vigGen: -1 };
    function resize() {
      var r = wrap.getBoundingClientRect();
      cssW = Math.max(1, Math.round(r.width)); cssH = Math.max(1, Math.round(r.height));
      dpr = clamp(window.devicePixelRatio || 1, 1, 3);
      canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
      canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sizeGen++;
    }
    resize();
    var C = {};                                               // site tokens, with fallbacks
    Object.keys(FALLBACK).forEach(function (k) {
      var v = getComputedStyle(document.documentElement).getPropertyValue('--' + k);
      C[k] = (v && v.trim()) || FALLBACK[k];
    });
    function hexA(hex, a) {                                    // #rrggbb + alpha -> rgba()
      hex = hex.replace('#', '');
      if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
      var n = parseInt(hex, 16);
      return isFinite(n) ? 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')' : 'rgba(255,255,255,' + a + ')';
    }
    /* ---- Field layout: derived from the live size, so the game letterboxes ---- */
    // Geometry only. Bricks are pushed row-major, so index -> (row, col).
    function layoutBricks() {
      var pad = cssW * 0.05, cell = (cssW - pad * 2) / COLS, top = cssH * 0.20;   // 0.20h leaves the HUD its band
      var bh = Math.min(cell * 0.5, cssH * 0.055), gap = Math.max(2, bh * 0.22), i, b;
      for (i = 0; i < bricks.length; i++) {
        b = bricks[i];
        b.x = pad + (i % COLS) * cell; b.y = top + Math.floor(i / COLS) * (bh + gap);
        b.w = cell - Math.max(3, cell * 0.09); b.h = bh;
      }
      L.fldDirty = true;                                       // the wall moved: rebake it
    }
    function buildWave() {
      var r, c, idx, t;
      bricks = []; bricksLeft = 0;
      for (r = 0; r < ROWS; r++) for (c = 0; c < COLS; c++) {
        idx = r === 4 ? 3 : (r === 0 ? 0 : ((r + wave) % 3 === 0 ? 2 : 1));      // back row is the tank
        if (wave === 1 && r === 3) idx = 1;
        if (wave > 2 && r === 2 && (c + wave) % 2 === 0) idx = 3;                 // later waves mix reactors
        t = TYPES[idx];
        bricks.push({ x: 0, y: 0, w: 0, h: 0, t: t, hp: t.hp, max: t.hp });
        bricksLeft++;
      }
      layoutBricks();
    }
    function parkBall(right) {
      var s = cssH * BALL_MIN, d = right ? 1 : -1;
      bx = px * cssW; by = cssH * PAD_Y - cssH * BALL_R * 2.4; speed = s; trail.length = 0; state = SERVE;
      vx = s * 0.5 * d; vy = -s * Math.sqrt(0.75);
    }
    function resetRun() {
      score = 0; lives = LIVES_MAX; wave = 1; rally = 0; over = false; px = aim = 0.5; paused = false;
      buildWave(); parkBall(true); setScore(0); setBest(best); live.textContent = 'Wave 1. Three lives.';
    }
    // `elapsed` is seconds, so the ms arguments are converted once, here.
    function flash(text, color, ms) { flashText = text; flashColor = color; flashUntil = elapsed + ms / 1000; }
    function shake(mag, ms) { shakeMag = mag; shakeUntil = elapsed + ms / 1000; }

    /* ---- Physics: sub-stepped so a fast ball never tunnels a thin brick ---- */
    function stepBall(dt) {
      var r = cssH * BALL_R, padY = cssH * PAD_Y, ph = cssH * PAD_H / 2, hw = cssW * PAD_W / 2;
      var n = Math.min(8, Math.max(1, Math.ceil(dt / 0.008))), h = dt / n, i, j, b;
      for (i = 0; i < n; i++) {
        bx += vx * h; by += vy * h;
        if (bx - r < 0) { bx = r; vx = Math.abs(vx); }
        if (bx + r > cssW) { bx = cssW - r; vx = -Math.abs(vx); }
        if (by - r < 0) { by = r; vy = Math.abs(vy); }
        if (vy > 0 && by + r >= padY - ph && by - r <= padY + ph && bx >= px * cssW - hw && bx <= px * cssW + hw) {
          // Where the ball lands decides the angle: edge hits cut, centre drives.
          var ang = -Math.PI / 2 + clamp((bx - px * cssW) / hw, -1, 1) * 1.05;
          speed = Math.min(cssH * BALL_MAX, speed + cssH * RALLY_STEP);
          vx = Math.cos(ang) * speed; vy = -Math.abs(Math.sin(ang) * speed);
          by = padY - ph - r; rally++;
          flash('RALLY ' + rally, C.cyan, 420);
          if (rally % 10 === 0) { flash('RALLY x' + rally, C.acid, 700); shake(5, 260); }
        }
        if (by - r > cssH) { loseLife(); return; }
        for (j = 0; j < bricks.length; j++) {                 // nearest overlap, shallowest axis
          b = bricks[j];
          if (b.hp <= 0 || bx + r < b.x || bx - r > b.x + b.w || by + r < b.y || by - r > b.y + b.h) continue;
          var ox = Math.min(bx + r - b.x, b.x + b.w - (bx - r)), oy = Math.min(by + r - b.y, b.y + b.h - (by - r));
          if (oy < ox) { by += (vy > 0 ? -1 : 1) * oy; vy = -vy; } else { bx += (vx > 0 ? -1 : 1) * ox; vx = -vx; }
          hitBrick(b); break;
        }
      }
      var sp = Math.sqrt(vx * vx + vy * vy);                  // keep speed honest after bounces
      if (sp > 0) { vx = vx / sp * speed; vy = vy / sp * speed; }
    }
    function hitBrick(b) {
      L.fldDirty = true;                                       // damaged or gone: rebake the wall
      if (--b.hp > 0) { flash('ARMORED', C.violet, 300); shake(3, 140); return; }
      score += b.t.pts * (1 + Math.floor(wave / 3));  // deeper waves pay more
      setScore(score); bricksLeft--; shake(4, 160);
      if (score > best) { best = score; writeBest(best); setBest(best); }
      if (bricksLeft <= 0) {                                  // wall cleared -> richer wave
        wave++; buildWave(); parkBall(Math.random() < 0.5);
        flash('WAVE ' + wave, C.acid, 1100); live.textContent = 'Wave ' + wave + '. Bricks are worth more.';
      }
    }
    function loseLife() {
      lives--; rally = 0;
      if (lives <= 0) { endRun(); return; }
      parkBall(Math.random() < 0.5); shake(8, 320); flash('LIFE LOST', C.magenta, 900);
      live.textContent = lives + ' lives left.';
    }
    function endRun() {
      if (over) return;                                       // latch: gameOver fires once per run
      over = true; state = OVER;
      if (score > best) { best = score; writeBest(best); setBest(best); }
      live.textContent = 'Game over. Final score ' + score + '.'; overCb(score);
    }

    /* ---- Drawing ----
       The wall, the paddle, the ball and the HUD plate+pips never change shape
       between events, so each is drawn once into its own canvas and blitted after
       that. Per frame the only path left is the drifting grid; everything else
       is a textured blit. Layers are sized in CSS px and carry the dpr scale, so
       `blit` lands them 1:1 on the device grid — pixel-identical to drawing
       straight onto `ctx`, glow included. */
    function layer(w, h) {                                     // offscreen canvas, device-scaled
      var c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w * dpr)); c.height = Math.max(1, Math.round(h * dpr));
      var g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.__g = g; c.__w = c.width / dpr; c.__h = c.height / dpr; return c;
    }
    function blit(c, x, y) { ctx.drawImage(c, x, y, c.__w, c.__h); }
    function roundRect(g, x, y, w, h, r) {
      g.beginPath();
      if (g.roundRect) { g.roundRect(x, y, w, h, r); return; }
      g.moveTo(x + r, y);
      g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
      g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
    }
    function neon(g, x, y, w, h, r, color, fillA, blur) {     // filled + glowing rounded rect
      g.save(); g.shadowColor = hexA(color, 0.95); g.shadowBlur = blur;
      roundRect(g, x, y, w, h, r); g.fillStyle = hexA(color, fillA); g.fill();
      g.lineWidth = Math.max(1.5, h * 0.1); g.strokeStyle = color; g.stroke(); g.restore();
    }
    var BM = 18;                                               // brick glow margin: blur 30 reaches ~15px
    // Bricks only ever change on a hit, so the whole wall is one cached bitmap.
    // It is rebuilt from per-(type,hp) brick sprites, which is what keeps a hit
    // cheap: a damaged brick re-renders one small sprite, not all 45 glows.
    function brickLayer(t, hp, max) {
      var w = bricks[0].w, h = bricks[0].h, frac = hp / max, col = C[t.color], p;
      var c = layer(w + BM * 2, h + BM * 2), g = c.__g;
      neon(g, BM, BM, w, h, Math.min(6, h * 0.25), col, 0.16 + (1 - frac) * 0.1, reduced ? 8 : 16 + (1 - frac) * 14);
      g.fillStyle = hexA(col, 0.9);                            // damage notches = hits taken
      for (p = 0; p < max - hp; p++) g.fillRect(BM + w * (0.2 + p * 0.3), BM + h * 0.38, Math.max(2, w * 0.12), h * 0.24);
      return c;
    }
    function buildField() {
      if (L.fldGen !== sizeGen) { L.fldGen = sizeGen; L.layers = {}; }
      var i, b, top = 1e9, bot = -1e9, c, g, m, key;
      for (i = 0; i < bricks.length; i++) { top = Math.min(top, bricks[i].y - BM); bot = Math.max(bot, bricks[i].y + bricks[i].h + BM); }
      c = layer(cssW, Math.max(1, Math.min(cssH, bot) - Math.max(0, top)));   // clipped to the canvas, as drawn
      g = c.__g; L.fldY = Math.max(0, top);
      for (i = 0; i < bricks.length; i++) {
        b = bricks[i]; if (b.hp <= 0) continue;
        key = b.t.color + b.hp + '_' + b.max;
        m = L.layers[key] || (L.layers[key] = brickLayer(b.t, b.hp, b.max));
        g.drawImage(m, b.x, b.y - L.fldY, m.__w, m.__h);
      }
      L.field = c;
    }
    function buildActors() {                                   // ball, trail dot and paddle
      var r = cssH * BALL_R, m = 17, c, g;
      c = layer(r * 2 + m * 2, r * 2 + m * 2); g = c.__g;
      g.shadowColor = hexA(C.magenta, 0.95); g.shadowBlur = reduced ? 12 : 30; g.fillStyle = C.magenta;
      g.beginPath(); g.arc(r + m, r + m, r, 0, 6.2832); g.fill();
      L.ball = c; L.ballM = m; L.discR = r;
      c = layer(r * 2, r * 2); g = c.__g;                      // trail dot; each is tinted by globalAlpha
      g.fillStyle = hexA(C.cyan, 1);
      g.beginPath(); g.arc(r, r, r, 0, 6.2832); g.fill();
      L.disc = c;
      m = 16;
      c = layer(cssW * PAD_W + m * 2, cssH * PAD_H + m * 2); g = c.__g;
      neon(g, m, m, cssW * PAD_W, cssH * PAD_H, cssH * PAD_H / 2, C.cyan, 0.3, reduced ? 12 : 26);
      L.paddle = c; L.paddleM = m; L.actGen = sizeGen;
    }
    // Lives are pips on a plate; both move only when a life is spent, so they bake together.
    function buildHud(lives) {
      var pipH = clamp(cssH * 0.02, 5, 22), pipW = pipH * 1.6, pipGap = pipW * 0.8, PM = 8, c, g, i, capW;
      var plateW = 0, plateH = cssH * 0.15, pipX = 0, pipY = cssH * 0.145 - pipH / 2;
      ctx.save();                                               // measure on a scratch font, keep ctx's alone
      ctx.font = '600 ' + Math.round(cssH * 0.035) + 'px Rajdhani, system-ui, sans-serif';
      capW = ctx.measureText('SCORE').width; ctx.restore();
      pipX = cssW * 0.05 + capW + pipGap;
      var pipRight = pipX + lives * pipW + (lives - 1) * pipGap;
      plateW = Math.max(cssW * 0.1, pipRight - cssW * 0.015);
      c = layer(plateW, plateH); g = c.__g;
      g.fillStyle = 'rgba(5,6,15,.55)';
      roundRect(g, 0, 0, plateW, plateH, 6); g.fill();
      L.plate = c;
      c = layer(Math.max(1, pipRight - pipX + PM * 2), pipH + PM * 2); g = c.__g;
      g.fillStyle = g.shadowColor = lives <= 1 ? C.orange : C.magenta;   // last life burns orange
      g.shadowBlur = reduced ? 0 : 12;
      for (i = 0; i < lives; i++) g.fillRect(PM + i * (pipW + pipGap), PM, pipW, pipH);
      L.pips = c; L.pipX = pipX - PM; L.pipY = pipY - PM;
      L.hudGen = sizeGen; L.hudLives = lives;
    }
    function label(text, x, y, size, weight, color, align) {
      ctx.textAlign = align;
      ctx.font = weight + ' ' + Math.round(cssH * size) + 'px ' + (weight === 900 ? 'Orbitron, ' : 'Rajdhani, ') + 'system-ui, sans-serif';
      ctx.fillStyle = color; ctx.fillText(text, x, y);
    }
    function draw() {
      var w = cssW, h = cssH, t = reduced ? 0 : elapsed, i, b, x, y, p, col, frac;
      ctx.save();
      ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);   // backdrop first, so a shake never exposes the edges
      if (!reduced && elapsed < shakeUntil) ctx.translate((Math.random() - 0.5) * shakeMag, (Math.random() - 0.5) * shakeMag);
      if (!reduced) {                                         // drifting synthwave grid + ball trail
        var gap = Math.max(26, h / 14), off = (t * 26) % gap;
        ctx.strokeStyle = hexA(C.violet, 0.13); ctx.lineWidth = 1; ctx.beginPath();
        for (x = -gap; x <= w + gap; x += gap) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
        for (y = -gap + off; y <= h + gap; y += gap) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
        ctx.stroke();
        for (i = 0; i < trail.length; i++) {
          ctx.fillStyle = hexA(C.cyan, (i / trail.length) * 0.5); ctx.beginPath();
          ctx.arc(trail[i][0] * w, trail[i][1] * h, h * BALL_R * (i / trail.length), 0, 6.2832); ctx.fill();
        }
      }
      for (i = 0; i < bricks.length; i++) {                    // bricks, dimmer as they take damage
        b = bricks[i];
        if (b.hp <= 0) continue;
        col = C[b.t.color]; frac = b.hp / b.max;
        neon(b.x, b.y, b.w, b.h, Math.min(6, b.h * 0.25), col, 0.16 + (1 - frac) * 0.1, reduced ? 8 : 16 + (1 - frac) * 14);
        for (p = 0; p < b.max - b.hp; p++) { ctx.fillStyle = hexA(col, 0.9);   // damage notches = hits taken
          ctx.fillRect(b.x + b.w * (0.2 + p * 0.3), b.y + b.h * 0.38, Math.max(2, b.w * 0.12), b.h * 0.24); }
      }
      neon(px * w - w * PAD_W / 2, h * PAD_Y - h * PAD_H / 2, w * PAD_W, h * PAD_H, h * PAD_H / 2, C.cyan, 0.3, reduced ? 12 : 26);
      ctx.save();                                             // ball
      ctx.shadowColor = hexA(C.magenta, 0.95); ctx.shadowBlur = reduced ? 12 : 30; ctx.fillStyle = C.magenta;
      ctx.beginPath(); ctx.arc(bx, by, h * BALL_R, 0, 6.2832); ctx.fill(); ctx.restore();
      ctx.textBaseline = 'middle';                            // HUD: score, wave, best, lives as pips
      // HUD lives in its own band above the wall, on a plate, so nothing sits on a brick.
      var pipH = clamp(h * 0.02, 5, 22), pipW = pipH * 1.6, pipGap = pipW * 0.8;
      ctx.font = '600 ' + Math.round(h * 0.035) + 'px Rajdhani, system-ui, sans-serif';
      var capW = ctx.measureText('SCORE').width, pipX = w * 0.05 + capW + pipGap;
      var pipY = h * 0.145 - pipH / 2, pipRight = pipX + lives * pipW + (lives - 1) * pipGap;
      ctx.save(); ctx.fillStyle = 'rgba(5,6,15,.55)';
      roundRect(w * 0.015, h * 0.035, Math.max(w * 0.1, pipRight - w * 0.015), h * 0.15, 6); ctx.fill();
      ctx.restore();
      label(String(score), w * 0.05, h * 0.09, 0.055, 900, C.ink, 'left');
      label('SCORE', w * 0.05, h * 0.145, 0.035, 600, C.dim, 'left');
      label('WAVE ' + wave, w / 2, h * 0.09, 0.035, 600, C.mute, 'center');
      label('BEST ' + best, w * 0.95, h * 0.09, 0.035, 600, C.dim, 'right');
      var lifeCol = lives <= 1 ? C.orange : C.magenta;  // last life burns orange
      ctx.fillStyle = ctx.shadowColor = lifeCol; ctx.shadowBlur = reduced ? 0 : 12;
      for (i = 0; i < lives; i++) ctx.fillRect(pipX + i * (pipW + pipGap), pipY, pipW, pipH);
      ctx.shadowBlur = 0;
      if (elapsed < flashUntil) {                             // rally / wave banner
        ctx.shadowColor = flashColor; ctx.shadowBlur = reduced ? 0 : 24;
        label(flashText, w / 2, h * 0.62, 0.075, 900, flashColor, 'center'); ctx.shadowBlur = 0;
      }
      if (state === SERVE) label('TAP or press SPACE to serve', w / 2, h * 0.86, 0.06, 700, C.ink, 'center');
      if (paused && state !== OVER) label('PAUSED', w / 2, h * (state === SERVE ? 0.76 : 0.86), 0.06, 700, C.ink, 'center');
      if (state === OVER) {
        label('GAME OVER · ' + score + ' PTS', w / 2, h * 0.86, 0.06, 700, C.ink, 'center');
        label('tap or press SPACE to play again', w / 2, h * 0.93, 0.045, 600, C.dim, 'center');
      }
      ctx.restore(); crt();                                   // release the shake transform, then CRT
    }
    function crt() {                                          // scanlines + vignette: static and cheap
      var i, v = ctx.createRadialGradient(cssW / 2, cssH / 2, Math.min(cssW, cssH) * 0.25, cssW / 2, cssH / 2, Math.max(cssW, cssH) * 0.75);
      ctx.save(); ctx.fillStyle = 'rgba(0,0,0,.16)';
      if (ctx.__pxH !== cssH) { var __px = document.createElement('canvas'); __px.width = 1; __px.height = 3;
          var __pxg = __px.getContext('2d'); __pxg.fillStyle = 'rgba(0,0,0,.16)'; __pxg.fillRect(0, 0, 1, 1);
          ctx.__pxP = ctx.createPattern(__px, 'repeat'); ctx.__pxH = cssH; }
        ctx.fillStyle = ctx.__pxP; ctx.fillRect(0, 0, cssW, cssH);
      v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,.55)');
      ctx.fillStyle = v; ctx.fillRect(0, 0, cssW, cssH); ctx.restore();
    }

    /* ---- Single rAF loop ---- */
    function frame(now) {
      if (destroyed) return;                                  // destroy() may land mid-flight
      var dt = prevTime ? clamp((now - prevTime) / 1000, 0, 0.05) : 0;  // cap: no teleport after a tab switch
      prevTime = now; elapsed += dt; if (!paused) update(dt); draw();
      // Re-check: api.gameOver() can call destroy() from inside update() above.
      if (!destroyed) rafId = requestAnimationFrame(frame);
    }
    function update(dt) {
      if (dt > 0) { aim = clamp(aim + (keyR ? 1 : 0) * KEY_SPEED * dt - (keyL ? 1 : 0) * KEY_SPEED * dt, PAD_W / 2, 1 - PAD_W / 2);
        px = clamp(px + (aim - px) * (1 - Math.exp(-EASE * dt)), PAD_W / 2, 1 - PAD_W / 2); }  // chase, never snap
      if (state === SERVE) { bx = px * cssW; by = cssH * PAD_Y - cssH * BALL_R * 2.4; return; }
      if (state === OVER) return;
      stepBall(dt);
      if (!reduced && cssW > 0) { trail.push([bx / cssW, by / cssH]); if (trail.length > 9) trail.shift(); }
    }

    /* ---- Input: pointer (mouse + touch) and keyboard ---- */
    function aimAt(clientX) {
      var r = canvas.getBoundingClientRect();
      if (r.width > 0) aim = clamp((clientX - r.left) / r.width, 0, 1);
    }
    function act() {                                          // the single confirm: serve or restart
      if (state === OVER) { resetRun(); return; }
      if (state !== SERVE) return;
      state = PLAY; speed = cssH * BALL_MIN; vx = speed * 0.5 * (aim >= 0.5 ? 1 : -1); vy = -speed * Math.sqrt(0.75);
    }
    function wake() { if (paused) { paused = false; prevTime = 0; } }
    function onDown(e) {
      if (e.button !== undefined && e.button > 0) return;
      e.preventDefault(); wake(); aimAt(e.clientX);
      try { if (e.pointerId !== undefined) canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      act();
    }
    function onKeyDown(e) {
      var k = e.key;
      if (k === 'ArrowLeft' || k === 'a' || k === 'A') { keyL = true; wake(); e.preventDefault(); return; }
      if (k === 'ArrowRight' || k === 'd' || k === 'D') { keyR = true; wake(); e.preventDefault(); return; }
      if (k !== ' ' && k !== 'Enter' && e.code !== 'Space') return;
      // Never steal Space/Enter from a real control (the shell's own buttons).
      var a = document.activeElement;
      if (a && a !== canvas && /^(BUTTON|INPUT|SELECT|TEXTAREA|A|SUMMARY)$/.test(a.tagName)) return;
      e.preventDefault(); wake(); act();
    }
    function onKeyUp(e) {
      var k = e.key;
      if (k === 'ArrowLeft' || k === 'a' || k === 'A') keyL = false;
      if (k === 'ArrowRight' || k === 'd' || k === 'D') keyR = false;
    }
    function onPause()  { if (!destroyed) paused = true; }
    function onResume() { if (!destroyed && !document.hidden) paused = false; }
    function onVis()    { if (!destroyed) paused = document.hidden; }
    function onResize() { if (!destroyed) { resize(); layoutBricks(); } }   // relayout, never rebuild the wall
    function onMove(e)  { if (!paused && state !== OVER) aimAt(e.clientX); }
    on(canvas, 'pointermove', onMove); on(canvas, 'pointerdown', onDown);
    on(document, 'keydown', onKeyDown); on(document, 'keyup', onKeyUp); on(document, 'visibilitychange', onVis);
    on(window, 'blur', onPause); on(window, 'focus', onResume);
    on(window, 'resize', onResize); on(window, 'orientationchange', onResize);

    buildWave(); parkBall(true); setBest(best); setScore(0);
    live.textContent = 'Wave 1. Three lives.';
    rafId = requestAnimationFrame(frame);
    /* ---- Teardown: nothing survives this ---- */
    return {
      destroy: function () {
        if (destroyed) return;
        destroyed = true; cancelAnimationFrame(rafId);
        for (var i = 0; i < listeners.length; i++) listeners[i][0].removeEventListener(listeners[i][1], listeners[i][2]);
        listeners.length = 0;
        var parent = wrap.parentNode;                         // drops the canvas and the <style> together
        if (parent && typeof parent.removeChild === 'function') parent.removeChild(wrap);
        else if (typeof wrap.remove === 'function') wrap.remove();
      }
    };
  }

  window.PixelGame = {
    name: 'Neon Paddle',
    instructions: 'Bounce the ball off your paddle and blast the neon bricks. Steer with the mouse, ' +
      'drag anywhere, left/right arrows or A/D. Space serves. Every paddle hit speeds the ball up, ' +
      'the ball dropping costs a life, and clearing the wall starts a richer new wave. Three lives.',
    start: start
  };
})();
