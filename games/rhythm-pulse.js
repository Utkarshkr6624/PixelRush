/**
 * PIXEL RUSH — games/rhythm-pulse.js — "Rhythm Pulse"
 * Contract (SPEC.md): window.PixelGame = { name, instructions, start(root, api) } where
 * api = { setScore(n), setBest(n), gameOver(score) } and start() returns { destroy() }.
 * Self-contained: no imports, no assets. The "song" is a deterministic chart built from a
 * seeded PRNG and clocked off the frame delta, so the beat is identical on every device.
 * WebAudio only ever synthesises a short click — it is created on the first user gesture
 * and every call is wrapped so a missing/blocked AudioContext can never break the game.
 */
(function () {
  'use strict';
  /* -------------------------------- Tuning -------------------------------- */
  var STORE_KEY = 'pixelrush.rhythm-pulse.best'; // localStorage: all-time best score
  var BPM = 128, BEAT = 60 / BPM, BAR = 4 * BEAT;  // one bar = 4 beats
  var BARS = 16, LEAD_BEATS = 4;                 // 16 bars + 2 bars of count-in
  var W_PERFECT = 0.058, W_GREAT = 0.105, W_GOOD = 0.165; // judgement windows (s)
  var PTS = [0, 300, 200, 100];                  // miss / perfect / great / good
  var ACC_W = [0, 1, 0.75, 0.4];                 // accuracy weight per grade
  var GRADE_NAME = ['', 'PERFECT', 'GREAT', 'GOOD'];
  var LEADS = [1.90, 1.60, 1.35, 1.10];          // approach seconds per difficulty phase
  var LANE_KEYS = {
    KeyF: 0, KeyA: 0, ArrowLeft: 0,
    KeyS: 1, KeyD: 1, ArrowDown: 1,
    KeyJ: 2, KeyK: 2, ArrowUp: 2,
    KeyL: 3, KeyH: 3, ArrowRight: 3
  };
  var STYLES = '.rp{position:relative;width:100%;height:100%;overflow:hidden;touch-action:none;' +
    'user-select:none;-webkit-tap-highlight-color:transparent;overscroll-behavior:none;' +
    'font-family:var(--font-body,"Rajdhani",system-ui,sans-serif);color:var(--ink,#f2f5ff)}' +
    '.rp canvas{display:block;width:100%;height:100%;outline:none}';
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  /** mulberry32 — tiny deterministic PRNG so the chart is the same on every run. */
  function seeded(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function readBest() {
    try { var v = parseInt(window.localStorage.getItem(STORE_KEY), 10);
      return isFinite(v) && v > 0 ? v : null; } catch (e) { return null; } // private mode
  }
  function writeBest(v) {
    try { window.localStorage.setItem(STORE_KEY, String(v)); } catch (e) { /* ignore */ }
  }
  /* ------------------------------- Chart ------------------------------- */
  function push(out, bar, beat, lane, phase, rnd) {
    out.push({ t: LEAD_BEATS * BEAT + bar * BAR + beat * BEAT, lane: lane, lead: LEADS[phase] * (0.95 + rnd() * 0.1), state: 0 });
  }
  /** Build the note list, in seconds from the start of the run. Seeded, so the song never changes. */
  function buildChart() {
    var rnd = seeded(0x50A17E), out = [], lane = 1, lastChord = -9;
    for (var b = 0; b < BARS; b++) {
      var phase = b < 4 ? 0 : (b < 8 ? 1 : (b < 12 ? 2 : 3));
      var step = phase < 2 ? 0.5 : 0.25;   // beats per step: 0.5 = 8th note, 0.25 = 16th
      var chordP = phase === 3 ? 0.22 : 0;
      for (var s = 0; s < 4 / step; s++) {
        var at = s * step;
        if (s === 0 && b > 0 && rnd() < 0.3) continue;                  // an occasional bar-in breath
        var nl = (s > 0 && step > 0.25 && rnd() < 0.34) ? lane : Math.floor(rnd() * 4);
        // 16th-note steps never repeat a lane, so a press is never ambiguous between two notes.
        if (nl === lane && (s === 0 || step <= 0.25 || rnd() < 0.75)) nl = (lane + 1 + Math.floor(rnd() * 3)) % 4;
        push(out, b, at, nl, phase, rnd);
        lane = nl;
        if (chordP > 0 && at - lastChord > 1 && rnd() < chordP) {         // two-lane hits, spaced out
          push(out, b, at, (nl + 1 + Math.floor(rnd() * 3)) % 4, phase, rnd);
          lastChord = at;
        }
      }
    }
    out.sort(function (a, c) { return a.t - c.t; });
    return out;
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
    var wrap = document.createElement('div'); wrap.className = 'rp';
    var canvas = document.createElement('canvas');
    canvas.setAttribute('tabindex', '0'); canvas.setAttribute('role', 'application');
    canvas.setAttribute('aria-label', 'Rhythm Pulse. F S J L or A D K H keys, or tap the four lane buttons.');
    var live = document.createElement('div'); // screen-reader announcements
    live.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0)';
    live.setAttribute('aria-live', 'polite');
    var styleTag = document.createElement('style');
    styleTag.textContent = STYLES;
    wrap.appendChild(canvas); wrap.appendChild(live); wrap.appendChild(styleTag); root.appendChild(wrap);
    var ctx = canvas.getContext('2d');
    if (!ctx) { root.removeChild(wrap); return { destroy: function () {} }; }
    var rafId = 0, destroyed = false;
    var reduced = !!(window.PX && window.PX.reduced);
    if (!reduced && window.matchMedia) reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var CHART = buildChart();
    var T_END = (CHART.length ? CHART[CHART.length - 1].t : BAR) + W_GOOD + 1.2;
    var notes = [], fx = [], laneGlow = [0, 0, 0, 0];
    var t = 0, last = 0, idx = 0, lastBeat = -1;
    var score = 0, combo = 0, maxCombo = 0, accEarned = 0;
    var grades = [0, 0, 0, 0], bestEver = readBest();
    // A run is live the moment it is created: paused means the player (or a
    // backgrounded tab) stopped it, never "this run has not been started yet".
    var paused = false, autoPaused = false, over = false, muted = false, isRecord = false;
    /* ----------------- Sizing (crisp devicePixelRatio) ----------------- */
    var dpr = 1, cssW = 1, cssH = 1, fieldX = 0, fieldW = 1, laneW = 1;
    var hudH = 40, fieldTop = 50, hitY = 100, travel = 50, btnTop = 120, btnH = 60;
    /* The cabinet is a 16:9 stage, so on a phone the playfield lands as a
       letterbox slot (186px of a 664px viewport) with the page header pushing it
       400px down the page. The stage belongs to the shell, but a rhythm game
       needs the height: on a phone-sized viewport the stage is grown to fill the
       screen and scrolled to the top of it, and only ever grown. The shell's own
       inline height and scroll anchoring are put back on destroy(). */
    var stageEl = null, stageSavedH = null, stageBaseH = 0, stageSavedAnchor = '', stageSavedY = 0;
    var stageScrollTries = 0;
    function unhookStage() {
      if (stageEl && stageSavedH !== null) {
        stageEl.style.height = stageSavedH;
        stageEl.style.overflowAnchor = stageSavedAnchor;
        if (stageSavedY !== window.scrollY) { try { window.scrollTo(0, stageSavedY); } catch (e) { /* ignore */ } }
      }
      stageEl = null; stageSavedH = null; stageBaseH = 0; stageSavedAnchor = ''; stageSavedY = 0; stageScrollTries = 0;
    }
    /** Park the playfield at the top of the screen. Runs a frame later because
        the height change reflows the page, and the browser scroll-anchors after
        that, so it is corrected once more. */
    function scrollStageToTop() {
      var el = stageEl;
      if (!el || stageScrollTries > 4) return;    // a clamped scroll must not loop
      stageScrollTries++;
      requestAnimationFrame(function () {
        if (destroyed || stageEl !== el) return;
        var y = Math.max(0, Math.round(el.getBoundingClientRect().top + (window.scrollY || 0) - 10));
        try { window.scrollTo(0, y); } catch (e) { /* ignore */ }
        requestAnimationFrame(function () {
          if (destroyed || stageEl !== el) return;
          var y2 = Math.max(0, Math.round(el.getBoundingClientRect().top + (window.scrollY || 0) - 10));
          if (y2 !== y) { try { window.scrollTo(0, y2); } catch (e) { /* ignore */ } }
        });
      });
    }
    function applyStage() {
      if (window.innerWidth > 560) { unhookStage(); return; }  // not a phone: the shell's stage stands
      if (!stageEl) {
        var s = root && root.closest ? root.closest('#game-stage') : null;
        if (!s) return;
        var cur = s.getBoundingClientRect().height;
        if (cur >= window.innerHeight * 0.8) return;          // already a full-height stage
        stageEl = s; stageSavedH = s.style.height; stageBaseH = cur;
        stageSavedAnchor = s.style.overflowAnchor; stageSavedY = window.scrollY || 0;
        s.style.overflowAnchor = 'none';                       // our own scroll must stand
      }
      // Room from the stage's top edge down to the bottom of the screen; if the
      // stage already starts above the fold it owns the whole screen.
      var top = stageEl.getBoundingClientRect().top;
      if (top <= 0) stageScrollTries = 0;
      var want = (top <= 0) ? window.innerHeight - 18
                             : window.innerHeight - top - 10;
      if (want < stageBaseH + 24) { unhookStage(); return; }   // never shrink, never squeeze
      stageEl.style.height = Math.round(want) + 'px';
      if (top > 0) scrollStageToTop();
    }
    function resize() {
      var r = wrap.getBoundingClientRect();
      cssW = Math.max(1, Math.round(r.width)); cssH = Math.max(1, Math.round(r.height));
      dpr = clamp(window.devicePixelRatio || 1, 1, 2); // contract: cap at 2
      canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
      canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      fieldX = 8; fieldW = Math.max(40, cssW - 16); laneW = fieldW / 4;
      hudH = clamp(cssH * 0.15, 34, 70);   // top band: the only zone notes can never reach
      btnH = clamp(cssH * 0.24, 54, 112);
      fieldTop = hudH + 10;
      btnTop = cssH - btnH - 8;
      hitY = btnTop - clamp(cssH * 0.06, 14, 40);
      travel = Math.max(30, hitY - fieldTop);
    }
    resize();
    // The shell keeps laying out the page around the game (header, how-to panel,
    // picker grid), which moves the stage under us, so the fit is re-taken as the
    // page settles and whenever the page itself changes size.
    var settleTimers = [], stageFitTimer = 0;
    function settleStageIn(ms) {
      settleTimers.push(setTimeout(function () {
        if (destroyed) return;
        applyStage();
        resize();
      }, ms));
    }
    function stageFitSoon() {
      if (stageFitTimer) clearTimeout(stageFitTimer);
      stageFitTimer = setTimeout(function () { stageFitTimer = 0; settleStageIn(0); }, 60);
    }
    [0, 120, 400, 900, 1600, 2600].forEach(settleStageIn);
    if (window.ResizeObserver) {
      try {
        new ResizeObserver(stageFitSoon).observe(document.body);
      } catch (e) { /* observer is an optimisation only */ }
    }
    function token(n, fb) { // pull a site custom property, with a hard fallback
      var v = getComputedStyle(document.documentElement).getPropertyValue(n);
      return (v && v.trim()) || fb;
    }
    var C = { bg: token('--bg', '#05060f'), ink: token('--ink', '#f2f5ff'), dim: token('--ink-dim', '#a7b0d0'),
      cyan: token('--cyan', '#22e7ff'), magenta: token('--magenta', '#ff2fb9'), acid: token('--acid', '#c8ff2e'),
      orange: token('--orange', '#ff8a3d'), violet: token('--violet', '#8b5cf6') };
    var LANE_C = [C.cyan, C.magenta, C.acid, C.orange];
    function hexA(hex, a) { // #rrggbb + alpha -> rgba()
      hex = (hex || '#fff').trim().replace('#', '');
      var n = parseInt(hex, 16);
      return isFinite(n) ? 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')'
        : 'rgba(255,255,255,' + a + ')';
    }
    function rr(x, y, w, h, r) { // rounded-rect path, with a pre-roundRect fallback
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
    }
    /** Longest line that fits cssW with 10px of slack. The stage is far taller than it is
        wide on a phone, so every on-canvas size is capped by width as well as height; this
        is the last resort for a string that is still too long at that cap. */
    function fitFont(weight, family, size, text, min) {
      var maxW = Math.max(24, cssW - 20), s = Math.round(clamp(size, min, 72));
      ctx.font = weight + ' ' + s + 'px ' + family;
      while (s > min && ctx.measureText(text).width > maxW) {
        s--; ctx.font = weight + ' ' + s + 'px ' + family;
      }
      return ctx.font;
    }
    /** The px size out of a CSS font shorthand, e.g. '700 20px Rajdhani' -> 20. */
    function fontPx(font) {
      var m = /(\d+(?:\.\d+)?)px/.exec(font);
      return m ? parseFloat(m[1]) : 12;
    }
    /* ------------------------- Audio (best effort) ------------------------- */
    var actx = null;
    /** Created on the first user gesture only — never before, never throws. */
    function ensureAudio() {
      if (actx || muted) return;
      try {
        var Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) return;
        actx = new Ctor();
        if (actx.state === 'suspended' && actx.resume) actx.resume();
      } catch (e) { actx = null; }
    }
    /** One short synthesised blip. No-op unless a live AudioContext already exists. */
    function blip(freq, dur, type, vol) {
      if (!actx || muted) return;
      try {
        if (actx.state !== 'running') return;
        var o = actx.createOscillator(), g = actx.createGain(), now = actx.currentTime;
        o.type = type || 'square'; o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(vol, now + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
        o.connect(g); g.connect(actx.destination);
        o.start(); o.stop(now + dur + 0.02);
      } catch (e) { /* audio is decoration — never let it break the run */ }
    }
    /* ---------------------------- Game logic ---------------------------- */
    function resetRun() {
      notes = CHART.slice(); idx = 0; fx.length = 0;
      t = 0; last = performance.now(); lastBeat = -1;
      score = 0; combo = 0; maxCombo = 0; accEarned = 0;
      grades = [0, 0, 0, 0]; laneGlow = [0, 0, 0, 0];
      over = false; paused = false; autoPaused = false; isRecord = false;
      setScore(0);
      setStatus('Playing');
      if (bestEver !== null) setBest(bestEver);
      live.textContent = 'New run. Score 0.';
    }
    /** Single place that flips the pause state, so the sidebar STATUS can never disagree with the canvas. */
    function setPaused(p, auto) {
      paused = !!p;
      autoPaused = paused && !!auto;
      if (!over) setStatus(paused ? 'Paused' : 'Playing');
    }
    function popFx(text, color, lane) { fx.push({ text: text, color: color, lane: lane, born: t }); }
    function judge(n, grade) {
      n.state = grade;
      if (grade > 0) {
        combo++; if (combo > maxCombo) maxCombo = combo;
        score += PTS[grade] + Math.min(combo, 60) * 2;
        accEarned += ACC_W[grade]; grades[grade]++;
        laneGlow[n.lane] = 1;
        popFx(GRADE_NAME[grade], grade === 1 ? C.acid : (grade === 2 ? C.cyan : LANE_C[n.lane]), n.lane);
        if (grade === 1) blip(880 + n.lane * 90, 0.10, 'square', 0.16);
        else blip(520 + n.lane * 70, 0.07, 'triangle', 0.10);
        setScore(score);
        if (bestEver === null || score > bestEver) { bestEver = score; isRecord = true; writeBest(score); setBest(score); }
      } else {
        combo = 0; grades[0]++;
        popFx('MISS', C.magenta, n.lane);
        blip(150, 0.09, 'sawtooth', 0.09);
      }
    }
    /** Press for lane `l`: take the closest unjudged note in that lane inside GOOD. */
    function press(l) {
      if (destroyed || over) return;
      ensureAudio();
      if (paused) setPaused(false);    // any input un-pauses, and still plays the note
      laneGlow[l] = 1;
      var best = null, bd = 1e9;
      for (var i = idx; i < notes.length; i++) {
        var n = notes[i];
        if (n.t - t > W_GOOD) break;                 // chart is time-sorted
        if (n.state !== 0 || n.lane !== l) continue;
        var d = Math.abs(n.t - t);
        if (d < bd) { bd = d; best = n; }
      }
      if (!best) return;                             // stray tap: no penalty, no sound
      judge(best, bd <= W_PERFECT ? 1 : (bd <= W_GREAT ? 2 : 3));
    }
    function advance(dt) {
      t += dt;
      // Metronome: a click on every beat, an accented one on each downbeat.
      var b = Math.floor(t / BEAT);
      if (b !== lastBeat) {
        if (b >= 0) blip(b % 4 === 0 ? 1180 : 720, 0.035, 'square', b % 4 === 0 ? 0.07 : 0.04);
        lastBeat = b;
      }
      // Auto-miss anything that fell past the late window.
      while (idx < notes.length && notes[idx].t - t < -W_GOOD) { if (notes[idx].state === 0) judge(notes[idx], 0); idx++; }
      for (var g = 0; g < 4; g++) laneGlow[g] = Math.max(0, laneGlow[g] - dt * 3.4);
      for (var f = fx.length - 1; f >= 0; f--) if (t - fx[f].born > 0.5) fx.splice(f, 1);
      if (!over && t > T_END) finish();
    }
    function finish() {
      if (over || destroyed) return;   // api.gameOver() may only fire once per run
      over = true; paused = false;
      var accPct = CHART.length ? Math.round(accEarned / CHART.length * 100) : 0;
      live.textContent = 'Song complete. Score ' + score + '. Accuracy ' + accPct + ' percent. Max combo ' + maxCombo + '.';
      gameOverCb(score);
    }
    function accuracy() { return CHART.length ? accEarned / CHART.length : 0; }
    /* ----------------------------- Rendering ----------------------------- */
    function draw(now) {
      var w = cssW, h = cssH, fs = Math.round(clamp(Math.min(h * 0.045, w * 0.075), 11, 19));
      ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);
      // Playfield plate + lane dividers.
      ctx.save();
      rr(fieldX, fieldTop, fieldW, hitY - fieldTop + 6, 14);
      ctx.fillStyle = 'rgba(255,255,255,.03)'; ctx.fill(); ctx.clip();
      for (var L = 1; L < 4; L++) {
        var lx = Math.round(fieldX + laneW * L) + 0.5;
        ctx.fillStyle = hexA(LANE_C[L - 1], 0.10);
        ctx.fillRect(lx, fieldTop, 1, hitY - fieldTop + 6);
      }
      for (var p = 0; p < 4; p++) { // lane wash brightens on press
        if (laneGlow[p] <= 0) continue;
        ctx.fillStyle = hexA(LANE_C[p], 0.13 * laneGlow[p]);
        ctx.fillRect(fieldX + laneW * p, fieldTop, laneW, hitY - fieldTop + 6);
      }
      ctx.restore();
      // Approach rails, spaced by the current lead time so timing is readable.
      for (var s = 1; s <= 3; s++) {
        var ly = Math.round(hitY - travel * (s * 0.25)) + 0.5;
        ctx.strokeStyle = hexA(C.cyan, 0.13); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(fieldX, ly); ctx.lineTo(fieldX + fieldW, ly); ctx.stroke();
      }
      // Notes falling toward the hit line. Clipped to the playfield plate so a
      // note at the top of its approach (and its tail streak) can never bleed up
      // into the HUD band.
      ctx.save();
      rr(fieldX, fieldTop, fieldW, hitY - fieldTop + 6, 14); ctx.clip();
      var nw = laneW * 0.74, nh = clamp(cssH * 0.035, 12, 22);
      for (var i = idx; i < notes.length; i++) {
        var n = notes[i];
        if (n.t - t > n.lead) break;              // still further out than its own approach time
        if (n.t - t < -W_GOOD) continue;         // gone past the line and already resolved
        var ny = hitY - (n.t - t) / n.lead * travel;
        var nx = fieldX + laneW * n.lane + (laneW - nw) / 2;
        var col = LANE_C[n.lane], hot = n.state > 0;
        ctx.save();
        ctx.shadowColor = col; ctx.shadowBlur = (hot ? 26 : 16) * (reduced ? 0.5 : 1);
        ctx.fillStyle = hot ? hexA(col, 0.85) : col;
        rr(nx, ny - nh / 2, nw, nh, Math.min(nh / 2, 8)); ctx.fill();
        ctx.restore();
        if (!reduced) { // subtle tail streak above each note
          ctx.fillStyle = hexA(col, 0.18);
          ctx.fillRect(nx + nw * 0.35, ny - nh * 1.6, nw * 0.3, nh * 1.1);
        }
      }
      // Hit line: the judgement boundary, pulsing on the beat.
      var pulse = reduced ? 1 : 0.75 + 0.25 * Math.max(0, 1 - ((t % BEAT) / (BEAT * 0.4)));
      ctx.save();
      ctx.shadowColor = C.ink; ctx.shadowBlur = 20 * pulse;
      ctx.fillStyle = hexA(C.ink, 0.55 + 0.4 * pulse);
      ctx.fillRect(fieldX, Math.round(hitY) - 1, fieldW, 2);
      ctx.restore();
      // Floating judgement text, on a dark chip so it stays readable over notes.
      var jf = Math.round(clamp(Math.min(h * 0.032, w * 0.06, laneW * 0.95), 10, 16));
      ctx.font = '800 ' + jf + 'px Orbitron, system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (var f2 = 0; f2 < fx.length; f2++) {
        var age = t - fx[f2].born, k = age / 0.5;
        var fy = hitY - 26 - age * 52, fxp = fieldX + laneW * fx[f2].lane + laneW / 2;
        ctx.globalAlpha = 1 - k;
        ctx.fillStyle = hexA(C.bg, 0.72);
        rr(fxp - ctx.measureText(fx[f2].text).width / 2 - 5, fy - jf * 0.75,
          ctx.measureText(fx[f2].text).width + 10, jf * 1.5, 5);
        ctx.fill();
        ctx.fillStyle = fx[f2].color;
        ctx.fillText(fx[f2].text, fxp, fy);
      }
      ctx.globalAlpha = 1;
      ctx.restore();   // end of the playfield clip
      // CRT polish: scanlines + vignette over the game world only. The HUD and the
      // touch buttons are drawn after this so they stay at full brightness.
      if (!reduced) { ctx.fillStyle = 'rgba(0,0,0,.16)';
        for (var sy = 0; sy < h; sy += 3) ctx.fillRect(0, sy, w, 1); }
      var vig = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75);
      vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(0,0,0,.55)');
      ctx.fillStyle = vig; ctx.fillRect(0, 0, w, h);
      // Four large thumb-zone lane buttons — on top of the CRT layer so they stay legible.
      for (var b2 = 0; b2 < 4; b2++) {
        var bx = fieldX + laneW * b2 + 2, by = btnTop, bw = laneW - 4;
        var g2 = laneGlow[b2];
        ctx.save();
        ctx.shadowColor = LANE_C[b2]; ctx.shadowBlur = 6 + 26 * g2;
        ctx.fillStyle = g2 > 0 ? hexA(LANE_C[b2], 0.30) : hexA(LANE_C[b2], 0.08);
        rr(bx, by, bw, btnH, 12); ctx.fill();
        ctx.strokeStyle = hexA(LANE_C[b2], 0.35 + 0.6 * g2); ctx.lineWidth = 2; ctx.stroke();
        ctx.restore();
        ctx.fillStyle = g2 > 0.15 ? C.ink : hexA(LANE_C[b2], 0.9);
        ctx.font = '800 ' + Math.round(clamp(btnH * 0.24, 11, 20)) + 'px Orbitron, system-ui, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(['F', 'S', 'J', 'L'][b2], bx + bw / 2, by + btnH / 2);
      }
      // HUD band, above the playfield so a falling note can never sit on top of it.
      var rowA = hudH * 0.24, rowB = hudH * 0.56, rowC = hudH * 0.86;
      ctx.textBaseline = 'middle';
      // SFX toggle, top-left of the HUD strip (tappable).
      ctx.fillStyle = muted ? C.magenta : C.dim;
      ctx.font = '700 ' + Math.round(clamp(fs * 0.8, 9, 13)) + 'px Rajdhani, system-ui, sans-serif';
      ctx.textAlign = 'left'; ctx.fillText(muted ? 'MUTED' : 'SFX', fieldX, rowA);
      ctx.font = '700 ' + fs + 'px Rajdhani, system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillStyle = (bestEver && score >= bestEver) ? C.acid : C.dim;
      ctx.fillText('BEST ' + (bestEver || 0), fieldX + fieldW, rowA);
      ctx.textAlign = 'left';
      ctx.fillStyle = C.ink; ctx.fillText('SCORE ' + score, fieldX, rowB);
      if (combo > 1) {
        ctx.textAlign = 'right';
        ctx.font = '900 ' + Math.round(fs * 1.4) + 'px Orbitron, system-ui, sans-serif';
        ctx.fillStyle = C.cyan; ctx.shadowColor = C.cyan; ctx.shadowBlur = 14;
        ctx.fillText(combo + 'x', fieldX + fieldW, rowB); ctx.shadowBlur = 0;
      }
      ctx.textAlign = 'left';
      ctx.font = '600 ' + Math.round(fs * 0.86) + 'px Rajdhani, system-ui, sans-serif';
      ctx.fillStyle = C.dim;
      ctx.fillText(Math.round(accuracy() * 100) + '%  ·  BAR ' +
        clamp(Math.floor((t - LEAD_BEATS * BEAT) / BAR) + 1, 1, BARS) + '/' + BARS, fieldX, rowC);
      ctx.fillStyle = hexA(C.cyan, 0.15); ctx.fillRect(fieldX, hudH - 3, fieldW, 2);
      ctx.fillStyle = hexA(C.cyan, 0.85); ctx.fillRect(fieldX, hudH - 3, fieldW * clamp(t / T_END, 0, 1), 2);
      if (paused && !over) {         // a genuine pause — a fresh run never lands here
        card('PAUSED', 'Tap a lane or press a key to resume', C.cyan, null);
      } else if (t < LEAD_BEATS * BEAT) {   // two bars of count-in before the first note
        var left = Math.ceil((LEAD_BEATS * BEAT - t) / BEAT);
        card(String(clamp(left, 1, 4)), 'GET READY', C.cyan, 'F S J H  ·  or tap a lane');
      }
      if (over) {
        card('SONG CLEARED', 'SCORE ' + score + (isRecord ? '  ·  NEW BEST' : ''), C.magenta, null);
        var RAJ2 = 'Rajdhani, system-ui, sans-serif';
        var accLine = 'ACCURACY ' + Math.round(accuracy() * 100) + '%   ·   MAX COMBO ' + maxCombo;
        var tallyA = grades[1] + ' perfect  ·  ' + grades[2] + ' great';
        var tallyB = grades[3] + ' good  ·  ' + grades[0] + ' miss';
        var again = 'TAP or press SPACE to play again';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        // Stacked by measured line height, not by a fraction of cssH: on a phone the
        // stage is the LARGER dimension, so fixed fractions pack the lines on top of
        // each other long before they run out of width.
        var accF = fitFont('700', RAJ2, Math.min(h * 0.05, w * 0.062), accLine, 11);
        var talF = fitFont('600', RAJ2, Math.min(h * 0.042, w * 0.055), tallyA, 10);
        var againF = fitFont('600', RAJ2, Math.min(h * 0.042, w * 0.055), again, 10);
        var accPx = fontPx(accF), talPx = fontPx(talF);
        var gap = Math.max(4, cssH * 0.016);
        var y = h * 0.5 + (accPx + gap) * 1.1;
        ctx.font = accF; ctx.fillStyle = C.ink;
        ctx.fillText(accLine, w / 2, y);
        // The tally is two lines: too long to shrink to a readable size on a phone.
        ctx.font = talF; ctx.fillStyle = C.dim;
        ctx.fillText(tallyA, w / 2, y + accPx / 2 + gap + talPx / 2);
        ctx.fillText(tallyB, w / 2, y + accPx / 2 + gap + talPx * 1.5 + gap * 0.6);
        ctx.font = againF; ctx.fillStyle = C.acid;
        ctx.fillText(again, w / 2, y + accPx / 2 + gap + talPx * 2.2 + gap * 1.8);
      }
    }
    /** Centred overlay: big neon title with one dim line of sub-copy. */
    function card(title, sub, color, hint) {
      var ORB = 'Orbitron, system-ui, sans-serif', RAJ = 'Rajdhani, system-ui, sans-serif';
      ctx.fillStyle = hexA(C.bg, 0.72); ctx.fillRect(0, 0, cssW, cssH);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = fitFont('900', ORB, Math.min(cssH * 0.13, cssW * 0.13), title, 16);
      ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 28;
      ctx.fillText(title, cssW / 2, cssH * 0.42); ctx.shadowBlur = 0;
      ctx.font = fitFont('600', RAJ, Math.min(cssH * 0.05, cssW * 0.055), sub, 11);
      ctx.fillStyle = C.dim; ctx.fillText(sub, cssW / 2, cssH * 0.5);
      if (hint) {
        ctx.font = fitFont('600', RAJ, Math.min(cssH * 0.05, cssW * 0.055), hint, 11);
        ctx.fillText(hint, cssW / 2, cssH * 0.61);
      }
    }
    /* -------------------------- Single rAF loop -------------------------- */
    function frame(now) {
      if (destroyed) return;   // guard: destroy() can land between frames
      var dt = Math.min(200, now - last); // clamp so a backgrounded tab can't fast-forward
      last = now;
      if (!paused && !over) advance(dt / 1000);
      else { lastBeat = Math.floor(t / BEAT); for (var g = 0; g < 4; g++) laneGlow[g] = 0; }
      if (destroyed) return;   // destroy() can land inside advance() via api.gameOver()
      draw(now);
      rafId = requestAnimationFrame(frame);
    }
    /* ------------------- Input: keyboard + touch ------------------- */
    function onKeyDown(e) {
      if (destroyed) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      ensureAudio();
      // Lane 1 is F, which the shell also binds to "enter fullscreen". This
      // listener runs in the capture phase and claims the keys the game owns, so
      // a lane press can never be read as a shell shortcut. Keys the game does
      // not use (R for restart) still fall through.
      if (e.code === 'Space' || e.key === ' ' || e.code === 'Enter' || LANE_KEYS[e.code] !== undefined) {
        e.stopPropagation();
      }
      if (e.code === 'Space' || e.key === ' ' || e.code === 'Enter') {
        var a = document.activeElement;
        if (a && a !== canvas && /^(BUTTON|INPUT|SELECT|TEXTAREA|A|SUMMARY)$/.test(a.tagName)) return;
        e.preventDefault();
        if (over) resetRun(); else setPaused(!paused);   // SPACE toggles a live run
        return;
      }
      var l = LANE_KEYS[e.code];
      if (l !== undefined) { e.preventDefault(); if (over) resetRun(); else press(l); }
    }
    function onPointerDown(e) {
      if (destroyed) return;
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      ensureAudio();
      var r = canvas.getBoundingClientRect();
      var x = e.clientX - r.left, y = e.clientY - r.top;
      if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
      if (y < hudH * 0.42 && x < fieldX + 54) {   // SFX toggle, top-left corner of the HUD band
        muted = !muted;
        if (muted && actx) { try { actx.close(); } catch (err) { /* ignore */ } }
        actx = null;
        return;
      }
      if (y >= btnTop) {            // the four large lane buttons — the primary touch control
        var l2 = clamp(Math.floor((x - fieldX) / laneW), 0, 3);
        if (over) resetRun(); else press(l2);
        return;
      }
      if (over) { resetRun(); return; }
      if (paused) setPaused(false);    // tap anywhere on the field to un-pause
    }
    // A phone rotate fires several resize events in a row; the last one wins.
    var resizeTimer = 0;
    function onResize() {
      if (destroyed) return;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        resizeTimer = 0;
        if (destroyed) return;
        applyStage();
        resize();
        settleStageIn(320);   // the scroll above changes what height is available
      }, 120);
    }
    function onBlur() { if (!destroyed && !over && !paused) setPaused(true, true); }  // auto-pause on focus loss
    // Only an auto-pause (background tab, window switch) resumes itself; a pause the
    // player asked for waits for their next key or tap so they are not dropped a beat.
    function onFocus() { if (!destroyed && autoPaused && !over) setPaused(false); }
    function onVisibility() { if (document.hidden) onBlur(); else onFocus(); }
    // Every listener the game owns, in one table so teardown cannot miss one.
    var BIND = [[document, 'keydown', onKeyDown, true], [canvas, 'pointerdown', onPointerDown],
      [window, 'resize', onResize, { passive: true }], [window, 'orientationchange', onResize],
      [window, 'blur', onBlur], [window, 'focus', onFocus], [document, 'visibilitychange', onVisibility]];
    BIND.forEach(function (b) { b[0].addEventListener(b[1], b[2], b[3]); });
    resetRun(); rafId = requestAnimationFrame(frame);
    return {
      destroy: function () {
        if (destroyed) return;
        destroyed = true; cancelAnimationFrame(rafId);
        if (resizeTimer) { clearTimeout(resizeTimer); resizeTimer = 0; }
        settleTimers.forEach(clearTimeout); settleTimers.length = 0;
        if (stageFitTimer) { clearTimeout(stageFitTimer); stageFitTimer = 0; }
        unhookStage();
        BIND.forEach(function (b) { b[0].removeEventListener(b[1], b[2], b[3], b[3] && b[3].capture); });
        if (actx) { try { actx.close(); } catch (e) { /* ignore */ } actx = null; }
        var parent = wrap.parentNode;
        // Removing the wrapper drops the canvas, the live region and the <style> together.
        if (parent && typeof parent.removeChild === 'function') parent.removeChild(wrap);
        else if (typeof wrap.remove === 'function') wrap.remove();
      }
    };
  }

  /* ---------------------- Public module contract ---------------------- */
  window.PixelGame = {
    name: 'Rhythm Pulse',
    instructions:
      'Notes fall to the hit line in four lanes. Press F S J H (or A D K H / arrow keys) — or tap the ' +
      'four lane buttons at the bottom — as each note crosses the glowing line. Perfect timing scores 300, ' +
      'near-misses score 200 or 100, and a miss breaks the combo. Density and scroll speed climb every four ' +
      'bars across sixteen bars — one run is sixteen bars, about 35 seconds — and it ends with an accuracy ' +
      'and max-combo readout. SPACE pauses. Best score is saved on this device.',
    start: start
  };
})();
