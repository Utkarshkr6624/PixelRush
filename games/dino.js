/**
 * PIXEL RUSH — games/dino.js — "Dino Dash", an endless one-input runner.
 * Contract (SPEC.md): window.PixelGame = { name, instructions, start(root, api) -> { destroy() } }
 *   api = { setScore(n), setBest(n), gameOver(score) }.
 * Self-contained: no imports, no dependencies, no assets — one <canvas> + 2D ctx, and every
 * rAF id and listener created in start() is torn down in destroy().
 */
(function () {
  'use strict';
  /* -------------------------------- Tuning -------------------------------- */
  var STORE_KEY = 'pixelrush.dino.best', LIVES_MAX = 3, REG_KEY = '__pixelrush_dino_live';
  // Physics is in "u" units (see resize): one u scales with the stage, so a phone and a desktop
  // get identical proportions and a run is never distorted. GRAV u/s^2, JUMP_V u/s (apex ~2.8u,
  // which clears the tallest cactus), DUCK_FALL extra gravity so a duck drops fast.
  var GRAV = 52, JUMP_V = 17.1, DUCK_FALL = 1.7, JUMP_CUT = 0.42, BUFFER_MS = 130;
  var SP_MIN = 4.2, SP_MAX = 9.4, SP_RAMP = 0.22;         // u/s now, ceiling, u/s gained per second
  var SPAWN_MIN = 0.95, SPAWN_VAR = 0.75, ORB_CHANCE = 0.22, SHIELD_POINTS = 25, W_K = 0.78;
  var INVULN_HIT = 1.2, INVULN_SHIELD = 0.9, DUCK_ZONE = 0.7;  // mercy seconds; duck strip fraction
  var FALLBACK = { bg: '#05060f', ink: '#f2f5ff', dim: '#a7b0d0', cyan: '#22e7ff', magenta: '#ff2fb9',
    acid: '#c8ff2e', orange: '#ff8a3d', violet: '#8b5cf6' };
  // `dn-` prefixed and scoped to the wrapper this file creates, so it can never collide with
  // base.css / games.css. touch-action:none makes the whole stage a touch surface.
  var STYLES = ['.dn{position:relative;width:100%;height:100%;overflow:hidden;user-select:none;',
    '-webkit-user-select:none;-webkit-tap-highlight-color:transparent;touch-action:none;',
    'color:var(--ink,#f2f5ff);font-family:var(--font-body,"Rajdhani",system-ui,sans-serif);}',
    '.dn canvas{display:block;width:100%;height:100%;outline:none;cursor:pointer;}',
    '.dn__sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;clip:rect(0 0 0 0);overflow:hidden;}'].join('\n');
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function readBest() {
    try { var v = parseInt(window.localStorage.getItem(STORE_KEY), 10); return isFinite(v) && v > 0 ? v : 0; }
    catch (e) { return 0; }                                // private mode / disabled storage
  }
  function writeBest(n) { try { window.localStorage.setItem(STORE_KEY, String(n)); } catch (e) { /* ignore */ } }
  /** start(root, api) — build the game inside `root` and return { destroy }. */
  function start(root, api) {
    api = api || {};
    var setScore = typeof api.setScore === 'function' ? api.setScore : function () {};
    var setBest  = typeof api.setBest  === 'function' ? api.setBest  : function () {};
    var overCb   = typeof api.gameOver  === 'function' ? api.gameOver  : function () {};
    // One board only: the shell mounts asynchronously, so a double-clicked RESTART can leave two
    // starts in flight and the first is never handed to the shell. Retire it before building.
    var prev = window[REG_KEY];
    if (prev && typeof prev.destroy === 'function') { try { prev.destroy(); } catch (e) { /* never block a start */ } }
    Array.prototype.slice.call(root.querySelectorAll('.dn')).forEach(function (n) { if (n.parentNode) n.parentNode.removeChild(n); });
    // Decorative motion is optional; the game is not. Site toggle first, OS preference second.
    var mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    var reduced = !!(window.PX && window.PX.reduced) || !!(mq && mq.matches);
    var wrap = document.createElement('div'); wrap.className = 'dn';
    var canvas = document.createElement('canvas');
    canvas.setAttribute('tabindex', '0'); canvas.setAttribute('role', 'application');
    canvas.setAttribute('aria-label', 'Dino Dash. Tap the upper area or press Space to jump; swipe down, or tap the lower strip, to duck. Three lives.');
    var live = document.createElement('div'); live.className = 'dn__sr'; live.setAttribute('aria-live', 'polite');
    var styleTag = document.createElement('style'); styleTag.textContent = STYLES;
    wrap.appendChild(styleTag); wrap.appendChild(canvas); wrap.appendChild(live); root.appendChild(wrap);
    var ctx = canvas.getContext('2d');
    if (!ctx) { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); return { destroy: function () {} }; }
    var rafId = 0, destroyed = false, over = false;    // `over` latches api.gameOver()
    var paused = false, booted = false, prevTime = 0, elapsed = 0, listeners = [];
    var dpr = 1, cssW = 1, cssH = 1, u = 10, groundY = 1, speed = 0, dist = 0, scroll = 0, phase = 0;
    // `fy` is the FEET line, not the top of the box, so ducking changes height without shifting
    // the sprite. The duck pair feeds `ducking`; the jump pair is what the release-early cut
    // reads, so holding either input raises the jump.
    var fy = 0, pvy = 0, onGround = true, ducking = false, buffer = 0;
    var keyDuck = false, ptrDuck = false, keyJump = false, ptrJump = false;
    var lives = LIVES_MAX, shields = 0, invuln = 0, shakeT = 0, flashT = 0, flashText = '', flashCol = '#22e7ff';
    // `best` is the live HUD value; `runBest` is snapshotted on reset so the mid-run climb
    // cannot eat the new-record test inside endRun().
    var score = 0, bonus = 0, best = readBest(), runBest = best, isRecord = false;
    var obs = [], spawnIn = 1.4, startY = 0, downId = null;
    function on(t, type, fn, opt) { t.addEventListener(type, fn, opt); listeners.push([t, type, fn, opt]); }
    /* ---- Sizing: crisp devicePixelRatio capped at 2; every size derives from the live stage ---- */
    function resize() {
      var r = wrap.getBoundingClientRect(), i, o;
      var oldU = u, oldGround = groundY;
      cssW = Math.max(1, Math.round(r.width)); cssH = Math.max(1, Math.round(r.height));
      dpr = clamp(window.devicePixelRatio || 1, 1, 2);
      canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
      canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px'; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // One world unit drives EVERY sprite and the short side caps it, so a portrait phone and
      // a landscape desktop share proportions and nothing is stretched or pushed off-stage.
      u = Math.max(6, Math.min(cssH * 0.085, cssW * 0.16)); groundY = Math.round(cssH * 0.80);
      // Everything is anchored to the ground line, so a resize has to move the ground line with
      // it. Leaving `fy` on the old one stranded the dino below the canvas on a shorter stage:
      // invisible, and its hitbox no longer overlapped anything, which made the run immortal.
      // Grounded -> re-anchor exactly; mid-arc -> keep the same height above the new ground.
      if (onGround || !booted) fy = groundY;
      else fy = groundY - (oldGround - fy) * (u / oldU);
      // Obstacles keep their ground-relative geometry, so in-flight hazards survive a resize
      // instead of drifting off the new ground line.
      for (i = 0; i < obs.length; i++) {
        o = obs[i];
        o.h = o.hs * u; o.w = o.ws * u; o.y = groundY - o.bBot * u - o.h;
      }
    }
    function playerH() { return ducking ? u * 0.85 : u * 1.5; }
    function playerW() { return u * 1.35; }
    function px() { return cssW * 0.18; }
    var C = {};                                          // site tokens, with hard fallbacks
    Object.keys(FALLBACK).forEach(function (k) {
      var v = getComputedStyle(document.documentElement).getPropertyValue('--' + k);
      C[k] = (v && v.trim()) || FALLBACK[k];
    });
    function hexA(hex, a) {
      hex = (hex || '#fff').replace('#', '').trim();
      if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
      var n = parseInt(hex, 16);
      return isFinite(n) ? 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')' : 'rgba(255,255,255,' + a + ')';
    }
    function roundRect(x, y, w, h, r) {
      ctx.beginPath();
      if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
      ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
    }
    /* -------------------------------- Run state -------------------------------- */
    function flash(text, color, ms) { flashText = text; flashCol = color; flashT = elapsed + ms / 1000; }
    function shake() { if (!reduced) shakeT = elapsed + 0.22; }
    function resetRun() {
      obs = []; lives = LIVES_MAX; shields = 0; invuln = 0; score = 0; bonus = 0; isRecord = false;
      speed = SP_MIN; dist = 0; scroll = 0; spawnIn = 1.4; phase = 0; over = false; paused = false;
      pvy = 0; fy = groundY; onGround = true; ducking = false; buffer = 0; runBest = best;
      keyDuck = ptrDuck = keyJump = ptrJump = false; downId = null;
      setScore(0); setBest(best); live.textContent = 'New run. Score 0. Three lives.';
    }
    /** Distance-gated spawn. The gap floor is generous, so a jump is always physically available. */
    // Every obstacle stores its geometry ground-relative (u units) so resize() can rebuild it on
    // the new ground line: bBot = how far the BOTTOM edge floats above the ground (<= 0), hs/ws =
    // its own size. x stays in CSS px, because the world is a continuously scrolling pixel strip.
    function spawn() {
      var roll = Math.random(), high = dist > 30 && roll < 0.3;   // high birds start after ~30u of run
      var w = u * (high ? 1.1 : 0.55), h = high ? u * 0.55 : (0.7 + Math.random() * 0.75) * u;
      if (Math.random() < ORB_CHANCE) {                     // the shield orb rides beside the hazard
        var oy = groundY - u * (0.9 + Math.random() * 0.5), oh = u * 0.4;
        obs.push({ kind: 'orb', x: cssW + u + (Math.random() < 0.5 ? -u * 0.2 : w + u * 0.2),
          y: oy, w: oh, h: oh, t: 0, bBot: (groundY - oy - oh) / u, hs: oh / u, ws: oh / u });
      }
      obs.push({ x: cssW + u, w: w, h: h, wing: Math.random() * 6.28, bBot: high ? -1.2 : 0,
        hs: h / u, ws: w / u,
        kind: high ? 'high' : (roll < 0.78 ? 'cactus' : 'low'), y: high ? groundY - u * 1.75 : groundY - h });
    }
    /* -------------------------------- Physics -------------------------------- */
    function launch() { pvy = -JUMP_V * u; onGround = false; ptrDuck = false; ducking = false; }
    function jump() { if (onGround) { launch(); buffer = 0; } else buffer = BUFFER_MS; }
    function clearAhead() { obs = obs.filter(function (o) { return o.x < px() - u * 1.5; }); }
    function hit() {
      if (over || destroyed || invuln > 0) return;
      if (shields > 0) {                                 // the neon shield eats exactly one hit
        shields--; invuln = INVULN_SHIELD; shake(); flash('SHIELD DOWN', C.violet, 700);
        live.textContent = 'Shield absorbed the hit. ' + lives + ' lives left.'; clearAhead(); return;
      }
      lives--; invuln = INVULN_HIT; shake(); flash('HIT', C.orange, 700); clearAhead();
      if (lives <= 0) { endRun(); return; }
      live.textContent = lives + (lives === 1 ? ' life left.' : ' lives left.');
    }
    function endRun() {
      if (over) return;                                  // latch: api.gameOver() fires once per run
      over = true;
      if (score > runBest) { best = score; isRecord = true; writeBest(best); setBest(best); }
      live.textContent = 'Game over. Final score ' + score + '.'; overCb(score);
    }
    function update(dt) {
      ducking = keyDuck || ptrDuck;                     // either input may duck; releasing either lets go
      if (buffer > 0) { buffer -= dt * 1000; if (onGround && buffer > 0) { buffer = 0; launch(); } }
      if (invuln > 0) invuln -= dt;
      if (!onGround) {
        pvy += GRAV * u * dt * (ducking ? DUCK_FALL : 1);
        fy += pvy * dt;
        if (!(keyJump || ptrJump) && pvy < -JUMP_V * u * JUMP_CUT) pvy = -JUMP_V * u * JUMP_CUT;
        // Note the buffer is deliberately left intact on landing: the block above runs
        // next frame and fires it, which is exactly the late-tap case a thumb needs.
        if (fy >= groundY) { fy = groundY; pvy = 0; onGround = true; }
      }
      speed = Math.min(SP_MAX, speed + SP_RAMP * dt);
      var dx = speed * u * dt; dist += speed * dt; scroll += dx; phase += speed * dt * 1.9;
      if ((spawnIn -= dt) <= 0) {
        spawn();
        // Gap scales with speed, so reaction time stays roughly constant as the run ramps.
        spawnIn = Math.max(SPAWN_MIN, (speed / SP_MAX) * 0.95) + Math.random() * SPAWN_VAR;
      }
      var bx0 = px(), bw = playerW(), top = fy - playerH(), i, o;
      for (i = 0; i < obs.length; i++) {
        o = obs[i]; o.x -= dx;
        if (o.kind !== 'orb') o.wing += dt * 9;
        if (o.x + o.w < -u) { obs.splice(i, 1); i--; continue; }
        if (o.kind === 'orb') { o.t += dt; if (o.x < bx0 + bw) { obs.splice(i, 1); i--; pickUp(); } }
        else if (o.x < bx0 + bw && o.x + o.w > bx0 && top < o.y + o.h && fy > o.y) {
          hit();
          if (over) return;                              // endRun() may have destroyed us mid-loop
        }
      }
      if (obs.length > 24) obs.shift();
      var next = Math.floor(dist * 3) + bonus;
      if (next !== score) { score = next; setScore(score); if (score > best) { best = score; setBest(best); } }
    }
    function pickUp() {
      shields++; bonus += SHIELD_POINTS; flash('+SHIELD', C.acid, 700);
      live.textContent = 'Shield collected. It absorbs one hit. ' + shields + ' held.';
    }
    /* -------------------------------- Drawing -------------------------------- */
    /**
     * HUD text. Size is min(stage-height k, stage-width k) and then shrunk to the measured
     * width — a tall phone stage must never blow the text up past the edges of the canvas.
     * The width term is deliberately generous (W_K): on a 343px phone stage the old 0.62
     * factor pinned every label to the 10px floor, which is unreadable at arm's length, while
     * on any stage wide enough for the height term to bind first the two factors agree and
     * nothing changes. So this lifts narrow stages only and leaves desktop sizing identical.
     */
    function hud(text, x, y, align, k, weight, color, cap) {
      var fam = weight >= 900 ? 'Orbitron, ' : 'Rajdhani, ', max = cap || cssW * 0.46;
      var size = Math.max(10, Math.min(cssH * k, cssW * k * W_K));
      function set(s) { ctx.font = weight + ' ' + Math.round(s) + 'px ' + fam + 'system-ui, sans-serif'; }
      set(size);
      if (ctx.measureText(text).width > max) set(Math.max(9, size * 0.98 * max / ctx.measureText(text).width));
      ctx.textAlign = align; ctx.textBaseline = 'middle'; ctx.fillStyle = color; ctx.fillText(text, x, y);
    }
    function drawDino(x, y) {
      var w = playerW(), h = playerH(), i, bob = onGround && !reduced ? Math.sin(phase) * u * 0.05 : 0;
      var col = invuln > 0 && Math.floor(elapsed * 14) % 2 ? hexA(C.ink, 0.35) : C.acid;
      ctx.save(); ctx.shadowColor = C.acid; ctx.shadowBlur = reduced ? 8 : 22;
      roundRect(x, y + bob, w * 0.72, h * 0.78, h * 0.22); ctx.fillStyle = col; ctx.fill();
      ctx.beginPath(); ctx.moveTo(x + w * 0.06, y + bob + h * 0.3);                    // tail
      ctx.lineTo(x - w * 0.1, y + bob + h * 0.12); ctx.lineTo(x - w * 0.02, y + bob + h * 0.46);
      ctx.closePath(); ctx.fill();
      roundRect(x + w * 0.44, y + bob - h * 0.12, w * 0.56, h * 0.44, h * 0.16); ctx.fillStyle = col; ctx.fill();
      ctx.shadowBlur = 0; ctx.fillStyle = C.bg; ctx.beginPath();                       // visor eye
      ctx.arc(x + w * 0.86, y + bob + h * 0.08, h * 0.06, 0, 6.2832); ctx.fill();
      ctx.fillStyle = hexA(C.acid, 0.85);                // legs: two-beat cycle on the ground, tucked in the air
      var sw = (onGround ? Math.sin(phase * 2) : 0.35) * u * 0.12, ly = y + bob + h * 0.72;
      for (i = 0; i < 2; i++) ctx.fillRect(x + w * (0.16 + i * 0.3) + (i ? -sw : sw), ly, w * 0.16, h * 0.28);
      ctx.restore();
    }
    function drawObstacle(o) {
      var col, f, i;
      if (o.kind === 'orb') {                            // shield pickup
        var beat = reduced ? 1 : 0.85 + 0.15 * Math.sin(o.t * 6);
        ctx.save(); ctx.shadowColor = C.acid; ctx.shadowBlur = reduced ? 10 : 24; ctx.fillStyle = C.acid;
        ctx.beginPath(); ctx.arc(o.x + o.w / 2, o.y + o.h / 2, o.w * 0.5 * beat, 0, 6.2832);
        ctx.fill(); ctx.restore(); return;
      }
      if (o.kind === 'cactus') {
        ctx.save(); ctx.shadowColor = C.magenta; ctx.shadowBlur = reduced ? 6 : 14;
        roundRect(o.x, o.y, o.w, o.h, o.w * 0.4); ctx.fillStyle = hexA(C.magenta, 0.22); ctx.fill();
        ctx.lineWidth = Math.max(1.2, o.h * 0.11); ctx.strokeStyle = C.magenta; ctx.stroke();
        ctx.fillStyle = hexA(C.magenta, 0.55); ctx.fillRect(o.x + o.w * 0.38, o.y - o.h * 0.2, o.w * 0.2, o.h * 0.24);
        ctx.restore(); return;
      }
      col = o.kind === 'high' ? C.orange : C.violet;     // high = duck under it, low = jump it
      f = o.y + o.h * 0.5 + (reduced ? 0 : Math.sin(o.wing) * o.h * 0.12);
      ctx.save(); ctx.shadowColor = col; ctx.shadowBlur = reduced ? 6 : 16; ctx.fillStyle = col;
      roundRect(o.x, f - o.h * 0.28, o.w, o.h * 0.56, o.h * 0.28); ctx.fill();
      ctx.shadowBlur = 0; ctx.strokeStyle = hexA(col, 0.9); ctx.lineWidth = Math.max(1.5, o.h * 0.1);
      ctx.beginPath();
      for (i = 0; i < 2; i++) {                          // flapping wings
        var dy = i ? 1 : -1, c = Math.cos(o.wing) * o.w * 0.4;
        ctx.moveTo(o.x + o.w * 0.5, f + dy * o.h * 0.2); ctx.lineTo(o.x + o.w * 0.5 + (i ? c : -c), f + dy * o.h * 0.4);
      }
      ctx.stroke(); ctx.restore();
    }
    function drawWorld() {
      var w = cssW, h = cssH, i, x, gap, off, step, tx, v;
      ctx.save();
      ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);    // backdrop first, so a shake never bares the edges
      if (!reduced && elapsed < shakeT) ctx.translate((Math.random() - 0.5) * u * 0.22, (Math.random() - 0.5) * u * 0.16);
      if (!reduced) {                                    // far parallax grid
        gap = Math.max(u * 1.4, h / 16); off = (scroll * u * 0.25) % gap;
        ctx.strokeStyle = hexA(C.violet, 0.12); ctx.lineWidth = 1; ctx.beginPath();
        for (x = -gap; x <= w + gap; x += gap) { ctx.moveTo(x, groundY - h * 0.34); ctx.lineTo(x, groundY); }
        for (i = gap - off; i < h * 0.34; i += gap) { ctx.moveTo(0, groundY - i); ctx.lineTo(w, groundY - i); }
        ctx.stroke();
      }
      ctx.fillStyle = hexA(C.cyan, 0.07); ctx.fillRect(0, groundY, w, h - groundY);
      ctx.fillStyle = ctx.shadowColor = C.cyan; ctx.shadowBlur = reduced ? 0 : 14;
      ctx.fillRect(0, groundY, w, 2); ctx.shadowBlur = 0;
      if (!reduced) {                                    // ground ticks, scrolling with the world
        step = u * 1.6; tx = (scroll * u) % step; ctx.fillStyle = hexA(C.cyan, 0.3);
        for (i = 0; i * step + tx < w; i++) ctx.fillRect(i * step + tx, groundY + 4, step * 0.35, 2);
      }
      for (i = 0; i < obs.length; i++) drawObstacle(obs[i]);
      if (shields > 0) {                                 // one violet ring per held charge
        var sw = playerW(), sh = playerH();
        for (i = 0; i < shields; i++) {
          ctx.save(); ctx.shadowColor = C.violet; ctx.shadowBlur = reduced ? 8 : 20;
          ctx.strokeStyle = hexA(C.violet, 0.75); ctx.lineWidth = Math.max(1.5, u * 0.07); ctx.beginPath();
          ctx.ellipse(px() + sw / 2, fy - sh / 2, sw * 0.78 + i * u * 0.12, sh * 0.68 + i * u * 0.12, 0, 0, 6.2832);
          ctx.stroke(); ctx.restore();
        }
      }
      drawDino(px(), fy - playerH());
      ctx.restore();
      crt();                                             // release the shake transform, then lay the CRT over it
    }
    /** Scanlines + vignette, over the world only. The HUD is drawn after this, so it stays legible. */
    function crt() {
      var i, v = ctx.createRadialGradient(cssW / 2, cssH / 2, Math.min(cssW, cssH) * 0.25,
                                         cssW / 2, cssH / 2, Math.max(cssW, cssH) * 0.75);
      ctx.save();
      if (!reduced) { ctx.fillStyle = 'rgba(0,0,0,.16)'; for (i = 0; i < cssH; i += 3) ctx.fillRect(0, i, cssW, 1); }
      v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,.55)');
      ctx.fillStyle = v; ctx.fillRect(0, 0, cssW, cssH); ctx.restore();
    }
    function drawHud() {
      var w = cssW, i, top = Math.max(12, cssH * 0.055);
      var pipH = Math.max(5, Math.min(cssH * 0.018, cssW * 0.02)), pipW = pipH * 1.8, pipG = pipH * 0.7;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,.9)'; ctx.shadowBlur = 4; ctx.shadowOffsetY = 1;   // dark halo = contrast
      hud('SCORE ' + score, w * 0.05, top, 'left', 0.055, 900, C.ink);
      hud('BEST ' + best, w * 0.95, top, 'right', 0.042, 600, C.dim);
      ctx.shadowBlur = 0;
      for (i = 0; i < LIVES_MAX; i++) {                  // lives as pips; the last one burns orange
        ctx.fillStyle = i < lives ? (lives === 1 ? C.orange : C.magenta) : hexA(C.dim, 0.22);
        ctx.fillRect(w * 0.05 + i * (pipW + pipG), top + pipH * 1.5, pipW, pipH);
      }
      if (shields > 0) {                                 // shield pip, same band as the lives
        ctx.strokeStyle = C.violet; ctx.lineWidth = Math.max(1.5, pipH * 0.3); ctx.beginPath();
        ctx.arc(w * 0.05 + LIVES_MAX * (pipW + pipG) + pipH, top + pipH * 2, pipH * 0.7, 0, 6.2832); ctx.stroke();
      }
      ctx.restore();
      if (elapsed < flashT) hud(flashText, w / 2, cssH * 0.3, 'center', 0.07, 900, flashCol, w * 0.9);
      if (over) {                                        // Game Over card, with a restart affordance
        ctx.fillStyle = hexA(C.bg, 0.72); ctx.fillRect(0, 0, w, cssH);
        hud('GAME OVER', w / 2, cssH * 0.4, 'center', 0.12, 900, C.magenta, w * 0.9);
        hud('SCORE ' + score + (isRecord ? '  ·  NEW BEST' : ''), w / 2, cssH * 0.52, 'center', 0.055, 700, C.ink, w * 0.9);
        hud('TAP or press SPACE to run again', w / 2, cssH * 0.63, 'center', 0.042, 600, C.dim, w * 0.9);
        return;
      }
      if (!booted || paused) {
        ctx.fillStyle = hexA(C.bg, 0.62); ctx.fillRect(0, 0, w, cssH);
        // Duck strip drawn over the wash, so the thumb affordance still reads on a phone.
        ctx.fillStyle = hexA(C.violet, 0.09); ctx.fillRect(0, cssH * DUCK_ZONE, w, cssH * (1 - DUCK_ZONE));
        hud(booted ? 'PAUSED' : 'DINO DASH', w / 2, cssH * 0.34, 'center', 0.11, 900, C.cyan, w * 0.9);
        hud(booted ? 'Tap or press a key to resume' : 'TAP THE TOP TO JUMP  ·  SWIPE DOWN OR TAP THE BOTTOM TO DUCK',
            w / 2, cssH * 0.48, 'center', 0.038, 600, C.dim, w * 0.92);
        if (!booted) hud('ACID ORBS = SHIELD  ·  +25  ·  ABSORBS ONE HIT', w / 2, cssH * 0.58, 'center', 0.034, 600, C.acid, w * 0.92);
      }
    }
    /* ---------------------------- Single rAF loop ---------------------------- */
    function frame(now) {
      if (destroyed) return;                             // destroy() may land mid-flight
      var dt = prevTime ? clamp((now - prevTime) / 1000, 0, 0.05) : 0;   // cap: no teleport after a tab switch
      prevTime = now; elapsed += dt;
      if (!paused && !over) update(dt);
      drawWorld(); drawHud();
      if (!destroyed) rafId = requestAnimationFrame(frame);   // re-check: gameOver() may have destroyed us
    }
    /* ---------------------- Input: pointer + keyboard ---------------------- */
    function wake() { if (paused && !over) { paused = false; booted = true; prevTime = 0; } }
    function press() {
      if (destroyed) return;
      if (over) { resetRun(); return; }                 // restart a dead run, else jump
      wake(); booted = true; jump();
    }
    function localY(clientY) {
      var r = wrap.getBoundingClientRect();
      return (clientY - r.top) / Math.max(1, r.height);
    }
    function onDown(e) {
      if (destroyed || (e.button !== undefined && e.button > 0)) return;
      e.preventDefault();
      if (over) { resetRun(); return; }
      wake(); booted = true; startY = e.clientY; downId = e.pointerId;
      if (localY(e.clientY) > DUCK_ZONE) ptrDuck = true;  // the thumb strip ducks...
      else { ptrJump = true; jump(); }                     // ...everything above it jumps
      try { if (e.pointerId !== undefined) canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    }
    // A downward drag anywhere becomes a duck, so the strip is a shortcut rather than a rule.
    function onMove(e) {
      if (destroyed || downId === null || ptrDuck) return;
      if (e.clientY - startY > u * 1.2) { ptrDuck = true; ptrJump = false; }
    }
    function release() { downId = null; ptrDuck = false; ptrJump = false; }
    // Lifting the finger/pointer ends the touch: a duck must stop the moment the
    // player lets go, or the dino stays ducked forever. This handler was
    // missing, which threw on start() and left the cabinet unbootable.
    function onUp(e) {
      if (destroyed) return;
      if (e && e.preventDefault) e.preventDefault();
      release();
    }
    function onCancel(e) { if (e && e.preventDefault) e.preventDefault(); release(); }
    function onKeyDown(e) {
      if (destroyed || e.metaKey || e.ctrlKey || e.altKey) return;
      var k = e.code;
      if (k === 'KeyP' || k === 'Escape') {
        e.preventDefault(); if (!over) { paused = !paused; if (!paused) booted = true; } return;
      }
      if (k === 'ArrowDown' || k === 'KeyS') { e.preventDefault(); wake(); booted = true; keyDuck = true; return; }
      if (k !== 'Space' && k !== 'ArrowUp' && k !== 'KeyW' && k !== 'Enter') return;
      var a = document.activeElement;                    // never steal Space from a real control
      if (a && a !== canvas && /^(BUTTON|INPUT|SELECT|TEXTAREA|A|SUMMARY)$/.test(a.tagName)) return;
      e.preventDefault(); keyJump = true; press();
    }
    function onKeyUp(e) {
      if (destroyed) return;
      var k = e.code;
      if (k === 'ArrowDown' || k === 'KeyS') keyDuck = false;
      if (k === 'Space' || k === 'ArrowUp' || k === 'KeyW' || k === 'Enter') keyJump = false;
    }
    function onPause()  { if (!destroyed) { paused = true; prevTime = 0; } }
    function onResume() { if (!destroyed && !document.hidden) { paused = false; prevTime = 0; } }
    function onVis()    { if (!destroyed) { paused = document.hidden; prevTime = 0; } }
    function onResize() { if (!destroyed) resize(); }
    on(canvas, 'pointerdown', onDown); on(canvas, 'pointermove', onMove); on(canvas, 'pointerup', onUp);
    on(canvas, 'pointerleave', onCancel); on(canvas, 'pointercancel', onCancel); on(canvas, 'contextmenu', onCancel);
    on(document, 'keydown', onKeyDown); on(document, 'keyup', onKeyUp); on(document, 'visibilitychange', onVis);
    on(window, 'blur', onPause); on(window, 'focus', onResume);
    on(window, 'resize', onResize); on(window, 'orientationchange', onResize);
    resize(); resetRun(); booted = false; paused = true;  // the first run waits for a tap
    setBest(best); setScore(0);
    rafId = requestAnimationFrame(frame);
    /* ---- Teardown: nothing survives this ---- */
    var instance = {
      destroy: function () {
        if (destroyed) return;
        destroyed = true; cancelAnimationFrame(rafId); rafId = 0;
        for (var i = 0; i < listeners.length; i++)
          listeners[i][0].removeEventListener(listeners[i][1], listeners[i][2], listeners[i][3]);
        listeners.length = 0;
        if (window[REG_KEY] === instance) window[REG_KEY] = null;
        var parent = wrap.parentNode;                   // drops the canvas, live region and <style> together
        if (parent && typeof parent.removeChild === 'function') parent.removeChild(wrap);
        else if (typeof wrap.remove === 'function') wrap.remove();
      }
    };
    window[REG_KEY] = instance;
    return instance;
  }
  /* ---------------------- Public module contract ---------------------- */
  window.PixelGame = {
    name: 'Dino Dash',
    instructions: 'Endless neon run. TAP the top of the screen (or SPACE / UP / W) to jump — hold for a ' +
      'higher jump, and a tap just before you land still fires. SWIPE DOWN, or tap the bottom strip ' +
      '(or DOWN / S) to duck under the high orange birds; cacti and the low violet birds you jump. ' +
      'Collect the pulsing acid orbs: each grants a SHIELD that absorbs one hit and pays +25, shown ' +
      'as a violet ring and a HUD pip. Three lives, then the run ends. It speeds up as you go, and ' +
      'your score climbs with distance. P pauses. Best score is saved on this device.',
    start: start
  };
})();
