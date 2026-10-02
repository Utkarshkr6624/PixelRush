/**
 * PIXEL RUSH — games/wordshift.js — "Word Shift"
 * Contract (SPEC.md): window.PixelGame = { name, instructions, start(root, api) } where
 * api = { setScore(n), setBest(n), gameOver(score) } and start() returns { destroy() }.
 * Self-contained: no imports, no dependencies, no assets — one <canvas> + 2D ctx, and
 * every rAF id and listener created in start() is torn down in destroy().
 */
(function () {
  'use strict';
  /* -------------------------------- Tuning -------------------------------- */
  var STORE_KEY = 'pixelrush.wordshift.best'; // localStorage: all-time best score
  var BASE_POINTS = 40;        // flat points for solving any word …
  var PER_LETTER = 10;         // … plus this per letter of length …
  var BONUS_PER_SEC = 12;      // … plus the leftover seconds, all times a level multiplier
  var LEVEL_MULT = 0.2;        // score multiplier grows +20% per level
  var HINT_CHARGES = 3, HINT_COST = 35;  // limited reveals, each one charges the score
  var SKIP_COST = 60;          // bail out of a word for a flat penalty, no bonus
  var WRONG_COST = 3;          // seconds burned when the full row is not the word
  var SOLVE_MS = 900;          // how long the solved banner holds before the next word
  var SHAKE_MS = 280;          // buzz length on a rejected row
  var FLASH_MS = 420;          // colour flash on reject / accept
  var MAX_LEN = 8;
  // WORD|hint, bucketed by length so the difficulty ramp can pick a pool.
  var WORDS = {
    3: 'CAT|feline pet|SUN|the star we orbit|OWL|night hunter|ICE|frozen water|SKY|the blue above|' +
       'KEY|opens a lock|MAP|shows the way|BED|where you sleep|CUP|holds coffee|JAM|toast spread|' +
       'FOG|low cloud|WEB|spiders work|DOT|small point|NUT|shelled snack|OAK|acorn tree|' +
       'ARC|a curved line|PIN|holds paper|HAT|head wear|NET|goals mesh|TOP|the highest part',
    4: 'NEON|glowing gas|STAR|twinkling night light|MOON|night orb|FIRE|warm flame|RAIN|falling drops|' +
       'SNOW|winter white|LEAF|green on a tree|BIRD|feathered flyer|FISH|water swimmer|ROAD|paved route|' +
       'DOOR|entry way|BOOK|readable volume|CODE|software source|GLOW|soft light|BEAM|light shaft|' +
       'VOID|empty space|DUST|shelf film|DARK|without light|IRON|metal from ore|GOLD|precious metal|' +
       'LIME|citrus green|CYAN|blue green ink|OPAL|gem with shimmer|ECHO|repeated sound|GRID|graph lines|' +
       'RUST|irons decay|SALT|seasoning grain|TIDE|shores rhythm|ZINC|galvanizing metal|BOLD|daring type|' +
       'PLUM|purple fruit|JADE|green stone',
    5: 'CRANE|tall lifting machine|GHOST|apparition|PRISM|spectrum splitter|SHIFT|the theme of this game|' +
       'LASER|focused beam|CHAOS|total disorder|PULSE|heartbeat rhythm|ORBIT|path around a planet|' +
       'GRAVEL|loose road stones|GARDEN|flower plot|MUSIC|organised sound|DREAM|sleeping vision|' +
       'TIGER|striped big cat|ZEBRA|striped runner|CLOUD|sky puff|FLAME|fire tongue|FROST|winter coating|' +
       'LIGHT|illumination|NIGHT|after dark|OCEAN|vast blue|RIVER|flowing water|STONE|small rock|' +
       'TOWER|tall structure|ANGEL|winged being|APPLE|orchard fruit|EARTH|third rock|QUEST|adventure|' +
       'SPEED|velocity|TRAIL|path behind|PIXEL|screen dot|SLIDE|playground chute|STACK|pile of items|' +
       'INPUT|what you type|BINGO|callers shout|OMEGA|last greek letter|DELTA|river mouth|SWIFT|very fast|' +
       'BRAVE|fearless',
    6: 'NEBULA|birthplace of stars|VECTOR|directional quantity|ROCKET|launches to space|ARCADE|coin game hall|' +
       'CIPHER|secret code|MATRIX|the grid|SPRITE|game graphic|GOTHIC|cathedral style|SOCKET|wall power point|' +
       'TUNNEL|underground passage|JUNGLE|dense forest|MIRROR|reflective glass|NOODLE|pasta strand|' +
       'PURPLE|violet shade|QUARTZ|rough crystal|WIZARD|robed caster|BREEZE|light wind|COPPER|reddish metal|' +
       'FOSSIL|ancient imprint|HANDLE|door grip|ISLAND|land in water|JELLY|translucent dessert|' +
       'LIZARD|basking reptile|MARBLE|shooter game stone|NIMBLE|quick and light|OXYGEN|breathable gas|' +
       'PENCIL|writing tool|RATTLE|noisy toy|SADDLE|riders seat|TIMBER|felled wood|TINSEL|holiday garland|' +
       'PICKLE|sour jar veg',
    7: 'ZENITH|highest point|GRAVITY|pulls things down|CRYSTAL|clear lattice|MYSTERY|unanswered puzzle|' +
       'LANTERN|light carrier|PHOENIX|reborn bird|DIAMOND|hard gem|FREEDOM|liberty|' +
       'HORIZON|where sky meets land|JASMINE|fragrant flower|QUANTUM|tiniest physics unit|RADIANT|glowing|' +
       'WHISPER|very quiet word|ECLIPSE|sun blocked by moon|FANTASY|made up world|GLIMMER|faint shine|' +
       'INSIGHT|deep understanding|THUNDER|storm rumble|CATHODE|negative terminal|CASCADE|falling water|' +
       'CIRCUIT|closed loop',
    8: 'TITANIUM|strong light metal|ABSTRACT|not representational|DAYLIGHT|days brightness|INFINITY|endless number|' +
       'NEWCOMER|recent arrival|PARALLEL|never meeting lines|PLATFORM|raised surface|QUADRANT|quarter of a circle|' +
       'SIDEWALK|roadside path|THRESHER|harvesting machine|UMBRELLA|rain shield|VELOCITY|speed measure|' +
       'WARDROBE|closet for clothes|MARGINAL|on the edge|NOTEBOOK|pages for writing|DAYBREAK|sunrise|' +
       'EVERMORE|forever|FRONTIER|edge of the map|LUMINOUS|giving off light'
  };
  // Everything the spec does not name, prefixed `ws-` so it cannot collide with the shell.
  var STYLES = '.ws{position:relative;width:100%;height:100%;overflow:hidden;touch-action:none;' +
    'user-select:none;-webkit-tap-highlight-color:transparent;' +
    'font-family:var(--font-body,"Rajdhani",system-ui,sans-serif);color:var(--ink,#f2f5ff)}' +
    '.ws canvas{display:block;width:100%;height:100%;outline:none}';
  var ORBIT = 'Orbitron, system-ui, sans-serif';
  var RAJ = 'Rajdhani, system-ui, sans-serif';
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function readBest() {
    try { var v = parseInt(window.localStorage.getItem(STORE_KEY), 10);
      return isFinite(v) && v > 0 ? v : null; } catch (e) { return null; } // private mode
  }
  function writeBest(v) {
    try { window.localStorage.setItem(STORE_KEY, String(v)); } catch (e) { /* ignore */ }
  }
  /** The "WORD|hint|..." strings -> { word, hint } buckets keyed by length. */
  function buildBank() {
    var out = {};
    Object.keys(WORDS).forEach(function (k) {
      var t = WORDS[k].split('|').filter(Boolean);
      for (var i = 0; i + 1 < t.length; i += 2) {   // tokens alternate word, hint
        var w = t[i];
        (out[w.length] = out[w.length] || []).push({ word: w, hint: t[i + 1] });
      }
    });
    return out;
  }
  var BANK = buildBank();

  /**
   * start(root, api) — build the game inside `root` and return { destroy }.
   * @param {HTMLElement} root
   * @param {{setScore:Function,setBest:Function,gameOver:Function}} api
   */
  function start(root, api) {
    api = api || {};
    var setScore   = typeof api.setScore === 'function'  ? api.setScore  : function () {};
    var setBest    = typeof api.setBest === 'function'   ? api.setBest   : function () {};
    var setStatus  = typeof api.setStatus === 'function' ? api.setStatus : function () {};
    var gameOverCb = typeof api.gameOver === 'function' ? api.gameOver : function () {};
    /* -------------------------------- DOM -------------------------------- */
    var wrap = document.createElement('div'); wrap.className = 'ws';
    var canvas = document.createElement('canvas');
    canvas.setAttribute('tabindex', '0'); canvas.setAttribute('role', 'application');
    canvas.setAttribute('aria-label', 'Word Shift anagram board. Tap letters to fill the slots; ' +
      'type letters and press Backspace on a keyboard.');
    var live = document.createElement('div'); // screen-reader announcements
    live.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0)';
    live.setAttribute('aria-live', 'polite');
    wrap.appendChild(canvas); wrap.appendChild(live);
    var styleTag = document.createElement('style');
    styleTag.textContent = STYLES; wrap.appendChild(styleTag); root.appendChild(wrap); // one <style>, scoped to .ws
    var ctx = canvas.getContext('2d');
    if (!ctx) { root.removeChild(wrap); return { destroy: function () {} }; }
    var rafId = 0, destroyed = false;
    var reduced = !!((window.PX && window.PX.reduced) ||
      (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches));
    /* ----------------------------- Run state ----------------------------- */
    var state = 'ready';        // 'ready' | 'play' | 'solved' | 'over'
    var paused = false, booted = false;
    var over = false;           // hard guard: api.gameOver() may fire exactly once per run
    var score = 0, bestEver = readBest(), isRecord = false;
    var level = 1, solved = 0, skipped = 0;
    var hints = HINT_CHARGES;
    var answer = '', hintText = '';
    var letters = [], used = [], slots = [];
    var timeLeft = 0, timeMax = 1;
    var solvedAt = 0, shakeAt = -1e9, flashAt = -1e9, flashCol = null, lastBonus = 0;
    var usedKeys = {};          // words already served this run, so the ramp never repeats
    /* ----------------- Sizing (crisp devicePixelRatio) ----------------- */
    var dpr = 1, cssW = 1, cssH = 1;
    var tile = 40, gap = 6, hudH = 40, btnH = 50;
    var slotRects = [], trayRects = [], btnHint = null, btnSkip = null, trayY = 0;
    var hintY = 0, labelY = 0, showLabel = true, compact = false;
    function resize() {
      var r = wrap.getBoundingClientRect();
      cssW = Math.max(1, Math.round(r.width)); cssH = Math.max(1, Math.round(r.height));
      dpr = clamp(window.devicePixelRatio || 1, 1, 2); // cap DPR: fill-rate win on 3x phones
      canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
      canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      layout();
    }
    /**
     * Where the word clock sits, shared by layout() and drawTimer() so the two can
     * never disagree. `bottom` is the lower edge of the "Ns" label — the hint line
     * is laid out below it, which is what used to put the clock on top of the clue.
     */
    function timerBox() {
      var fs = Math.round(clamp(Math.min(cssH * 0.04, cssW * 0.05), 11, 17));
      var barY = hudH * 0.42 + Math.round(clamp(Math.min(cssH * 0.045, cssW * 0.055), 12, 19)) * 0.9;
      var barH = Math.max(5, Math.round(cssH * 0.012));
      return { fs: fs, barY: barY, barH: barH, bottom: barY + barH + 9 + fs * 0.5 };
    }
    /**
     * Vertical stack, solved once per resize / new word — never overflows any aspect.
     * On a short canvas (a phone in portrait is only ~190 px tall) the chrome shrinks
     * to its compact band set and the two tile rows get all the slack, so the rack
     * stays a thumb-sized target instead of a 16 px sliver.
     */
    function layout() {
      compact = cssH < 340;
      var pad = compact ? 6 : 8, n = Math.max(1, answer.length), avail = cssW - pad * 2;
      hudH = Math.round(clamp(cssH * 0.10, compact ? 22 : 30, 54));
      btnH = Math.round(clamp(cssH * 0.11, compact ? 32 : 40, 62));
      var tb = timerBox();
      var hintFs = Math.round(clamp(Math.min(cssH * 0.042, cssW * 0.055), 11, 19));
      // Real clearance between the clock label and the clue, not a shared band.
      var gapBand = compact ? 6 : Math.max(8, Math.round(hintFs * 0.5));
      var hintH = hintFs + gapBand * 2;
      var labelFs = Math.round(clamp(Math.min(cssH * 0.032, cssW * 0.045), 9, 14));
      var clear = compact ? 8 : 10;              // the rack never touches the buttons
      var btnY = cssH - btnH - pad - 2;
      var rowsTop = Math.round(tb.bottom + hintH);
      // The "LETTER RACK" caption only earns its band while the tiles stay thumb-sized.
      var labelFull = labelFs + 14;
      showLabel = (btnY - clear - rowsTop - labelFull) / 2 >= 40;
      var labelH = showLabel ? labelFull : 0;
      var maxT = (btnY - clear - rowsTop - labelH) / 2;   // the two tile rows share the slack
      tile = Math.floor(clamp(Math.min(avail / n * 0.86, cssH * (compact ? 0.26 : 0.16), maxT),
        14, Math.min(78, Math.max(14, maxT))));
      // A full-bleed gap spread the rack to the screen edges and pushed it down onto
      // the buttons; cap it so the rack stays a compact cluster when space is tight.
      gap = n > 1 ? clamp((avail - n * tile) / (n - 1), tile * 0.08, compact ? tile * 0.35 : Infinity) : 0;
      var rowW = n * tile + (n - 1) * gap;
      var rx = Math.round((cssW - rowW) / 2);
      var sY = rowsTop, tY = rowsTop + tile + labelH;
      hintY = Math.round(tb.bottom + gapBand + hintFs / 2);
      labelY = Math.round(tY - labelH / 2);
      trayY = tY;
      slotRects = []; trayRects = [];
      for (var i = 0; i < n; i++) {
        var x = Math.round(rx + i * (tile + gap));
        slotRects.push({ x: x, y: sY, s: tile, i: i });
        trayRects.push({ x: x, y: tY, s: tile, i: i });
      }
      var bw = Math.floor((avail - 12) / 2);
      btnHint = { x: pad, y: btnY, w: bw, h: btnH };
      btnSkip = { x: pad + bw + 12, y: btnY, w: bw, h: btnH };
    }
    resize();
    function token(n, fb) { // pull a site custom property, with a hard fallback
      var v = getComputedStyle(document.documentElement).getPropertyValue(n);
      return (v && v.trim()) || fb;
    }
    var C = { bg: token('--bg', '#05060f'), ink: token('--ink', '#f2f5ff'), dim: token('--ink-dim', '#a7b0d0'),
      cyan: token('--cyan', '#22e7ff'), magenta: token('--magenta', '#ff2fb9'), acid: token('--acid', '#c8ff2e'),
      orange: token('--orange', '#ff8a3d'), violet: token('--violet', '#8b5cf6') };
    function hexA(hex, a) { // #rrggbb + alpha -> rgba()
      hex = (hex || '#fff').trim().replace('#', '');
      var n = parseInt(hex, 16);
      return isFinite(n) ? 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')'
        : 'rgba(255,255,255,' + a + ')';
    }
    /**
     * Sets ctx.font to the largest size <= `size` at which `text` still fits `maxW`,
     * and returns that size. The stage is now TALLER than it is wide on a phone, so a
     * height-only ratio balloons every label; this measures instead of guessing, which
     * is the only thing that works for cards whose text is score- and word-dependent.
     */
    function setFitFont(weight, family, text, size, maxW) {
      var s = Math.round(clamp(size, 10, 72));
      ctx.font = weight + ' ' + s + 'px ' + family;
      while (s > 10 && ctx.measureText(text).width > maxW) {
        s -= 1; ctx.font = weight + ' ' + s + 'px ' + family;
      }
      return s;
    }
    function rr(x, y, w, h, r) { // rounded-rect path, with a pre-roundRect fallback
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
    }
    /* ---------------------------- Game logic ---------------------------- */
    function shuffle(a) {
      for (var i = a.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1)), t = a[i];
        a[i] = a[j]; a[j] = t;
      }
      return a;
    }
    function pickWord(len) {
      var pool = BANK[len] || BANK[MAX_LEN];
      var fresh = pool.filter(function (p) { return !usedKeys[p.word]; });
      if (!fresh.length) { usedKeys = {}; fresh = pool; }   // pool exhausted: reshuffle the set
      var p = fresh[Math.floor(Math.random() * fresh.length)];
      usedKeys[p.word] = true;
      return p;
    }
    function newWord() {
      var len = Math.min(MAX_LEN, 3 + Math.floor(level / 2));   // 3,4,4,5,5,6,6,7,7,8…
      var p = pickWord(len);
      answer = p.word; hintText = p.hint;
      letters = shuffle(answer.split(''));
      // A scramble identical to the answer is a non-puzzle; reshuffle until it differs.
      var guard = 0;
      while (letters.join('') === answer && guard++ < 8) letters = shuffle(answer.split(''));
      used = letters.map(function () { return false; });
      slots = answer.split('').map(function () { return null; });
      timeMax = Math.max(9, (4.5 + len * 1.9) * Math.pow(0.945, level - 1));
      timeLeft = timeMax;
      state = 'play'; layout();
      live.textContent = hintText + '. ' + len + ' letters, ' + Math.round(timeMax) + ' seconds.';
    }
    /** One door for the pause flag, so the sidebar STATUS always matches the card. */
    function setPaused(v) {
      if (paused === v) return;
      paused = v;
      if (!over) setStatus(v ? 'Paused' : 'Playing');
    }
    function resetRun() {
      score = 0; level = 1; solved = 0; skipped = 0; hints = HINT_CHARGES;
      isRecord = false; over = false; paused = false; setStatus('Playing');
      shakeAt = -1e9; flashAt = -1e9; flashCol = null; usedKeys = {}; lastBonus = 0;
      setScore(0);
      if (bestEver !== null) setBest(bestEver);
      newWord();
      if (!booted) { booted = true; state = 'ready'; setStatus('Ready'); }  // first run waits for a tap
      live.textContent = 'New run. Score 0.';
    }
    /** Spend a point cost from the score, clamped at zero; refreshes the HUD. */
    function charge(n) { score = Math.max(0, score - n); setScore(score); }
    function buzz() { shakeAt = performance.now(); flashAt = performance.now(); flashCol = C.magenta; }
    /**
     * used[] is DERIVED from the slots, never hand-maintained. A slot remembers which
     * rack tile filled it, so a rack tile is spent exactly when a slot took it. Matching
     * a released letter back to a tile by character went wrong the moment a word had a
     * repeated letter (NOODLE): the bounce handed the tile back to a different O than the
     * one it came from, leaving a tile dimmed for good and the round unwinnable.
     */
    function syncUsed() {
      for (var j = 0; j < used.length; j++) used[j] = false;
      for (var i = 0; i < slots.length; i++) {
        var s = slots[i];
        if (s && typeof s.src === 'number' && s.src >= 0 && s.src < used.length) used[s.src] = true;
      }
    }
    function place(trayIdx, slotIdx) {
      if (state !== 'play' || paused || trayIdx < 0 || trayIdx >= letters.length) return;
      if (slotIdx < 0 || slotIdx >= slots.length || slots[slotIdx]) return;
      if (used[trayIdx]) return;
      used[trayIdx] = true;
      slots[slotIdx] = { ch: letters[trayIdx], locked: letters[trayIdx] === answer[slotIdx], src: trayIdx };
      if (slots.every(function (s) { return !!s; })) resolve();
    }
    function resolve() {
      var ok = slots.every(function (s, i) { return s.ch === answer[i]; });
      if (ok) {
        var mult = 1 + LEVEL_MULT * (level - 1);
        var bonus = Math.round((BASE_POINTS + answer.length * PER_LETTER + Math.ceil(timeLeft) * BONUS_PER_SEC) * mult);
        score += bonus; lastBonus = bonus;
        solved++; level = solved + 1;                 // the ramp tracks words cleared, not skips
        state = 'solved'; solvedAt = performance.now();
        flashAt = solvedAt; flashCol = C.acid;
        setScore(score);
        if (bestEver === null || score > bestEver) {
          bestEver = score; isRecord = true; writeBest(score); setBest(score);
        }
        live.textContent = answer + ' solved, plus ' + bonus + '. Score ' + score + '.';
      } else { // bounce every non-locked tile back to the rack and burn some clock
        for (var i = 0; i < slots.length; i++) {
          if (slots[i] && !slots[i].locked) slots[i] = null;
        }
        syncUsed();
        timeLeft = Math.max(0.1, timeLeft - WRONG_COST);
        buzz();
        live.textContent = 'Not the word. ' + WRONG_COST + ' seconds lost.';
      }
    }
    function returnSlot(i) {
      if (state !== 'play' || paused) return;
      var s = slots[i];
      if (!s || s.locked) return;    // locked letters are correct — they stay
      slots[i] = null;
      syncUsed();
    }
    function useHint() {
      if (state !== 'play' || paused || hints <= 0) return;
      for (var i = 0; i < slots.length; i++) {
        if (!slots[i]) {
          var j = -1, k;
          for (k = 0; k < letters.length; k++) if (!used[k] && letters[k] === answer[i]) { j = k; break; }
          if (j < 0) return;
          hints--; charge(HINT_COST);
          slots[i] = { ch: answer[i], locked: true, src: j };
          syncUsed();
          live.textContent = 'Hint: letter ' + (i + 1) + ' is ' + answer[i] + '. ' + hints + ' left.';
          if (slots.every(function (s) { return !!s; })) resolve();
          return;
        }
      }
    }
    function skipWord() {
      if (state !== 'play' || paused) return;
      skipped++; charge(SKIP_COST);
      newWord();
      live.textContent = 'Skipped. ' + hintText + '.';
    }
    function die() {
      if (over || destroyed) return;   // api.gameOver() may only fire once per run
      over = true; state = 'over'; setPaused(false); setStatus('Game over');
      live.textContent = 'Time out. Final score ' + score + '.';
      gameOverCb(score);
    }
    function act() { if (over) resetRun(); else if (state === 'ready') { state = 'play'; setPaused(false); setStatus('Playing'); } }
    /* ------------------------------ Drawing ------------------------------ */
    function drawLetter(x, y, s, ch, col, fillA, locked) {
      var pad = s * 0.07;
      ctx.save();
      ctx.shadowColor = hexA(col, locked ? 0.95 : 0.5);
      ctx.shadowBlur = locked && !reduced ? s * 0.42 : 0;
      rr(x + pad, y + pad, s - pad * 2, s - pad * 2, s * 0.24);
      ctx.fillStyle = hexA(col, fillA); ctx.fill();
      ctx.lineWidth = Math.max(1.5, s * 0.045);
      ctx.strokeStyle = hexA(col, 0.9); ctx.stroke();
      ctx.restore();
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '800 ' + Math.round(s * 0.5) + 'px Orbitron, system-ui, sans-serif';
      ctx.fillStyle = locked ? C.bg : col;
      ctx.fillText(ch, x + s / 2, y + s / 2 + s * 0.03);
    }
    function button(r, label, col, dim) {
      ctx.save();
      ctx.shadowColor = hexA(col, dim ? 0 : 0.6); ctx.shadowBlur = dim ? 0 : 18;
      rr(r.x, r.y, r.w, r.h, 10);
      ctx.fillStyle = hexA(col, dim ? 0.05 : 0.12); ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = hexA(col, dim ? 0.3 : 0.8); ctx.stroke();
      ctx.restore();
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      setFitFont('700', RAJ, label, Math.min(r.h * 0.36, r.w * 0.14), r.w - 8);
      ctx.fillStyle = dim ? C.dim : col;
      ctx.fillText(label, r.x + r.w / 2, r.y + r.h / 2);
    }
    /** Word clock: dim track, coloured fill (pulsing red when short) and the seconds label. */
    function drawTimer(now) {
      var tb = timerBox();
      var barY = tb.barY, barH = tb.barH, barW = cssW - 20;
      var frac = clamp(timeLeft / timeMax, 0, 1);
      var col = frac > 0.5 ? C.cyan : (frac > 0.22 ? C.orange : C.magenta);
      var beat = (frac <= 0.22 && !reduced) ? 0.7 + 0.3 * Math.abs(Math.sin(now / 130)) : 1;
      rr(10, barY, barW, barH, barH / 2); ctx.fillStyle = hexA(C.cyan, 0.12); ctx.fill();
      ctx.save(); ctx.globalAlpha = beat; ctx.shadowColor = col; ctx.shadowBlur = 14;
      rr(10, barY, Math.max(barH, barW * frac), barH, barH / 2); ctx.fillStyle = col; ctx.fill(); ctx.restore();
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '600 ' + tb.fs + 'px ' + RAJ;
      ctx.fillStyle = C.dim; ctx.fillText(Math.ceil(timeLeft) + 's', cssW / 2, tb.bottom);
    }
    /** CRT polish: scanlines + vignette, both dropped under reduced motion. */
    function crt() {
      if (!reduced) { ctx.fillStyle = 'rgba(0,0,0,.16)';
        if (ctx.__pxH !== cssH) { var __px = document.createElement('canvas'); __px.width = 1; __px.height = 3;
          var __pxg = __px.getContext('2d'); __pxg.fillStyle = 'rgba(0,0,0,.16)'; __pxg.fillRect(0, 0, 1, 1);
          ctx.__pxP = ctx.createPattern(__px, 'repeat'); ctx.__pxH = cssH; }
        ctx.fillStyle = ctx.__pxP; ctx.fillRect(0, 0, cssW, cssH); }
      var g = ctx.createRadialGradient(cssW / 2, cssH / 2, Math.min(cssW, cssH) * 0.35,
        cssW / 2, cssH / 2, Math.max(cssW, cssH) * 0.75);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.55)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, cssW, cssH);
    }
    /**
     * HUD, drawn AFTER crt() so the scanlines and vignette never dim it.
     * Every label keeps full-opacity ink (#f2f5ff / #a7b0d0) over a dark backing
     * shadow, so it clears 4.5:1 against the #05060f background on its own.
     */
    function drawHud(now) {
      var w = cssW, h = cssH, fs = Math.round(clamp(Math.min(h * 0.045, w * 0.055), 12, 19));
      var scoreT = 'SCORE ' + score, bestT = 'BEST ' + (bestEver || 0), lvlT = 'LEVEL ' + level;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,.85)'; ctx.shadowBlur = 6;
      ctx.textBaseline = 'middle';
      /* Score / level / best — each capped to its own third of the HUD width. */
      setFitFont('700', RAJ, scoreT, fs, w * 0.36);
      ctx.textAlign = 'left'; ctx.fillStyle = C.ink; ctx.fillText(scoreT, 10, hudH * 0.42);
      setFitFont('700', RAJ, bestT, fs, w * 0.36);
      ctx.textAlign = 'right'; ctx.fillStyle = C.dim; ctx.fillText(bestT, w - 10, hudH * 0.42);
      setFitFont('700', RAJ, lvlT, fs, w * 0.3);
      ctx.textAlign = 'center'; ctx.fillStyle = C.acid; ctx.fillText(lvlT, w / 2, hudH * 0.42);
      drawTimer(now);
      /* The hint line, in the band layout() reserved below the clock. */
      ctx.font = '600 ' + Math.round(clamp(Math.min(h * 0.042, w * 0.055), 11, 19)) + 'px ' + RAJ;
      ctx.fillStyle = C.magenta; ctx.shadowColor = hexA(C.magenta, 0.7); ctx.shadowBlur = 12;
      ctx.fillText(hintText, w / 2, hintY, w - 24);
      /* The rack label. */
      ctx.shadowColor = 'rgba(0,0,0,.85)'; ctx.shadowBlur = 6;
      if (showLabel) {
        ctx.font = '600 ' + Math.round(clamp(Math.min(h * 0.032, w * 0.045), 9, 14)) + 'px ' + RAJ;
        ctx.fillStyle = C.dim; ctx.fillText('LETTER RACK', w / 2, labelY);
      }
      /* Thumb-zone buttons. */
      ctx.restore();
      button(btnHint, 'HINT  ' + hints + '  (-' + HINT_COST + ')', C.acid, hints <= 0);
      button(btnSkip, 'SKIP  (-' + SKIP_COST + ')', C.orange, false);
    }
    function draw(now) {
      var w = cssW, h = cssH, i, r, s;
      ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);
      var wash = ctx.createLinearGradient(0, 0, 0, h);
      wash.addColorStop(0, hexA(C.violet, 0.14)); wash.addColorStop(0.55, 'rgba(0,0,0,0)');
      ctx.fillStyle = wash; ctx.fillRect(0, 0, w, h);
      var shake = (!reduced && now - shakeAt < SHAKE_MS) ?
        Math.sin(now / 22) * (SHAKE_MS - (now - shakeAt)) / SHAKE_MS * 5 : 0;
      /* ---------------- World: the board the player is actually reading ---------------- */
      ctx.save(); ctx.translate(shake, 0);
      /* The answer slots. */
      for (i = 0; i < slotRects.length; i++) {
        r = slotRects[i]; s = slots[i];
        if (s) drawLetter(r.x, r.y, r.s, s.ch, s.locked ? C.acid : C.magenta, s.locked ? 0.9 : 0.18, s.locked);
        else { ctx.save(); ctx.setLineDash([4, 4]);
          rr(r.x + r.s * 0.07, r.y + r.s * 0.07, r.s * 0.86, r.s * 0.86, r.s * 0.24);
          ctx.strokeStyle = hexA(C.cyan, 0.35); ctx.lineWidth = 1.5; ctx.stroke(); ctx.restore(); }
      }
      /* The scrambled rack, spent letters dimmed in place. */
      for (i = 0; i < trayRects.length; i++) {
        r = trayRects[i];
        if (used[i]) { ctx.save(); ctx.globalAlpha = 0.16;
          drawLetter(r.x, r.y, r.s, letters[i], C.cyan, 0.1, false); ctx.restore(); }
        else { var pop = (!reduced && state === 'play' && !paused) ? 1 + 0.03 * Math.sin(now / 300 + i) : 1;
          ctx.save(); ctx.translate(r.x + r.s / 2, r.y + r.s / 2); ctx.scale(pop, pop);
          ctx.translate(-r.s / 2, -r.s / 2);
          drawLetter(0, 0, r.s, letters[i], C.cyan, 0.12, false); ctx.restore(); }
      }
      ctx.restore();
      if (flashCol && now - flashAt < FLASH_MS) {  // accept / reject flash
        ctx.save(); ctx.globalAlpha = 0.3 * (1 - (now - flashAt) / FLASH_MS);
        ctx.fillStyle = flashCol; ctx.fillRect(0, 0, w, h); ctx.restore();
      }
      crt();  // CRT treatment belongs to the world only — the HUD lands on top of it
      drawHud(now);
      /* Overlays: solved banner, ready / paused, game over. */
      if (state === 'solved') {
        ctx.save(); ctx.globalAlpha = clamp(1 - (now - solvedAt) / SOLVE_MS, 0, 1);
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        var af = setFitFont('900', ORBIT, answer, Math.min(h * 0.11, w * 0.15), w - 16);
        ctx.fillStyle = C.acid; ctx.shadowColor = C.acid; ctx.shadowBlur = 26;
        ctx.fillText(answer, w / 2, h * 0.44); ctx.shadowBlur = 0;
        var bf = setFitFont('700', RAJ, '+' + lastBonus + '  ·  ' + Math.ceil(timeLeft) + 's LEFT',
          Math.min(h * 0.055, w * 0.07), w - 16);
        ctx.fillStyle = C.ink;
        ctx.fillText('+' + lastBonus + '  ·  ' + Math.ceil(timeLeft) + 's LEFT', w / 2, h * 0.44 + af * 0.75 + bf * 0.6);
        ctx.restore();
      }
      if ((paused || state === 'ready') && state !== 'over') {
        var rdy = state === 'ready';
        card(rdy ? 'READY' : 'PAUSED', rdy ? 'Unscramble the rack into the word' : 'The clock is stopped',
          C.cyan, 'TAP or press SPACE to ' + (rdy ? 'start' : 'resume'));
      }
      if (state === 'over') card('GAME OVER', 'SCORE ' + score + (isRecord ? '  ·  NEW BEST' : '') +
        (skipped ? '  ·  ' + skipped + ' SKIPPED' : ''), C.magenta, 'TAP or press SPACE to play again');
    }
    /** Centred overlay: big neon title, one dim line of sub-copy, optional hint. */
    function card(title, sub, color, hint) {
      ctx.fillStyle = hexA(C.bg, 0.74); ctx.fillRect(0, 0, cssW, cssH);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      var maxW = cssW - Math.max(10, cssW * 0.03) * 2;
      var tf = setFitFont('900', ORBIT, title, Math.min(cssH * 0.14, cssW * 0.13), maxW);
      var sf = setFitFont('600', RAJ, sub, Math.min(cssH * 0.05, cssW * 0.055), maxW);
      var hf = hint ? setFitFont('600', RAJ, hint, Math.min(cssH * 0.05, cssW * 0.055), maxW) : 0;
      // Stack on the measured sizes: fixed 0.42/0.5/0.61 bands collided once the phone
      // stage grew taller than it is wide and the fonts grew with it.
      var lead = tf * 0.55;
      var blockH = tf + lead + sf + (hint ? lead + hf : 0);
      var y = clamp(cssH * 0.42 - blockH / 2 + tf / 2, tf * 0.6, cssH - tf * 0.6);
      // Each font must be (re)applied immediately before its own fillText — measuring
      // the three up front left all three drawing with the last one set.
      ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 28;
      ctx.font = '900 ' + tf + 'px ' + ORBIT;
      ctx.fillText(title, cssW / 2, y);
      ctx.shadowBlur = 0;
      y += tf / 2 + lead + sf / 2;
      ctx.font = '600 ' + sf + 'px ' + RAJ;
      ctx.fillStyle = C.dim; ctx.fillText(sub, cssW / 2, y);
      if (hint) {
        ctx.font = '600 ' + hf + 'px ' + RAJ;
        ctx.fillText(hint, cssW / 2, y + sf / 2 + lead + hf / 2);
      }
    }
    /* -------------------------- Single rAF loop -------------------------- */
    function frame(now) {
      if (destroyed) return;   // guard: destroy() can land between frames
      if (state === 'play' && !paused) {
        timeLeft -= Math.min(0.2, (now - last) / 1000);
        if (timeLeft <= 0) { timeLeft = 0; die(); }
      } else if (state === 'solved' && now - solvedAt >= SOLVE_MS) {
        newWord();
      }
      last = now;
      draw(now);
      rafId = requestAnimationFrame(frame);
    }
    /* ------------------- Input: keyboard + pointer ------------------- */
    function firstFreeSlot() {
      for (var i = 0; i < slots.length; i++) if (!slots[i]) return i;
      return -1;
    }
    function firstTray(ch) {
      for (var j = 0; j < letters.length; j++) if (!used[j] && letters[j] === ch) return j;
      return -1;
    }
    function onKeyDown(e) {
      if (e.metaKey || e.ctrlKey || e.altKey || destroyed) return;
      var a = document.activeElement;
      if (a && a !== canvas && /^(BUTTON|INPUT|SELECT|TEXTAREA|A|SUMMARY)$/.test(a.tagName)) return;
      if (e.key === ' ' || e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault();
        if (over) { resetRun(); return; }               // restart a dead run
        if (state === 'ready') { act(); return; }       // first key starts the clock
        setPaused(!paused); return;
      }
      if (over) return;
      if (paused) return;
      if (e.key === 'Backspace' || e.code === 'Delete') {
        e.preventDefault();
        for (var i = slots.length - 1; i >= 0; i--) if (slots[i] && !slots[i].locked) { returnSlot(i); return; }
        return;
      }
      var ch = (e.key || '').toUpperCase();
      if (ch.length !== 1 || ch < 'A' || ch > 'Z') return;
      e.preventDefault();
      if (state === 'ready') act();
      var j = firstTray(ch), s = firstFreeSlot();
      if (j >= 0 && s >= 0) place(j, s); else buzz();
    }
    /**
     * The site shell binds F on `document` (bubble phase, registered first) for
     * fullscreen, so F tore the page out of the browser and the letter was swallowed.
     * A capture-phase listener on the same node runs before the shell's, and
     * stopPropagation keeps that listener from ever seeing the key — but it also
     * stops the game’s own bubble listener, so F is handled here directly.
     * R is left alone: the shell’s restart is not a letter this game needs.
     */
    function onKeyCapture(e) {
      if (e.metaKey || e.ctrlKey || e.altKey || destroyed) return;
      if (e.key !== 'f' && e.key !== 'F') return;
      e.preventDefault();
      e.stopPropagation();
      onKeyDown(e);
    }
    function hit(r, x, y) { return !!r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h; }
    function hitCell(list, x, y) {
      for (var i = 0; i < list.length; i++) {
        var r = list[i];
        if (x >= r.x && x <= r.x + r.s && y >= r.y && y <= r.y + r.s) return r;
      }
      return null;
    }
    function localPoint(e) {
      var b = canvas.getBoundingClientRect();
      return { x: e.clientX - b.left, y: e.clientY - b.top };
    }
    function onPointerDown(e) {
      if (destroyed || (e.button !== undefined && e.button !== 0)) return;
      if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
      var p = localPoint(e);
      if (state === 'over') { resetRun(); return; }   // a dead run restarts on any tap
      if (hit(btnHint, p.x, p.y)) { act(); useHint(); return; }
      if (hit(btnSkip, p.x, p.y)) { act(); skipWord(); return; }
      if (paused) { act(); setPaused(false); return; }  // otherwise any tap just unpauses
      if (state === 'ready') act();
      var tr = hitCell(trayRects, p.x, p.y);
      if (tr && !used[tr.i]) { var s = firstFreeSlot(); if (s >= 0) place(tr.i, s); else buzz(); return; }
      var sr = hitCell(slotRects, p.x, p.y);
      if (sr) returnSlot(sr.i);
    }
    function onResize() { if (!destroyed) resize(); }
    function onBlur() { if (!destroyed && !over && booted && state === 'play') setPaused(true); }
    function onVisibility() { if (document.hidden) onBlur(); }
    // Every listener the game owns, in one table so teardown cannot miss one.
    var BIND = [[document, 'keydown', onKeyDown], [document, 'keydown', onKeyCapture, true],
      [canvas, 'pointerdown', onPointerDown],
      [window, 'resize', onResize, { passive: true }], [window, 'orientationchange', onResize],
      [window, 'blur', onBlur], [document, 'visibilitychange', onVisibility]];
    BIND.forEach(function (b) { b[0].addEventListener(b[1], b[2], b[3]); });
    var last = performance.now();
    resetRun(); rafId = requestAnimationFrame(frame);
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
    name: 'Word Shift',
    instructions:
      'The rack is a scrambled word and the hint above it is the only clue. TAP rack letters to ' +
      'slide them into the slots, or TYPE the letters and press BACKSPACE to pull one back out — a ' +
      'letter that is in the right slot locks green and stays. Fill every slot and the leftover ' +
      'seconds convert to bonus points; a row that is not the word bounces back and costs 3 seconds. ' +
      'Each solved word raises the level: longer words, tighter clock, bigger multiplier. HINT reveals ' +
      'one correct letter three times per run, SKIP moves on for a flat penalty. The clock running ' +
      'out ends the run. Best score is saved on this device.',
    start: start
  };
})();
