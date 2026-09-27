/**
 * PIXEL RUSH — games/stack-tower.js — "Stack Tower"
 * window.PixelGame = { name, instructions, start(root, api) }, api = { setScore, setBest, gameOver }.
 * Self-contained: no imports, no assets — one <canvas> + 2D ctx; every rAF id, listener
 * and DOM node created in start() is torn down in destroy().
 */
(function () {
  'use strict';
  /* -------------------------------- Tuning -------------------------------- */
  var STORE_KEY = 'pixelrush.stack-tower.best'; // localStorage: all-time best score
  var BASE_BW = 0.72;      // starting block width, as a fraction of the playfield
  var GAP = 0.9;           // drop gap above the tower, in block heights
  var BLOCKS_PER_LEVEL = 3;   // difficulty tier every N placed blocks
  var SWING_BASE = 1.55;   // sweep angular speed at level 0 (rad/s; phase runs -PI..PI)
  var SWING_STEP = 0.11;   // added per level …
  var SWING_MAX = 6.0;     // … up to this ceiling
  var TOL_BASE = 0.055;    // perfect window as a fraction of the playfield …
  var TOL_STEP = 0.0013;   // … shaved per level …
  var TOL_MIN = 0.009;     // … down to this floor so it never become impossible
  var GRAVITY = 20;        // fall acceleration, in block-heights per second^2
  var DROP_PTS = 10;       // score per block placed (the height you reached)
  var PERFECT_PTS = 25;    // score per perfect placement …
  var COMBO_PTS = 6;       // … plus this per combo step, capped by the caller
  var LEVEL_PTS = 25;      // paid once per difficulty tier gained
  var THIN = 0.05;         // tower thinner than this fraction of the field = collapse
  var SWING_OVER = 0.12;   // how far past the playfield edge the block may travel
  var STYLES = '.st{position:relative;width:100%;height:100%;overflow:hidden;touch-action:none;' +
    'user-select:none;-webkit-tap-highlight-color:transparent;' +
    'font-family:var(--font-body,"Rajdhani",system-ui,sans-serif);color:var(--ink,#f2f5ff)}' +
    '.st canvas{display:block;width:100%;height:100%;outline:none}';
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function readBest() { try { var v = parseInt(window.localStorage.getItem(STORE_KEY), 10);
    return isFinite(v) && v > 0 ? v : null; } catch (e) { return null; } }  // private mode can throw
  function writeBest(v) { try { window.localStorage.setItem(STORE_KEY, String(v)); } catch (e) {} }
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
    var wrap = document.createElement('div'); wrap.className = 'st';
    var canvas = document.createElement('canvas');
    canvas.setAttribute('tabindex', '0'); canvas.setAttribute('role', 'application');
    canvas.setAttribute('aria-label', 'Stack Tower board. Tap anywhere or press SPACE to drop the swinging block.');
    var live = document.createElement('div'); // screen-reader announcements
    live.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0)';
    live.setAttribute('aria-live', 'polite');
    wrap.appendChild(canvas); wrap.appendChild(live);
    var styleTag = document.createElement('style');
    styleTag.textContent = STYLES; wrap.appendChild(styleTag); root.appendChild(wrap); // one <style>, scoped to .st
    var ctx = canvas.getContext('2d');
    if (!ctx) { root.removeChild(wrap); return { destroy: function () {} }; }
    var rafId = 0, destroyed = false, ready = false;
    var reduced = !!(window.PX && window.PX.reduced) ||
      !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    /* ------------------------------ State ------------------------------ */
    var blocks = [];       // [{x,w,body}] — x is the left edge in world units, w the width
    var debris = [];       // [{x,y,w,body,vx,vy,rot,spin}] — trimmed slices, world units
    var mover = null;      // the block currently swinging or falling
    var phase = 0, dir = 1, falling = false;
    var score = 0, combo = 0, level = 0, bestEver = readBest();
    var isRecord = false, over = false, paused = false, bootAt = -1e9;
    var camY = 0, shake = 0, flashAt = -1e9, toastT = -1e9, toastText = '';
    /* ----------------- Sizing (crisp devicePixelRatio) ----------------- */
    var dpr = 1, cssW = 1, cssH = 1, PW = 1, BW = 1, BH = 1, cx = 0, groundY = 0;
    function resize() {
      var r = wrap.getBoundingClientRect(), old = PW;
      cssW = Math.max(1, Math.round(r.width)); cssH = Math.max(1, Math.round(r.height));
      dpr = clamp(window.devicePixelRatio || 1, 1, 2); // cap 2: 3x phones choke on shadowBlur
      canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
      canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Letterbox a centred playfield into whatever aspect ratio the stage has.
      PW = Math.max(60, Math.min(cssW * 0.86, cssH * 0.52));
      cx = Math.round(cssW / 2); groundY = cssH - Math.max(20, Math.round(cssH * 0.07));
      BH = Math.max(9, PW * 0.115); BW = PW * BASE_BW;
      // World units are playfield-relative, so a mid-run rotation rescales the live state.
      var k = old > 1 ? PW / old : 1, i;
      if (k !== 1 && (blocks.length || debris.length || mover)) {
        for (i = 0; i < blocks.length; i++) { blocks[i].x *= k; blocks[i].w *= k; }
        for (i = 0; i < debris.length; i++) { debris[i].x *= k; debris[i].y *= k; debris[i].w *= k; }
        if (mover) { mover.x *= k; mover.y *= k; mover.w *= k; }
        camY *= k;
      }
    }
    resize();
    function token(n, fb) { // pull a site custom property, with a hard fallback
      var v = getComputedStyle(document.documentElement).getPropertyValue(n);
      return (v && v.trim()) || fb;
    }
    var C = { bg: token('--bg', '#05060f'), ink: token('--ink', '#f2f5ff'), dim: token('--ink-dim', '#a7b0d0'),
      cyan: token('--cyan', '#22e7ff'), magenta: token('--magenta', '#ff2fb9'), acid: token('--acid', '#c8ff2e'),
      orange: token('--orange', '#ff8a3d'), violet: token('--violet', '#8b5cf6') };
    var BODIES = [C.cyan, C.violet, C.magenta, C.orange, C.acid]; // tower cycles these per level
    function hexA(hex, a) { // #rrggbb + alpha -> rgba()
      hex = (hex || '#fff').trim().replace('#', '');
      var n = parseInt(hex, 16);
      return isFinite(n) ? 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')' : 'rgba(255,255,255,' + a + ')';
    }
    function rr(x, y, w, h, r) { // rounded-rect path, with a pre-roundRect fallback
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
    }
    function tol() { return Math.max(PW * TOL_MIN, PW * (TOL_BASE - level * TOL_STEP)); }
    function swingSpeed() { return Math.min(SWING_MAX, SWING_BASE + level * SWING_STEP); }
    function topY() { return blocks.length * BH; }          // world height of the tower's surface
    function sy(wy) { return groundY - (wy - camY); }       // world -> screen y
    /* Every x in the world model is PLAYFIELD-RELATIVE (0 .. PW); the draw
       pass converts with sx() = cx - PW / 2 + x. The implicit full-width
       surface the first block lands on, and the block that swings above it,
       must live in that same space or the tower builds beside the plinth. */
    function sx(x) { return cx - PW / 2 + x; }
    function plinth() { return { x: (PW - BW) / 2, w: BW }; }   // block 0's resting surface
    /* ---------------------------- Game logic ---------------------------- */
    function award(pts) {
      score += pts; setScore(score);
      if (bestEver === null || score > bestEver) {
        bestEver = score; isRecord = true; writeBest(score); setBest(score);
      }
    }
    function say(text) { toastText = text; toastT = last; }
    function spawnSlice(x, y, w, body) {
      if (w < 1.5) return;                                  // nothing worth seeing
      debris.push({ x: x, y: y, w: w, body: body, vx: (Math.random() - 0.5) * 0.6,
        vy: 1.2, rot: 0, spin: (Math.random() - 0.5) * 5 });
    }
    function nextMover() {
      var w = blocks.length ? blocks[blocks.length - 1].w : BW;
      dir = -dir;                                           // alternate sweep direction
      phase = 0;
      mover = { x: PW / 2 - w / 2, w: w, y: topY() + BH * GAP, body: BODIES[blocks.length % BODIES.length] };
      falling = false;
    }
    function resetRun() {
      blocks = []; debris = []; mover = null; falling = false;
      phase = 0; dir = 1; camY = 0; shake = 0; flashAt = -1e9; toastT = -1e9;
      score = 0; combo = 0; level = 0; isRecord = false; over = false; paused = false;
      bootAt = ready ? last : -1e9;                         // -1e9 until the first real frame stamps it
      nextMover(); setScore(0);
      if (bestEver !== null) setBest(bestEver);
      setStatus('Playing');
      live.textContent = 'New run. Score 0.';
    }
    function die(reason) {
      if (over || destroyed) return;    // api.gameOver() may only fire once per run
      over = true; falling = false;
      shake = reduced ? 0 : 14;
      say(reason);
      setStatus('Game over');
      live.textContent = reason + ' Final score ' + score + '.';
      gameOverCb(score);
    }
    /** Resolve a dropped block against the tower top: trim, combo, or collapse. */
    function land() {
      // blocks[] holds only *placed* blocks; the first drop lands on an implicit full-width plinth.
      var t = blocks.length ? blocks[blocks.length - 1] : plinth();
      var l = Math.max(mover.x, t.x), r = Math.min(mover.x + mover.w, t.x + t.w);
      var ov = r - l;
      if (ov <= 0) {                                       // clean miss — block sails past
        spawnSlice(mover.x, mover.y, mover.w, mover.body);
        mover = null; die('MISSED THE EDGE');
        return;
      }
      var off = (mover.x + mover.w / 2) - (t.x + t.w / 2);
      var perfect = Math.abs(off) <= tol();
      if (perfect) {
        // Snap flush to the block below; the misaligned sliver shaves off and falls away.
        var left = mover.x < t.x;                             // the sliver hangs off the outer edge
        var sl = left ? t.x - mover.x : mover.x + mover.w - (t.x + t.w);
        spawnSlice(left ? mover.x : t.x + t.w, topY() + BH * 0.15, sl, mover.body);
        combo++;
        award(PERFECT_PTS + Math.min(combo - 1, 10) * COMBO_PTS);
        say('PERFECT x' + combo);
        blocks.push({ x: t.x, w: t.w, body: mover.body });   // snapped flush, full width kept
        mover = null;
      } else {
        combo = 0;
        if (mover.x < t.x) spawnSlice(mover.x, topY() + BH * 0.15, t.x - mover.x, mover.body);
        else spawnSlice(t.x + t.w, topY() + BH * 0.15, mover.x + mover.w - (t.x + t.w), mover.body);
        award(DROP_PTS);
        blocks.push({ x: l, w: ov, body: mover.body });
        mover = null;
      }
      var nl = Math.floor(blocks.length / BLOCKS_PER_LEVEL);
      if (nl > level) { level = nl; award(LEVEL_PTS); flashAt = last; say('LEVEL ' + level); }
      if (blocks[blocks.length - 1].w < PW * THIN) {       // tower shaved down to nothing
        die('TOWER TOO THIN');
        return;
      }
      nextMover();
    }
    function drop() {
      if (destroyed || over || falling || !mover) return;
      falling = true;                                      // freeze the sweep, start the fall
    }
    function step(dt) {
      if (mover && !falling) {
        var amp = PW / 2 - mover.w / 2 + PW * SWING_OVER;
        phase += dir * swingSpeed() * dt;
        if (phase > Math.PI) { phase = Math.PI; dir = -1; } // sweep ends are hard stops
        if (phase < -Math.PI) { phase = -Math.PI; dir = 1; }
        mover.x = PW / 2 - mover.w / 2 + Math.sin(phase) * amp;
      } else if (mover && falling) {
        var v = mover.vy || 0;
        mover.vy = v - GRAVITY * BH * dt;
        mover.y += mover.vy * dt;
        if (mover.y <= topY()) { mover.y = topY(); land(); }
      }
      for (var i = debris.length - 1; i >= 0; i--) {         // trimmed slices fall under gravity
        var p = debris[i];
        p.vy -= GRAVITY * BH * dt;
        p.x += p.vx * PW * dt; p.y += p.vy * BH * dt; p.rot += p.spin * dt;
        if (p.y < camY - BH * 2 || p.y < -BH * 4) debris.splice(i, 1);
      }
      if (shake > 0) shake = Math.max(0, shake - dt * 40);
      // Camera rises with the tower, keeping roughly the top 60% of the stage in play.
      var want = Math.max(0, topY() - Math.max(BH * 2, cssH * 0.62));
      camY += (want - camY) * (reduced ? 1 : Math.min(1, dt * 6));
    }
    /* ---------------------------- Rendering ---------------------------- */
    function slab(x, syTop, w, h, body, alpha, inset) {
      var p = inset === undefined ? h * 0.1 : inset;
      ctx.save();
      ctx.globalAlpha = alpha === undefined ? 1 : alpha;
      ctx.fillStyle = hexA(body, 0.9); ctx.shadowColor = body; ctx.shadowBlur = 18;
      rr(x + p, syTop + p, w - p * 2, h - p * 2, Math.min(7, h * 0.22)); ctx.fill();
      ctx.shadowBlur = 0; ctx.fillStyle = hexA('#ffffff', 0.22);   // glassy top highlight
      rr(x + p, syTop + p, w - p * 2, Math.max(1.5, h * 0.16), Math.min(5, h * 0.12)); ctx.fill();
      ctx.restore();
    }
    function draw(now) {
      var w = cssW, h = cssH;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);
      var ox = shake ? (Math.random() - 0.5) * shake : 0, oy = shake ? (Math.random() - 0.5) * shake : 0;
      ctx.save(); ctx.translate(ox, oy);
      // Ground line + the light it throws up the tower.
      var gg = ctx.createLinearGradient(0, groundY - h * 0.25, 0, groundY);
      gg.addColorStop(0, hexA(C.cyan, 0)); gg.addColorStop(1, hexA(C.cyan, 0.13));
      ctx.fillStyle = gg; ctx.fillRect(cx - PW / 2 - 20, groundY - h * 0.25, PW + 40, h * 0.25);
      ctx.strokeStyle = hexA(C.cyan, 0.5); ctx.lineWidth = 2; ctx.shadowColor = C.cyan; ctx.shadowBlur = 12;
      ctx.beginPath(); ctx.moveTo(cx - PW / 2 - 16, groundY); ctx.lineTo(cx + PW / 2 + 16, groundY);
      ctx.stroke(); ctx.shadowBlur = 0;
      // The plinth the first block lands on, then the tower — top block last so its glow sits on top.
      if (camY < BH * 2) {
        ctx.save(); ctx.fillStyle = hexA(C.violet, 0.5); ctx.shadowColor = C.violet; ctx.shadowBlur = 14;
        rr(sx(plinth().x), groundY - BH, BW, BH, 6); ctx.fill(); ctx.restore();
      }
      for (var i = blocks.length - 1; i >= 0; i--) {
        var b = blocks[i], top = sy((i + 1) * BH);
        if (top > groundY + BH) break;
        slab(sx(b.x), top, b.w, BH, b.body, clamp(1 - i * 0.012, 0.45, 1));
      }
      if (blocks.length) {                                   // current surface, brighter
        var tb = blocks[blocks.length - 1], ttop = sy(topY());
        ctx.save(); ctx.strokeStyle = hexA(tb.body, 0.9); ctx.lineWidth = 2;
        ctx.shadowColor = tb.body; ctx.shadowBlur = 14;
        ctx.beginPath(); ctx.moveTo(sx(tb.x), ttop); ctx.lineTo(sx(tb.x + tb.w), ttop); ctx.stroke();
        ctx.restore();
      }
      for (var d = 0; d < debris.length; d++) {              // clean-up slices, tumbling away
        var p = debris[d];
        ctx.save(); ctx.translate(sx(p.x + p.w / 2), sy(p.y + BH / 2));
        if (!reduced) ctx.rotate(p.rot);
        slab(-p.w / 2, -BH / 2, p.w, BH, p.body, 0.85, BH * 0.12);
        ctx.restore();
      }
      if (mover) {                                           // swinging / falling block
        if (!falling && !over) {                             // guide line + landing ghost
          var gx = sx(mover.x), gc = gx + mover.w / 2;
          ctx.save(); ctx.strokeStyle = hexA(C.acid, 0.22); ctx.lineWidth = 1; ctx.setLineDash([4, 7]);
          ctx.beginPath(); ctx.moveTo(gc, sy(mover.y)); ctx.lineTo(gc, sy(topY())); ctx.stroke();
          ctx.globalAlpha = 0.35; ctx.strokeStyle = C.acid; ctx.setLineDash([]);
          rr(gx, sy(topY()), mover.w, BH, 6); ctx.stroke(); ctx.restore();
        }
        var beat = reduced ? 1 : 0.92 + 0.08 * Math.sin(now / 160);
        ctx.save(); ctx.translate(sx(mover.x + mover.w / 2), sy(mover.y + BH / 2));
        ctx.scale(beat, 1 / beat);
        slab(-mover.w / 2, -BH / 2, mover.w, BH, mover.body, 1, BH * 0.08);
        ctx.restore();
      }
      // Floating call-out: PERFECT xN / LEVEL N / MISSED THE EDGE.
      if (now - toastT < 900) {
        var a = 1 - (now - toastT) / 900, tc = combo > 0 && toastText.indexOf('PERFECT') === 0 ? C.acid : C.magenta;
        ctx.save(); ctx.globalAlpha = a; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.font = '900 ' + Math.round(clamp(Math.min(h * 0.07, w * 0.075), 13, 30)) + 'px Orbitron, system-ui, sans-serif';
        ctx.fillStyle = tc; ctx.shadowColor = tc; ctx.shadowBlur = 20;
        ctx.fillText(toastText, cx, sy(topY()) - h * 0.1 - (1 - a) * h * 0.03);
        ctx.restore();
      }
      ctx.restore();
      /* --------------------------- HUD + CRT --------------------------- */
      var padS = 12, top = Math.max(16, h * 0.045), fam = 'Rajdhani, system-ui, sans-serif';
      var tScore = 'SCORE ' + score, tMid = 'LV ' + level + ' · H ' + blocks.length, tBest = 'BEST ' + (bestEver || 0);
      var fs = Math.round(clamp(Math.min(h * 0.042, w * 0.05), 10, 17));
      ctx.textBaseline = 'middle';
      /* Three readouts share one strip. On a narrow phone a five-digit score used to
         run into the centred LV readout, so step the size down until each pair keeps
         a clear gap — the oracle only sees the canvas edges, never this collision. */
      function hudFits(px) {
        ctx.font = '700 ' + px + 'px ' + fam;
        var a = ctx.measureText(tScore).width, b = ctx.measureText(tMid).width, c = ctx.measureText(tBest).width;
        var gap = Math.max(8, w * 0.03);
        return padS + a + gap <= w / 2 - b / 2 && w / 2 + b / 2 + gap <= w - padS - c;
      }
      while (fs > 8 && !hudFits(fs)) fs -= 1;
      ctx.font = '700 ' + fs + 'px ' + fam;
      // The strip sits on near-black, so the side readouts need the same glow
      // as SCORE — the dim ink alone was almost invisible at 1:1 and worse on a phone.
      ctx.fillStyle = C.ink; ctx.shadowColor = C.cyan; ctx.shadowBlur = 10;
      ctx.textAlign = 'left'; ctx.fillText(tScore, padS, top);
      ctx.fillStyle = hexA(C.ink, 0.92); ctx.shadowBlur = 6; ctx.textAlign = 'right';
      ctx.fillText(tBest, w - padS, top);
      ctx.fillStyle = now - flashAt < 320 ? C.acid : hexA(C.ink, 0.92);
      ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 8; ctx.textAlign = 'center';
      ctx.fillText(tMid, w / 2, top);
      ctx.shadowBlur = 0;
      if (combo > 1) {                                       // combo meter, only while it runs
        ctx.fillStyle = C.acid; ctx.shadowColor = C.acid; ctx.shadowBlur = 12;
        ctx.fillText('COMBO x' + combo, w / 2, top + fs * 1.5); ctx.shadowBlur = 0;
      }
      if (!reduced) { ctx.fillStyle = 'rgba(0,0,0,.16)';
        for (var sl = 0; sl < h; sl += 3) ctx.fillRect(0, sl, w, 1); }
      var vig = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75);
      vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(0,0,0,.55)');
      ctx.fillStyle = vig; ctx.fillRect(0, 0, w, h);
      if (paused && !over) card('PAUSED', 'Tap or press SPACE to resume', C.cyan);
      else if (now - bootAt < 2600 && !over) card('STACK TOWER', 'Tap anywhere or press SPACE to drop', C.cyan, null, true);
      if (over) card('GAME OVER', 'SCORE ' + score + (isRecord ? '  ·  NEW BEST' : ''), C.magenta,
        'TAP or press SPACE to build again');
    }
    /* Card copy is sized from the SMALLER stage dimension and then shrunk again if the
       measured string still overshoots, so a tall portrait stage and a long hint both fit. */
    function setFit(weight, fam, px, str, maxW) {
      px = Math.max(8, Math.floor(px));
      ctx.font = weight + ' ' + px + 'px ' + fam;
      var m = ctx.measureText(str).width;
      if (m > maxW) { px = Math.max(8, Math.floor(px * (maxW / m))); ctx.font = weight + ' ' + px + 'px ' + fam; }
      return px;
    }
    /** Centred overlay: big neon title, one dim line of sub-copy, optional hint. */
    function card(title, sub, color, hint, banner) {
      var pad = Math.max(10, cssW * 0.05);          // breathing room at both edges
      var avail = Math.max(40, cssW - pad * 2);
      ctx.save();
      if (!banner) { ctx.fillStyle = hexA(C.bg, 0.72); ctx.fillRect(0, 0, cssW, cssH); }
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      setFit('900', 'Orbitron, system-ui, sans-serif',
        clamp(Math.min(cssH * 0.12, cssW * 0.115), 14, 54), title, avail);
      ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 26;
      ctx.fillText(title, cssW / 2, cssH * (banner ? 0.34 : 0.42));
      ctx.shadowBlur = 0;
      setFit('600', 'Rajdhani, system-ui, sans-serif',
        clamp(Math.min(cssH * 0.045, cssW * 0.045), 10, 20), sub, avail);
      ctx.fillStyle = C.dim; ctx.fillText(sub, cssW / 2, cssH * (banner ? 0.42 : 0.5));
      if (hint) {
        setFit('600', 'Rajdhani, system-ui, sans-serif',
          clamp(Math.min(cssH * 0.045, cssW * 0.045), 10, 20), hint, avail);
        ctx.fillText(hint, cssW / 2, cssH * (banner ? 0.5 : 0.62));
      }
      ctx.restore();
    }
    /* -------------------------- Single rAF loop -------------------------- */
    var last = 0;
    function frame(now) {
      if (destroyed) return;   // guard: destroy() can land between frames
      if (!ready) { ready = true; last = now; bootAt = now; }
      var dt = Math.min(0.05, Math.max(0, (now - last) / 1000)); // clamp: a backgrounded tab must not fast-forward
      last = now;
      if (!paused) step(dt);
      draw(now);
      if (!destroyed) rafId = requestAnimationFrame(frame);      // never re-arm after teardown
    }
    /* -------------------- Input: keyboard + pointer -------------------- */
    function onKeyDown(e) {
      if (destroyed || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return; // no held-key mashing
      if (e.code === 'Space' || e.code === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        var a = document.activeElement;
        if (a && a !== canvas && /^(BUTTON|INPUT|SELECT|TEXTAREA|A|SUMMARY)$/.test(a.tagName)) return;
        e.preventDefault();
        act();
      }
    }
    function onPointerDown(e) {
      if (destroyed) return;
      if (e.button !== undefined && e.button !== 0) return;   // primary button / touch only
      e.preventDefault();
      // Playing the board is an implicit "give the keyboard back": if focus is
      // still parked on a HUD control, SPACE would re-activate that button
      // instead of dropping, and the player's only key would look broken.
      var a = document.activeElement;
      if (a && a !== canvas && a !== document.body && typeof a.blur === 'function') a.blur();
      if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
      act();
    }
    /* The shell's round-over card sits ON TOP of the canvas and keeps its own
       pointer events, so a tap aimed at the board can land on the card instead.
       The canvas listener never sees it and the run never restarts — the only
       way out is the card's own button. After a run has ended, take the tap on
       whichever element of the stage it hit (board or card) and restart, which
       is what "TAP or press SPACE to build again" promises. Real controls keep
       their clicks: Play again and All games are excluded. */
    function onStagePointerDown(e) {
      if (destroyed || !over) return;                       // live runs: the canvas listener is enough
      if (e.button !== undefined && e.button !== 0) return;
      var t = e.target;
      if (t && t.closest && t.closest('button, a[href], input, select, textarea, [contenteditable]')) return;
      var stage = document.getElementById('game-stage');
      if (!((stage && stage.contains(t)) || wrap.contains(t))) return;   // only taps aimed at the game
      e.preventDefault();
      act();
    }
    function act() {          // the one place input becomes a game action
      if (destroyed) return;
      if (paused) { paused = false; setStatus('Playing'); return; }  // a tap only resumes after a blur
      if (over) { resetRun(); return; }                      // restart a dead run
      drop();
    }
    function onResize() { if (!destroyed) resize(); }
    function onBlur() {
      if (destroyed || over || paused) return;
      paused = true; setStatus('Paused');
    }
    function onVisibility() { if (document.hidden) onBlur(); }
    var BIND = [[document, 'keydown', onKeyDown], [canvas, 'pointerdown', onPointerDown, { passive: false }],
      [document, 'pointerdown', onStagePointerDown, { passive: false }],
      [window, 'resize', onResize, { passive: true }], [window, 'orientationchange', onResize],
      [window, 'blur', onBlur], [document, 'visibilitychange', onVisibility]];
    BIND.forEach(function (b) { b[0].addEventListener(b[1], b[2], b[3]); });
    resetRun(); rafId = requestAnimationFrame(frame);
    return {
      destroy: function () {
        if (destroyed) return;
        destroyed = true; cancelAnimationFrame(rafId);
        // One table in, one table out — teardown cannot miss a listener.
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
    name: 'Stack Tower',
    instructions:
      'One button. The block swings back and forth above the tower — TAP anywhere or press SPACE to drop it. ' +
      'Any overlap trims the block down to what actually sits on the tower and the cut-off slice falls away; ' +
      'land within the shrinking perfect window to snap flush and chain a combo for bonus points. Miss entirely, ' +
      'or shave the tower below nothing, and the run is over. Every 3 blocks the swing speeds up and the perfect ' +
      'window tightens. Best score is saved on this device.',
    start: start
  };
})();
