/**
 * PIXEL RUSH — games/flappy.js — "Flappy Rush", a one-button flappy game.
 * Contract (SPEC.md §"games/reaction.js contract"): window.PixelGame = { name,
 * instructions, start(root, api) -> { destroy() } }, with api = { setScore(n),
 * setBest(n), gameOver(score) }. One 2D canvas, no deps or assets; every rAF id,
 * listener and injected node dies in destroy().
 */
(function () {
  'use strict';
  /* Store key is fixed by the spec, punctuation and all. */
  var STORE_KEY = 'pixelrush.flappy.best';   /* must match the shell's key: pixelrush.<slug>.best */
  var REG_KEY = '__pixelrush_flappy_live', LIVES_MAX = 3;
  /* Fixed portrait design box: every gameplay dimension lives in these units, so a
     resize only changes the zoom, never the difficulty — the gap is as passable on a
     390px phone as on a 4K monitor, because both are the same 100x150 world. */
  var DW = 100, DH = 150;
  var GRAVITY = 78, FLAP_VY = -34, MAX_FALL = 62;   // world-units per second
  var BIRD_X = 30, BIRD_R = 4.2, PIPE_W = 13, LEVEL_PIPES = 4;
  var GAP0 = 46, GAP_MIN = 31, SPEED0 = 24, SPEED_MAX = 44, GAP_STEP = 1.5, SPEED_STEP = 1.6;
  var PIPE_GAP_MIN = 58, PIPE_GAP_TIME = 1.45;     // pipe spacing: min distance, or 1.45s of scroll
  var PIPE_GAP_STEP = 34;                          // max vertical gap-to-gap jump, so it stays thumb-trackable
  var EDGE_PAD = 11, DEATH_TIME = 0.9;
  var FALLBACK = { bg: '#05060f', ink: '#f2f5ff', dim: '#a7b0d0', cyan: '#22e7ff', magenta: '#ff2fb9', acid: '#c8ff2e', violet: '#8b5cf6', orange: '#ff8a3d' };
  /* STYLE BLOCK — `fl-` prefixed and scoped to the wrapper, so it cannot collide. */
  var STYLES = ['.fl{position:relative;width:100%;height:100%;overflow:hidden;user-select:none;',
    '-webkit-user-select:none;touch-action:none;-webkit-tap-highlight-color:transparent;',
    'color:var(--ink,#f2f5ff);font-family:var(--font-body,"Rajdhani",system-ui,sans-serif);}',
    '.fl canvas{display:block;width:100%;height:100%;touch-action:none;outline:none;cursor:pointer;}',
    '.fl__sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;clip:rect(0 0 0 0);overflow:hidden;}'].join('\n');
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function readBest() { try { var v = parseInt(window.localStorage.getItem(STORE_KEY), 10);
    return isFinite(v) && v > 0 ? v : 0; } catch (e) { return 0; } }   // private mode / disabled storage
  function writeBest(n) { try { window.localStorage.setItem(STORE_KEY, String(n)); } catch (e) { /* ignore */ } }
  /** start(root, api) — build the game inside `root` and return { destroy }. */
  function start(root, api) {
    api = api || {};
    // One game only: the shell mounts asynchronously, so a double-clicked RESTART can leave
    // two starts in flight and the first is never handed to the shell, so never destroyed.
    var prev = window[REG_KEY];
    if (prev && typeof prev.destroy === 'function') { try { prev.destroy(); } catch (e) { /* never block a start */ } }
    var setScore = typeof api.setScore === 'function' ? api.setScore : function () {};
    var setBest  = typeof api.setBest  === 'function' ? api.setBest  : function () {};
    var overCb   = typeof api.gameOver  === 'function' ? api.gameOver  : function () {};
    // Decorative motion is optional; the game is not. Site toggle first, OS second.
    var mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    var reduced = !!(window.PX && window.PX.reduced) || !!(mq && mq.matches);
    /* ------------------------------- DOM ------------------------------- */
    var wrap = document.createElement('div'); wrap.className = 'fl';
    var canvas = document.createElement('canvas');
    canvas.setAttribute('tabindex', '0'); canvas.setAttribute('role', 'application');
    canvas.setAttribute('aria-label', 'Flappy Rush. Tap anywhere or press Space to flap. Three lives.');
    var live = document.createElement('div');          // screen-reader feedback
    live.className = 'fl__sr'; live.setAttribute('aria-live', 'polite');
    var styleTag = document.createElement('style'); styleTag.textContent = STYLES;
    wrap.appendChild(styleTag); wrap.appendChild(canvas); wrap.appendChild(live); root.appendChild(wrap);
    var ctx = canvas.getContext('2d');
    if (!ctx) { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); return { destroy: function () {} }; }
    /* ------------------------------ State ------------------------------ */
    var READY = 0, PLAY = 1, DYING = 2, OVER = 3, state = READY;
    var rafId = 0, destroyed = false, over = false, paused = false;
    var elapsed = 0, prevTime = 0, score = 0, lives = LIVES_MAX, level = 0, best = readBest();
    var pipes = [], by = DH * 0.42, bvy = 0, tilt = 0, deadT = 0, flapAt = -9;
    var gridOff = 0, shakeMag = 0, shakeT = 0, listeners = [], S = { gap: GAP0, speed: SPEED0, gapDist: PIPE_GAP_MIN };
    function on(t, type, fn) { t.addEventListener(type, fn); listeners.push([t, type, fn]); }
    /* ---- Sizing: letterbox the fixed design box into any container aspect ---- */
    var dpr = 1, cssW = 1, cssH = 1, sc = 1, ox = 0, oy = 0;
    function resize() {
      var r = wrap.getBoundingClientRect();
      cssW = Math.max(1, Math.round(r.width)); cssH = Math.max(1, Math.round(r.height));
      dpr = clamp(window.devicePixelRatio || 1, 1, 2); canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
      canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sc = Math.min(cssW / DW, cssH / DH); ox = (cssW - DW * sc) / 2; oy = (cssH - DH * sc) / 2;
    }
    resize();
    /* The first resize() runs while the shell is still laying the stage out, so it
       can measure a box a few pixels short and leave the backing store smaller than
       the canvas is actually displayed at (a permanent ~1.5% stretch). A
       ResizeObserver catches the settled size — and every later reflow, such as the
       how-to-play panel opening — which a window resize event never fires for. */
    var ro = null;
    if (window.ResizeObserver) {
      ro = new ResizeObserver(function () { if (!destroyed) resize(); });
      ro.observe(wrap);
    }
    var C = {};                                          // site tokens, with hard fallbacks
    Object.keys(FALLBACK).forEach(function (k) {
      var v = getComputedStyle(document.documentElement).getPropertyValue('--' + k);
      C[k] = (v && v.trim()) || FALLBACK[k];
    });
    function hexA(hex, a) {                               // #rrggbb + alpha -> rgba()
      hex = String(hex).trim().replace('#', '');
      if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
      var n = parseInt(hex, 16);
      return isFinite(n) ? 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')' : 'rgba(255,255,255,' + a + ')';
    }
    /* ---------------------------- Run control ---------------------------- */
    function applyLevel() {
      S.gap = Math.max(GAP_MIN, GAP0 - level * GAP_STEP);
      S.speed = Math.min(SPEED_MAX, SPEED0 + level * SPEED_STEP);
      S.gapDist = Math.max(PIPE_GAP_MIN, S.speed * PIPE_GAP_TIME);
    }
    function spawnPipe() {
      // Two constraints, and the centre has to satisfy BOTH: fully inside the playfield,
      // and no more than PIPE_GAP_STEP from the last gap so the opening stays thumb-trackable.
      // Clamping only to the step range used to shove a gap past lo/hi, which at the
      // tighter late-game gaps hid part of the opening under the floor — a death the
      // player could not have flown out of.
      var lo = EDGE_PAD + S.gap / 2, hi = DH - EDGE_PAD - S.gap / 2;
      var last = pipes.length ? pipes[pipes.length - 1].cy : by;
      var from = Math.max(lo, last - PIPE_GAP_STEP), to = Math.min(hi, last + PIPE_GAP_STEP);
      pipes.push({ x: DW + PIPE_W, cy: from + Math.random() * (to - from), scored: false });
    }
    function resetRun() {
      score = 0; lives = LIVES_MAX; level = 0; pipes.length = 0; gridOff = 0; deadT = 0;
      by = DH * 0.42; bvy = 0; tilt = 0; over = false; paused = false; state = READY; prevTime = 0;
      elapsed = 0; flapAt = -9;                     // per-run clock: the wing cycle must not carry over
      applyLevel(); setScore(0); setBest(best); live.textContent = 'New run. Three lives.';
    }
    function flap() {
      if (destroyed || state !== PLAY) return;
      bvy = FLAP_VY; flapAt = elapsed; }
    function loseLife() {
      state = DYING; deadT = 0; shakeT = 0.24;
      if (!reduced) shakeMag = 7;                         // decorative hit shake
    }
    function endRun() {
      if (over) return;                                  // hard latch: gameOver fires once per run
      over = true; state = OVER;
      if (score > best) { best = score; writeBest(best); setBest(best); }
      live.textContent = 'Game over. Final score ' + score + '.';
      overCb(score);                                      // may call destroy() from inside
    }
    /* ------------------------------ Update ------------------------------ */
    function update(dt) {
      elapsed += dt;
      if (shakeT > 0) { shakeT -= dt; if (shakeT <= 0) shakeMag = 0; }
      if (state === READY) { by = DH * 0.42 + Math.sin(elapsed * 2.2) * (reduced ? 0 : 3.2); bvy = 0; return; }
      if (state === OVER) return;
      if (state === DYING) {                              // death fall, spinning toward the floor
        deadT += dt;
        bvy = Math.min(MAX_FALL, bvy + GRAVITY * dt); by += bvy * dt;
        tilt += (1.45 - tilt) * (1 - Math.exp(-6 * dt));
        if (by > DH - BIRD_R) { by = DH - BIRD_R; bvy = 0; }
        // The world KEEPS SCROLLING through the death beat. Freezing it left the
        // pipe you crashed into parked on the bird's column, so the respawn below
        // dropped the next life inside it with no reaction time — three lives gone
        // in under two seconds, none of them the player's fault.
        gridOff = (gridOff + S.speed * dt) % 16;
        var d;
        for (d = pipes.length - 1; d >= 0; d--) {
          pipes[d].x -= S.speed * dt;
          if (pipes[d].x + PIPE_W < BIRD_X - BIRD_R * 2) pipes.splice(d, 1);
        }
        if (deadT < DEATH_TIME) return;
        lives--; if (lives <= 0) { endRun(); return; }
        // Safety net: retire anything still level with the respawn column. Such a
        // pipe was never scored, so no point is lost and the player always gets a
        // clean, visible runway for the new life.
        for (d = pipes.length - 1; d >= 0; d--) if (pipes[d].x + PIPE_W > BIRD_X - PIPE_W) pipes.splice(d, 1);
        by = DH * 0.36; bvy = 0; tilt = 0; state = PLAY; prevTime = 0;
        live.textContent = lives + ' lives left.';
        return;
      }
      /* PLAY */
      bvy = Math.min(MAX_FALL, bvy + GRAVITY * dt);
      by += bvy * dt; tilt = reduced ? 0 : clamp(bvy * 0.016, -0.5, 1.15);
      if (by - BIRD_R <= 0) { by = BIRD_R; bvy = 0; loseLife(); return; }
      if (by + BIRD_R >= DH) { by = DH - BIRD_R; bvy = 0; loseLife(); return; }
      gridOff = (gridOff + S.speed * dt) % 16;
      var i, p;
      for (i = pipes.length - 1; i >= 0; i--) {
        p = pipes[i];
        p.x -= S.speed * dt;
        if (p.x + PIPE_W < BIRD_X - BIRD_R * 2) { pipes.splice(i, 1); continue; }
        if (!p.scored && p.x + PIPE_W <= BIRD_X) {        // one point per pipe, as it fully clears
          p.scored = true; score++; setScore(score);
          if (score > best) { best = score; writeBest(best); setBest(best); }
          var nl = Math.floor(score / LEVEL_PIPES);
          if (nl > level) { level = nl; applyLevel(); }   // tighter gap, faster scroll
        }
        if (BIRD_X + BIRD_R > p.x && BIRD_X - BIRD_R < p.x + PIPE_W &&
            (by - BIRD_R < p.cy - S.gap / 2 || by + BIRD_R > p.cy + S.gap / 2)) { loseLife(); return; }
      }
      if (!pipes.length || DW + PIPE_W - pipes[pipes.length - 1].x > S.gapDist) spawnPipe();
    }
    /* ------------------------------- Draw ------------------------------- */
    function roundRect(x, y, w, h, r) {
      ctx.beginPath();
      if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
      ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
    }
    /** Shrink-to-fit: a phone's tall stage must never blow the HUD off the edges. */
    function fitText(text, weight, fam, size, maxW) {
      var s = Math.max(8, Math.round(size)), f = fam + ', system-ui, sans-serif';
      ctx.font = weight + ' ' + s + 'px ' + f;
      while (s > 8 && ctx.measureText(text).width > maxW) { s -= 1; ctx.font = weight + ' ' + s + 'px ' + f; }
      return s;
    }
    function label(text, cx, cy, size, weight, fam, color, align, maxW) {
      var s = fitText(text, weight, fam, size, maxW == null ? cssW * 0.9 : maxW);
      ctx.textAlign = align || 'center'; ctx.textBaseline = 'middle';
      ctx.font = weight + ' ' + s + 'px ' + fam + ', system-ui, sans-serif';
      ctx.fillStyle = color; ctx.fillText(text, cx, cy);
    }
    function glowText(text, cx, cy, size, color, maxW) {
      ctx.save(); ctx.shadowColor = color; ctx.shadowBlur = reduced ? 0 : 26;
      label(text, cx, cy, size, 900, 'Orbitron', color, 'center', maxW);
      ctx.restore(); }
    function drawPipe(x, top, bot) {                    // neon-outlined segment pair + cap lips
      var w = PIPE_W * sc, px = ox + x * sc, lip = Math.max(5, w * 0.34), s, y0, y1;
      ctx.save(); ctx.shadowColor = hexA(C.acid, 0.7); ctx.shadowBlur = reduced ? 6 : 18;
      ctx.lineWidth = Math.max(1.5, w * 0.12); ctx.strokeStyle = C.acid; ctx.fillStyle = hexA(C.acid, 0.18);
      for (s = 0; s < 2; s++) {                          // s=0 is the top segment, s=1 the bottom one
        y0 = s ? bot : oy; y1 = s ? oy + DH * sc : top;
        if (y1 - y0 <= 0) continue;
        roundRect(px, y0, w, y1 - y0, w * 0.18); ctx.fill(); ctx.stroke();
        ctx.fillStyle = hexA(C.acid, 0.85);
        roundRect(px - w * 0.06, s ? bot : top - lip, w * 1.12, lip, w * 0.12); ctx.fill();
        ctx.fillStyle = hexA(C.acid, 0.18);
      }
      ctx.restore();
    }
    function drawBird(x, y, ang) {
      var r = BIRD_R * sc, i;
      ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
      ctx.shadowColor = C.cyan; ctx.shadowBlur = reduced ? 8 : 24;
      ctx.fillStyle = C.cyan; ctx.beginPath(); ctx.arc(0, 0, r, 0, 6.2832); ctx.fill();
      ctx.shadowBlur = 0;
      // wing: one flap cycle driven by time since the last flap (frozen when reduced)
      var wp = reduced ? -0.5 : -0.5 + 0.9 * Math.sin(clamp((elapsed - flapAt) * 9, 0, Math.PI));
      ctx.fillStyle = hexA(C.bg, 0.75); ctx.beginPath();
      ctx.ellipse(-r * 0.15, r * (0.25 + wp * 0.25), r * 0.62, r * 0.36, -0.4, 0, 6.2832); ctx.fill();
      for (i = 0; i < 2; i++) {                          // i=0 the dark eye socket, i=1 the acid pupil
        ctx.fillStyle = i ? C.acid : C.bg; ctx.beginPath();
        ctx.arc(r * (i ? 0.42 : 0.36), -r * (i ? 0.34 : 0.3), r * (i ? 0.1 : 0.26), 0, 6.2832); ctx.fill();
      }
      ctx.restore();
    }
    function crt() {                                    // scanlines + vignette: static and cheap
      var i, v = ctx.createRadialGradient(cssW / 2, cssH / 2, Math.min(cssW, cssH) * 0.25, cssW / 2, cssH / 2, Math.max(cssW, cssH) * 0.75);
      ctx.save();
      if (!reduced) { ctx.fillStyle = 'rgba(0,0,0,.15)'; if (ctx.__pxH !== cssH) { var __px = document.createElement('canvas'); __px.width = 1; __px.height = 3;
          var __pxg = __px.getContext('2d'); __pxg.fillStyle = 'rgba(0,0,0,.15)'; __pxg.fillRect(0, 0, 1, 1);
          ctx.__pxP = ctx.createPattern(__px, 'repeat'); ctx.__pxH = cssH; }
        ctx.fillStyle = ctx.__pxP; ctx.fillRect(0, 0, cssW, cssH); }
      v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,.55)');
      ctx.fillStyle = v; ctx.fillRect(0, 0, cssW, cssH); ctx.restore();
    }
    function card(title, sub, hint, color) {
      var band = Math.min(cssH * 0.30, cssW * 0.42), cy = oy + DH * sc / 2;   // both axes drive the type
      ctx.save(); ctx.fillStyle = hexA(C.bg, 0.74); ctx.fillRect(0, 0, cssW, cssH);
      glowText(title, cssW / 2, cy - band * 0.28, band * 0.34, color, cssW * 0.86);
      label(sub, cssW / 2, cy + band * 0.08, band * 0.16, 600, 'Rajdhani', C.ink, 'center', cssW * 0.8);
      if (hint) label(hint, cssW / 2, cy + band * 0.32, band * 0.13, 700, 'Rajdhani', C.dim, 'center', cssW * 0.86);
      ctx.restore();
    }
    function draw() {
      var w = cssW, i, u, pad, pw2, ph2, p, px;
      ctx.save();
      ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, cssH);   // backdrop first, so a shake never exposes the edges
      if (shakeMag > 0) ctx.translate((Math.random() - 0.5) * shakeMag, (Math.random() - 0.5) * shakeMag);
      ctx.fillStyle = 'rgba(255,255,255,.03)'; ctx.fillRect(ox, oy, DW * sc, DH * sc);  // playfield plate
      if (!reduced) {                                      // scrolling parallax rails
        ctx.strokeStyle = hexA(C.violet, 0.16); ctx.lineWidth = 1; ctx.beginPath();
        for (i = -2; i < DH / 16 + 2; i++) {
          var gy = oy + (i * 16 + gridOff) * sc; ctx.moveTo(ox, gy); ctx.lineTo(ox + DW * sc, gy); }
        ctx.stroke();
      }
      for (i = 0; i < pipes.length; i++) {
        p = pipes[i]; px = ox + p.x * sc;
        if (px + PIPE_W * sc < ox || px > ox + DW * sc) continue;
        drawPipe(p.x, oy + (p.cy - S.gap / 2) * sc, oy + (p.cy + S.gap / 2) * sc);
      }
      if (state !== OVER) drawBird(ox + BIRD_X * sc, oy + by * sc, tilt);
      ctx.restore(); crt();
      /* ---- HUD: drawn AFTER the CRT overlay, with a dark shadow for contrast ---- */
      u = Math.min(cssH, cssW * 0.6);                      // both axes, never canvas height alone
      pad = Math.max(8, cssW * 0.045);
      ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.95)'; ctx.shadowBlur = 5;
      glowText(String(score), ox + pad, oy + u * 0.055, u * 0.10, C.ink, ox + DW * sc * 0.5);
      label('SCORE', ox + pad, oy + u * 0.115, u * 0.042, 600, 'Rajdhani', C.dim, 'left', ox + DW * sc * 0.5);
      label('BEST ' + best, ox + DW * sc - pad, oy + u * 0.07, u * 0.05, 600, 'Rajdhani', C.dim, 'right', ox + DW * sc * 0.5);
      if (level > 0) label('LV ' + level, ox + DW * sc - pad, oy + u * 0.125, u * 0.04, 600, 'Rajdhani', C.acid, 'right', ox + DW * sc * 0.5);
      ctx.shadowBlur = 0;
      pw2 = clamp(u * 0.05, 5, 26); ph2 = pw2 * 0.5;       // life pips, bottom-left, thumb-readable
      for (i = 0; i < lives; i++) {
        ctx.fillStyle = lives === 1 ? C.orange : C.magenta; ctx.shadowColor = ctx.fillStyle;
        ctx.shadowBlur = reduced ? 0 : 10;
        roundRect(ox + pad + i * pw2 * 1.45, oy + DH * sc - pad - ph2, pw2, ph2, ph2 / 2); ctx.fill();
      }
      ctx.restore();
      if (state === READY) card('FLAPPY RUSH', 'BEST ' + best, 'TAP anywhere or press SPACE', C.cyan);
      if (paused && state === PLAY) card('PAUSED', '', 'TAP to resume', C.violet);
      if (state === OVER) card('GAME OVER',
        'SCORE ' + score + (score > 0 && score >= best ? '  ·  NEW BEST' : ''),
        'TAP or press SPACE to play again', C.magenta);
    }
    /* -------------------------- Single rAF loop -------------------------- */
    function frame(now) {
      if (destroyed) return;                              // guard: destroy() can land between frames
      var dt = prevTime ? clamp((now - prevTime) / 1000, 0, 0.05) : 0;   // cap: no teleport after a tab switch
      prevTime = now;
      if (!paused) update(dt);
      draw();
      // Re-check: api.gameOver() can call destroy() from inside update() above.
      if (!destroyed) rafId = requestAnimationFrame(frame);
    }
    /* -------------- Input: pointer (touch + mouse) and keyboard -------------- */
    /** The one confirm: start, flap, resume, or restart a dead run. */
    function act() {
      if (destroyed) return;
      // Ahead of the pause check, so a game-over that was paused still restarts on
      // the first tap. This must be unconditional: the card promises "TAP or press
      // SPACE to play again", and the shell's round-over scrim is pointer-events:none,
      // so a canvas tap is the only way back for anyone who does not spot the button.
      if (state === OVER) { paused = false; resetRun(); return; }
      if (state === READY) { paused = false; state = PLAY; prevTime = 0; flap(); return; }
      if (paused) { paused = false; prevTime = 0; return; }
      flap();
    }
    function onDown(e) {
      if (e.button !== undefined && e.button > 0) return;   // no right-click-only paths
      e.preventDefault();
      if (e.pointerId !== undefined) { try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
      act();
    }
    function onKeyDown(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code !== 'Space' && e.code !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar' && e.key !== 'Enter') return;
      // Never steal Space/Enter from a real control (the shell's own buttons).
      var a = document.activeElement;
      if (a && a !== canvas && /^(BUTTON|INPUT|SELECT|TEXTAREA|A|SUMMARY)$/.test(a.tagName)) return;
      e.preventDefault(); act();
    }
    function onPause()  { if (!destroyed) paused = true; }
    function onResume() { if (!destroyed && !document.hidden) paused = false; }
    function onVis()    { if (!destroyed && document.hidden) paused = true; }
    function onResize() { if (!destroyed) resize(); }
    [[canvas, 'pointerdown', onDown], [document, 'keydown', onKeyDown], [document, 'visibilitychange', onVis],
     [window, 'blur', onPause], [window, 'focus', onResume], [window, 'resize', onResize],
     [window, 'orientationchange', onResize]].forEach(function (b) { on(b[0], b[1], b[2]); });

    applyLevel(); setBest(best); setScore(0);
    live.textContent = 'Flappy Rush. Three lives.';
    var instance = {
      destroy: function () {
        if (destroyed) return;                            // idempotent
        destroyed = true; cancelAnimationFrame(rafId);
        if (ro) { ro.disconnect(); ro = null; }
        for (var i = 0; i < listeners.length; i++) listeners[i][0].removeEventListener(listeners[i][1], listeners[i][2]);
        listeners.length = 0;
        if (window[REG_KEY] === instance) window[REG_KEY] = null;
        var parent = wrap.parentNode;                     // drops the canvas, live region and <style> together
        if (parent && typeof parent.removeChild === 'function') parent.removeChild(wrap);
        else if (typeof wrap.remove === 'function') wrap.remove();
      }
    };
    window[REG_KEY] = instance;
    rafId = requestAnimationFrame(frame);
    window.__dbg = function(){ return {state:state,by:by,lives:lives,score:score,level:level,gap:S.gap,speed:S.speed,cssW:cssW,cssH:cssH,bw:canvas.width,pipes:pipes.map(function(p){return {x:p.x,cy:p.cy,scored:p.scored};})}; };
    return instance;
  }

  /* ---------------------- Public module contract ---------------------- */
  window.PixelGame = {
    name: 'Flappy Rush',
    instructions: 'One button: tap anywhere on the playfield, or press SPACE, to flap. Gravity pulls you ' +
      'down — flap early and aim for the middle of the gap. One point for every pipe you clear, and every ' +
      '4 points tightens the gap a little and speeds the scroll up. Three lives; best score saved here.',
    start: start
  };
})();
