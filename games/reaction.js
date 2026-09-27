/**
 * PIXEL RUSH — games/reaction.js
 * Game module #1: "Neon Reaction"
 *
 * Contract (SPEC.md §"games/reaction.js contract"):
 *   window.PixelGame = { name, instructions, start(root, api) -> { destroy() } }
 *   api = { setScore(n), setBest(n), gameOver(score) }
 *
 * Self-contained: no imports, no dependencies, no assets.
 * All visuals are drawn on a single <canvas> with 2D context; all styling that
 * the spec does not name is injected from this file (see STYLE BLOCK below).
 *
 * Rule: every rAF id, timer id and event listener created in start() is torn
 * down in destroy(). Nothing survives the shell navigating away.
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Tuning
   * ------------------------------------------------------------------ */
  /* localStorage: all-time best ms. This MUST NOT be the shell's record key
     ('pixelrush.<slug>.best', js/player.js:33): the shell treats that number
     as higher-is-better, and every value this game reports is a reaction time
     where LOWER is better. Sharing the key made the shell's gameOver(avg) and
     setScore(ms) overwrite the record with the slowest thing on screen. */
  var STORE_KEY   = 'pixelrush.reaction.bestms';
  var MAX_ROUNDS  = 20;   // run ends after this many scored rounds
  var MAX_MISSES  = 5;    // run ends after this many timeouts
  var MIN_DELAY   = 900;  // ms of "WAIT" before the panel lights up
  var MAX_DELAY   = 3400; // ms …and its upper bound
  var EARLY_GRACE = 180;  // clicks closer than this to the flash = false start
  var PANEL_W = 0.42;   // panel width as a fraction of the stage width (the
                        // height is derived from it, so the panel is never distorted)

  /* ------------------------------------------------------------------ *
   * STYLE BLOCK — everything the spec does not name, injected by this file.
   * Prefixed `rx-` so it can never collide with base.css / games.css, and
   * every rule is scoped to the wrapper this file creates, so nothing outside
   * the game stage is styled. The HTML owner can safely delete all of it.
   * ------------------------------------------------------------------ */
  var STYLES = [
    '.rx{position:relative;width:100%;height:100%;display:grid;place-items:center;',
    'font-family:var(--font-body,"Rajdhani",system-ui,sans-serif);color:var(--ink,#f2f5ff);}',
    '.rx canvas{display:block;width:100%;height:100%;touch-action:manipulation;',
    'cursor:pointer;-webkit-tap-highlight-color:transparent;}',
    '.rx__sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;',
    'clip:rect(0 0 0 0);white-space:nowrap;border:0;}',
    '@media (prefers-reduced-motion:reduce){.rx canvas{transition:none;}}'
  ].join('\n');

  function randInt(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function readBest() {
    try {
      var v = parseInt(window.localStorage.getItem(STORE_KEY), 10);
      return isFinite(v) && v > 0 ? v : null;
    } catch (e) { return null; } // private mode / disabled storage
  }
  function writeBest(ms) {
    try { window.localStorage.setItem(STORE_KEY, String(ms)); } catch (e) { /* ignore */ }
  }

  /**
   * start(root, api) — build the game inside `root` and return { destroy }.
   * @param {HTMLElement} root
   * @param {{setScore:Function,setBest:Function,gameOver:Function}} api
   */
  function start(root, api) {
    api = api || {};
    var setScore   = typeof api.setScore === 'function'   ? api.setScore   : function () {};
    var setBest    = typeof api.setBest === 'function'    ? api.setBest    : function () {};
    var gameOverCb = typeof api.gameOver === 'function'  ? api.gameOver  : function () {};

    /* ---------------- DOM ---------------- */
    var wrap = document.createElement('div');
    wrap.className = 'rx';
    var canvas = document.createElement('canvas');
    canvas.setAttribute('role', 'button');
    canvas.setAttribute('tabindex', '0');
    canvas.setAttribute('aria-label', 'Neon Reaction game area. Press space or tap when the panel lights up.');
    var live = document.createElement('div');
    live.className = 'rx__sr';
    live.setAttribute('aria-live', 'polite');
    wrap.appendChild(canvas);
    wrap.appendChild(live);
    root.appendChild(wrap);

    var styleTag = document.createElement('style');
    styleTag.textContent = STYLES;
    wrap.appendChild(styleTag);

    var ctx = canvas.getContext('2d');
    if (!ctx) { root.removeChild(wrap); return { destroy: function () {} }; }

    /* ---------------- State ---------------- */
    var STATE = { IDLE: 0, WAIT: 1, GO: 2, MISS: 3, OVER: 4 };
    var state       = STATE.IDLE;
    var rafId       = 0;
    var timerId     = 0;
    var destroyed   = false;

    var round       = 0;
    var misses      = 0;
    var times       = [];   // reaction times for the current run
    var bestEver    = readBest();
    var bestRun     = null;  // best time inside this run
    var avgRun      = null;  // live average, ms
    var t0          = 0;     // performance.now() when GO fired
    var flashAt     = 0;     // timestamp of the last flash (drives the glow pulse)
    var lastPress   = -1e9;  // timestamp of the last accepted input (far enough back that the very first press always lands)
    var lastShown   = 0;     // ms shown in the big readout
    var shownColor  = '#6b7599';
    var dir         = 1;     // arrow direction: 1 = up, 0 = down

    /* ---------------- Sizing (crisp devicePixelRatio) ---------------- */
    var dpr = 1, cssW = 0, cssH = 0;
    function resize() {
      var r = wrap.getBoundingClientRect();
      cssW = Math.max(1, Math.round(r.width));
      cssH = Math.max(1, Math.round(r.height));
      dpr = clamp(window.devicePixelRatio || 1, 1, 3); // cap DPR: fill-rate win on 3x phones
      canvas.width  = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.width  = cssW + 'px';
      canvas.style.height = cssH + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();

    /* ---------------- Colours (pulled from the site tokens) ---------------- */
    function token(name, fallback) {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name);
      return (v && v.trim()) || fallback;
    }
    var C = {
      bg:      token('--bg', '#05060f'),
      ink:     token('--ink', '#f2f5ff'),
      dim:     token('--ink-dim', '#a7b0d0'),
      mute:    token('--ink-mute', '#6b7599'),
      cyan:    token('--cyan', '#22e7ff'),
      magenta: token('--magenta', '#ff2fb9'),
      acid:    token('--acid', '#c8ff2e'),
      orange:  token('--orange', '#ff8a3d')
    };

    /* ---------------- Round flow ---------------- */
    function scheduleNext() {
      if (destroyed) return;
      state = STATE.WAIT;
      dir = Math.random() < 0.5 ? 1 : 0;
      clearTimeout(timerId);
      // Randomised delay so the rhythm is unlearnable.
      timerId = setTimeout(onGo, randInt(MIN_DELAY, MAX_DELAY));
    }

    function onGo() {
      if (destroyed) return;
      state = STATE.GO;
      t0 = performance.now();
      flashAt = t0;
      shownColor = C.cyan;
      // A miss is a full reaction window with no input.
      timerId = setTimeout(onMiss, 2200);
    }

    function onMiss() {
      if (destroyed) return;
      clearTimeout(timerId);
      misses++;
      state = STATE.MISS;
      shownColor = C.magenta;
      lastShown = 0;
      live.textContent = 'Missed. ' + misses + ' of ' + MAX_MISSES + ' misses.';
      say(missCopy());
      if (misses >= MAX_MISSES) { endRun(); return; }
      setTimeout(scheduleNext, 750);
    }

    function onInput() {
      if (destroyed) return;
      var now = performance.now();
      if (now - lastPress < 90) return;  // debounce pointer + key firing together
      lastPress = now;

      if (state === STATE.IDLE)  { state = STATE.WAIT; scheduleNext(); return; }
      /* The run is over: the shell's "ROUND OVER" dialog owns the screen now.
         Its scrim is pointer-events:none, so taps and SPACE still reach us and
         used to reset the run *behind* the dialog (and, on a 0-hit run, the
         shell could not retire the scrim because setScore(0) is not lower than
         the 0 it recorded). The only way out is Play again / All games, both
         of which go through the shell — so the game must stay frozen here. */
      if (state === STATE.OVER)  { return; }
      if (state === STATE.MISS || state === STATE.WAIT) {
        // Pressed too early: no penalty beyond wasting the round, restart the wait.
        state = STATE.WAIT;
        shownColor = C.orange;
        lastShown = 0;
        say('Too early — wait for the flash');
        clearTimeout(timerId);
        scheduleNext();
        return;
      }
      if (state === STATE.GO) {
        var ms = Math.round(now - t0);
        // A press inside EARLY_GRACE is a mis-tap, not a superhuman reaction.
        // It must not be silent: a discarded press used to re-arm the round
        // with no score, no miss and no message, so the player could sit
        // through dozens of flashes with the round counter frozen.
        if (ms < EARLY_GRACE) {
          state = STATE.WAIT;
          shownColor = C.orange;
          lastShown = 0;
          live.textContent = 'Too soon. That press landed ' + ms +
            ' milliseconds after the flash and was not counted.';
          say(JUMP_COPY);
          clearTimeout(timerId);
          scheduleNext();
          return;
        }
        registerTime(ms);
      }
    }

    function registerTime(ms) {
      clearTimeout(timerId);
      round++;
      times.push(ms);
      lastShown = ms;
      shownColor = (ms <= 300) ? C.acid : (ms <= 550 ? C.cyan : C.orange);
      // Every number in this game is milliseconds, so the HUD, the persisted
      // best and the final result all speak the same language: lower is better.
      var sum = 0, i;
      for (i = 0; i < times.length; i++) sum += times[i];
      avgRun = Math.round(sum / times.length);
      if (bestRun === null || ms < bestRun) bestRun = ms;

      var isRecord = (bestEver === null || ms < bestEver);
      if (isRecord) { bestEver = ms; writeBest(ms); setBest(ms); }

      setScore(ms);
      live.textContent = ms + ' milliseconds.' + (isRecord ? ' New personal best.' : '');
      say(TIME_COPY[ms <= 300 ? 0 : (ms <= 550 ? 1 : 2)]);

      if (round >= MAX_ROUNDS) { endRun(); return; }
      setTimeout(scheduleNext, 520); // beat between rounds
    }

    function endRun() {
      if (destroyed) return;
      clearTimeout(timerId);
      state = STATE.OVER;
      shownColor = C.cyan;
      // The result of a run is the average reaction time across the rounds played.
      var result = avgRun !== null ? avgRun : 0;
      live.textContent = 'Run over. Average ' + result + ' milliseconds, best ' +
        (bestRun !== null ? bestRun : 0) + '.';
      // The sidebar must show the same number the game-over card is about to
      // show, so publish the run result first.
      setScore(result);
      // Order matters. Both shell calls (setScore and gameOver) compare the
      // number they are given against their higher-is-better store and, when
      // it wins, push that number into the sidebar themselves — so our own
      // record has to be re-published *after* them or the HUD flips back to
      // the slowest time of the run the moment the dialog opens.
      gameOverCb(result);
      setBest(bestEver === null ? 0 : bestEver);
      syncDialogBest();
    }

    /* The shell renders the card's "Best" line from its own higher-is-better
       record, which for a reaction-time game holds the *slowest* number it has
       seen. The shell exposes no lower-is-better path, so the one number it
       cannot be told about is corrected here, once, right after we ask it to
       show the card. Best-effort: no-op if the dialog markup is not there. */
    function syncDialogBest() {
      try {
        // The dialog is a sibling of #game-root (the shell appends it to
        // #game-stage), so a query rooted at our own wrapper can never see it —
        // that is why the card kept showing the shell's stale number.
        var line = document.querySelector('.p-over__best');
        if (line) line.textContent = 'Best ' + (bestEver === null ? 0 : bestEver);
      } catch (e) { /* never let cosmetics break the game */ }
    }

    /* ---------------- Rendering ---------------- */
    function say(text) { sayText = text; sayUntil = performance.now() + 900; }
    var sayText = 'TAP or press SPACE to begin';
    var sayUntil = 0;

    function roundRect(x, y, w, h, r) {
      ctx.beginPath();
      if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);       ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    function draw(now) {
      var w = cssW, h = cssH;
      var lit = state === STATE.GO;
      var pulse = lit ? clamp(1 - (now - flashAt) / 900, 0, 1) : 0;
      var glow = lit ? shownColor : (state === STATE.MISS ? C.magenta : C.cyan);

      /* Backdrop: dark base + soft neon halo behind the panel */
      ctx.fillStyle = C.bg;
      ctx.fillRect(0, 0, w, h);
      var halo = ctx.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, Math.max(w, h) * 0.6);
      halo.addColorStop(0, hexA(glow, 0.22 + pulse * 0.4));
      halo.addColorStop(1, hexA(glow, 0));
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, w, h);

      /* HUD row: round / misses / best */
      ctx.font = '600 ' + Math.round(h * 0.045) + 'px Rajdhani, system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = C.dim;
      ctx.textAlign = 'left';   ctx.fillText('ROUND ' + round + ' / ' + MAX_ROUNDS, w * 0.06, h * 0.10);
      ctx.textAlign = 'center'; ctx.fillStyle = misses ? C.magenta : C.mute;
      ctx.fillText('MISS ' + misses + ' / ' + MAX_MISSES, w / 2, h * 0.10);
      ctx.textAlign = 'right';  ctx.fillStyle = C.dim;
      /* "TAP TO START" belongs to the idle screen only — the slot is the
         best-time readout for the rest of the session, and it used to sit
         claiming a fresh game was needed while round 1 was already running. */
      ctx.fillText(bestSlot(), w * 0.94, h * 0.10);

      /* The panel: dim until the flash, then bloomed.
         The bottom band (big readout + status line) is reserved FIRST and
         stacked from the bottom edge on its own baselines: computing the
         readout as "panel bottom + 10% of h" and the status as "93% of h"
         made the two land on the same y on a vertically centred panel, so the
         900-weight number printed straight through the 600-weight sentence. */
      var statusY  = h - h * 0.045;
      var readoutY = statusY - h * 0.115;
      var readoutTop = readoutY - h * 0.06;   // top of the 0.11h readout glyphs
      var pw = Math.min(w * PANEL_W, h * 0.5), ph = pw * 1.25;
      if (ph > readoutTop - h * 0.03) {       // short stage: shrink the panel, never the band
        ph = Math.max(h * 0.18, readoutTop - h * 0.03);
        pw = ph / 1.25;
      }
      var px = (w - pw) / 2;
      var py = (h - ph) / 2 + h * 0.02;
      if (py + ph > readoutTop - h * 0.02) py = Math.max(0, readoutTop - h * 0.02 - ph);
      ctx.save();
      ctx.shadowColor = hexA(glow, lit ? 0.95 : 0.25);
      ctx.shadowBlur  = lit ? 40 + pulse * 50 : 14;
      roundRect(px, py, pw, ph, Math.min(22, pw * 0.08));
      ctx.fillStyle = lit ? hexA(glow, 0.16) : 'rgba(255,255,255,.035)';
      ctx.fill();
      ctx.lineWidth = Math.max(2, pw * 0.012);
      ctx.strokeStyle = hexA(glow, lit ? 0.9 : 0.16);
      ctx.stroke();
      ctx.restore();

      /* Arrow inside the panel — direction flips every round */
      if (!lit) ctx.fillStyle = hexA(C.mute, 0.5);
      drawArrow(px + pw / 2, py + ph / 2, Math.min(pw, ph) * (lit ? 0.26 : 0.22), lit ? glow : null, dir);

      /* Big readout, then the instruction / callout line — separate baselines */
      ctx.textAlign = 'center';
      ctx.font = '900 ' + Math.round(h * 0.11) + 'px Orbitron, system-ui, sans-serif';
      ctx.fillStyle = shownColor;
      ctx.shadowColor = hexA(shownColor, 0.8);
      ctx.shadowBlur  = 24;
      ctx.fillText(lastShown ? lastShown + ' ms' : 'WAIT', w / 2, readoutY);
      ctx.shadowBlur = 0;
      ctx.font = '600 ' + Math.round(h * 0.048) + 'px Rajdhani, system-ui, sans-serif';
      ctx.fillStyle = C.dim;
      ctx.fillText(now < sayUntil ? sayText : stateLabel(), w / 2, statusY);
    }

    /* A single miss is not the end of the run: only the last one is. Saying
       "5 MISSES AND YOU ARE OUT" on miss 1 told the player the run had ended
       four times before it did. */
    function missCopy() {
      if (misses >= MAX_MISSES) return 'TOO SLOW — THAT WAS THE FIFTH MISS';
      var left = MAX_MISSES - misses;
      return 'TOO SLOW — ' + left + (left === 1 ? ' MISS LEFT' : ' MISSES LEFT');
    }

    function bestSlot() {
      if (bestRun !== null) return 'BEST ' + bestRun + 'ms';
      if (bestEver !== null) return 'BEST ' + bestEver + 'ms';
      return state === STATE.IDLE ? 'TAP TO START' : 'BEST --';
    }

    function stateLabel() {
      if (state === STATE.IDLE) return 'TAP or press SPACE to begin';
      if (state === STATE.WAIT) return 'Hold… wait for the flash';
      if (state === STATE.GO)   return 'HIT IT';
      if (state === STATE.MISS) return 'Missed — too slow';
      return 'RUN OVER · avg ' + (avgRun || 0) + 'ms';
    }

    function drawArrow(cx, cy, size, color, up) {
      ctx.save();
      ctx.translate(cx, cy);
      if (!up) ctx.rotate(Math.PI); // 180° = point down
      if (color) { ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 24; }
      ctx.beginPath();
      ctx.moveTo(0, -size);
      ctx.lineTo(size * 0.86, size * 0.12); ctx.lineTo(size * 0.36, size * 0.12);
      ctx.lineTo(size * 0.36, size);       ctx.lineTo(-size * 0.36, size);
      ctx.lineTo(-size * 0.36, size * 0.12); ctx.lineTo(-size * 0.86, size * 0.12);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    /** #rrggbb (or #rgb) + alpha -> rgba() string. */
    function hexA(hex, a) {
      hex = (hex || '#ffffff').trim().replace('#', '');
      if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
      var n = parseInt(hex, 16);
      if (!isFinite(n)) return 'rgba(255,255,255,' + a + ')';
      return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
    }

    /* ---------------- Single rAF loop ---------------- */
    function frame(now) {
      if (destroyed) return;
      draw(now);
      rafId = requestAnimationFrame(frame);
    }

    /* ---------------- Input (pointer + keyboard) ---------------- */
    function onPointerDown(e) {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      onInput();
    }
    function onKeyDown(e) {
      if (e.code !== 'Space' && e.code !== 'Enter' && e.key !== ' ') return;
      // Never steal Space/Enter from a real control (the shell's buttons, the
      // fullscreen toggle, a future pause key) — the canvas may not be focused.
      var a = document.activeElement;
      if (a && a !== canvas && /^(BUTTON|INPUT|SELECT|TEXTAREA|A|SUMMARY)$/.test(a.tagName)) return;
      e.preventDefault();
      onInput();
    }
    function onResize() { if (!destroyed) resize(); }

    canvas.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onResize, { passive: true });
    window.addEventListener('orientationchange', onResize);

    // Publish our own record unconditionally: the sidebar would otherwise keep
    // showing whatever the shell's higher-is-better store happens to hold.
    setBest(bestEver === null ? 0 : bestEver);
    setScore(0);
    rafId = requestAnimationFrame(frame);

    /* ---------------- Teardown ---------------- */
    return {
      destroy: function () {
        if (destroyed) return;
        destroyed = true;
        cancelAnimationFrame(rafId);
        clearTimeout(timerId);
        canvas.removeEventListener('pointerdown', onPointerDown);
        document.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('resize', onResize);
        window.removeEventListener('orientationchange', onResize);
        var parent = wrap.parentNode;
        if (parent && typeof parent.removeChild === 'function') parent.removeChild(wrap); // drops canvas + <style> together
        else if (typeof wrap.remove === 'function') wrap.remove();
      }
    };
  }

  var TIME_COPY = ['SUPERHUMAN', 'SHARP', 'SLOW BUT CLEAN'];
  var JUMP_COPY = 'JUMPED THE GUN — NOT COUNTED';

  /* ------------------------------------------------------------------ *
   * Public module contract
   * ------------------------------------------------------------------ */
  window.PixelGame = {
    name: 'Neon Reaction',
    instructions:
      'A neon panel lights up at a random moment. Tap it or press SPACE the instant it ' +
      'flashes. Too early and the round restarts; too late and it counts as a miss. ' +
      'You get 20 rounds and 5 misses. Lower average milliseconds is better.',
    start: start
  };
})();
