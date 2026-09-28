/* ==========================================================================
   PIXELRUSH — js/player.js
   play.html behaviour: resolve ?game=slug against window.GAMES, lazily inject
   games/<file>.js only when the slug is actually playable, mount it into
   #game-root via window.PixelGame.start(root, api), and wire the whole shell:
   title / crumb / blurb / meta tags, HUD (score, best, status, restart,
   fullscreen, how-to-play), localStorage highscores and the #game-picker
   strip of 3 other games.

   Contract (SPEC.md):
     window.GAMES[]                    -> catalog (js/games-data.js)
     window.PixelGame.start(root, api) -> { destroy() }  (games/<file>.js)
     api = { setScore(n), setBest(n), gameOver(score) }
     highscore key: 'pixelrush.best.<slug>'

   Shell DOM it targets (play.html):
     #game-title #player-crumb-title #game-blurb #game-meta
     #game-stage #game-root #game-boot #player-grid
     #game-missing #game-missing-title #game-missing-text
     #game-hud #game-score #game-best #game-status
     #game-restart #game-fullscreen #game-how #player-how-toggle
     #game-picker #game-picker-rail

   No frameworks, no build step, no backend. Defensive by design: a missing
   catalog, a missing HUD node, a missing game file, a game module that never
   registers window.PixelGame, a browser without the Fullscreen API and
   localStorage being blocked are all handled without breaking the shell.
   ========================================================================== */
(function () {
  'use strict';

  /* Must match the key each game module reads/writes itself: pixelrush.<slug>.best */
  var BEST_KEY = 'pixelrush.';
  var PICKER_COUNT = 3;

  /* ---------------------------------------------------------------- utils */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  function catalog() {
    return Array.isArray(window.GAMES) ? window.GAMES : [];
  }
  function findGame(slug) {
    if (!slug) return null;
    var list = catalog();
    for (var i = 0; i < list.length; i++) {
      if (list[i] && String(list[i].slug).toLowerCase() === slug) return list[i];
    }
    return null;
  }
  function colorVar(color) {
    var allowed = { cyan: 1, magenta: 1, acid: 1, orange: 1, violet: 1 };
    return allowed[color] ? 'var(--' + color + ')' : 'var(--cyan)';
  }
  function motionOn() {
    return !(window.PX && window.PX.motionOn === false);
  }
  function slugFromLocation() {
    var m = /[?&]game=([^&#]*)/.exec(window.location.search);
    if (!m) return '';
    try { return decodeURIComponent(m[1]).trim().toLowerCase(); } catch (e) {
      return String(m[1]).trim().toLowerCase();
    }
  }
  function safeStorage() {
    try {
      var k = '__px_probe__';
      window.localStorage.setItem(k, '1');
      window.localStorage.removeItem(k);
      return window.localStorage;
    } catch (e) { return null; }
  }
  var store = safeStorage();
  function readBest(slug) {
    if (!store || !slug) return 0;
    var v = parseInt(store.getItem(BEST_KEY + slug + '.best'), 10);
    return (isNaN(v) || v < 0) ? 0 : v;
  }
  function writeBest(slug, n) {
    if (!store || !slug) return;
    try { store.setItem(BEST_KEY + slug + '.best', String(n)); } catch (e) { /* quota / private mode */ }
  }

  /* --------------------------------------------------------- injected CSS
     Only the classes the shell does not already own: the round-over overlay
     and the .player-pick cards emitted into #game-picker-rail. Everything
     else in play.html is styled by the shell's own stylesheet, so this
     block stays deliberately tiny. Idempotent (guarded by STYLE_ID).     */
  var STYLE_ID = 'player-runtime-styles';
  var CSS = [
    '#game-root{position:absolute;inset:0;display:grid;place-items:center;padding:2%}',
    '#game-root>*{max-width:100%;max-height:100%}',
    '#game-stage .player-pick__art svg{width:40px;height:40px;display:block}',
    '#game-picker-rail .player-pick__art{width:100%}',
    '.p-over{position:absolute;inset:0;z-index:10;display:none;place-items:center;',
    'background:radial-gradient(80% 80% at 50% 42%,rgba(5,6,15,.80),rgba(5,6,15,.95));',
    /* the scrim must never eat canvas input: a game that restarts itself cannot
       tell the shell it did, so a stale overlay used to sit on top of a live
       run and silently swallow every key, click and swipe */
    'pointer-events:none}',
    '.p-over.is-on{display:grid}',
    '.p-over__box{text-align:center;pointer-events:auto;',
    'padding:clamp(20px,3vw,30px) clamp(24px,4vw,40px);',
    'border:1px solid var(--line);border-radius:var(--r-md);background:var(--glass);',
    'backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);',
    'box-shadow:0 30px 80px -50px #000;max-width:min(88%,420px)}',
    '.p-over__label{display:block;font:700 10.5px/1 var(--font-body);letter-spacing:.3em;',
    'text-transform:uppercase;color:var(--ink-mute);margin-bottom:12px}',
    '.p-over__score{display:block;font:900 clamp(2.4rem,7vw,3.4rem)/1 var(--font-display);',
    'color:var(--cyan);text-shadow:0 0 26px rgba(34,231,255,.55);font-variant-numeric:tabular-nums}',
    '.p-over__best{display:block;font:600 12px/1 var(--font-body);letter-spacing:.22em;',
    'text-transform:uppercase;color:var(--ink-dim);margin:10px 0 18px}',
    '.p-over__actions{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}'
  ].join('');
  function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.appendChild(document.createTextNode(CSS));
    (document.head || document.documentElement).appendChild(s);
  }

  /* ------------------------------------------------------------- dom refs */
  var dom = {};
  function resolveDom() {
    dom.shell = $('#player-shell') || $('#main-content') || document.body;
    dom.title = $('#game-title');
    dom.crumb = $('#player-crumb-title');
    dom.blurb = $('#game-blurb');
    dom.meta = $('#game-meta');
    dom.stage = $('#game-stage');
    dom.hud = $('#game-hud');
    dom.picker = $('#game-picker');
    dom.rail = $('#game-picker-rail') || dom.picker;
    dom.missing = $('#game-missing');
    dom.missingTitle = $('#game-missing-title');
    dom.missingText = $('#game-missing-text');
    dom.howTo = $('#game-how');
    dom.howBox = $('#game-hud-how');
    dom.howToggle = $('#player-how-toggle');
    dom.status = $('#game-status');
    dom.boot = $('#game-boot');
    dom.back = $('.player-back');
  }

  /* ------------------------------------------------------------- lifecycle */
  var current = { meta: null, instance: null, over: null, score: null, best: null };
  var bootListeners = [];   /* shell level — live for the whole page */
  var gameListeners = [];   /* per game  — cleared on every teardown   */

  function bind(list, target, type, fn, opts) {
    if (!target) return;
    target.addEventListener(type, fn, opts);
    list.push([target, type, fn, opts]);
  }

  /* Where the game module mounts. play.html provides #game-root inside
     #game-stage; if it is missing we create it rather than letting the
     module draw over the CRT overlay. */
  function root() {
    if (!dom.stage) return document.body;
    var r = $('#game-root', dom.stage);
    if (!r) {
      r = el('div', '');
      r.id = 'game-root';
      dom.stage.appendChild(r);
    }
    return r;
  }
  function resolveHudNodes() {
    current.score = (dom.hud && $('#game-score', dom.hud)) || $('#game-score') || null;
    current.best = (dom.hud && $('#game-best', dom.hud)) || $('#game-best') || null;
    if (current.score) current.score.setAttribute('aria-live', 'off');
    if (current.best) current.best.setAttribute('aria-live', 'off');
  }
  function hudButtons() {
    return {
      restart: (dom.hud && $('#game-restart', dom.hud)) || $('#game-restart'),
      fullscreen: (dom.hud && $('#game-fullscreen', dom.hud)) || $('#game-fullscreen')
    };
  }

  function setStatus(text) {
    if (dom.status) dom.status.textContent = text;
  }

  /* Almost every game guards its keydown with "bail if activeElement is a
     BUTTON", which is correct — you do not want SPACE re-triggering a focused
     control. The bug was that clicking a HUD button left focus parked there
     for the rest of the session, so the player's keyboard went dead after
     touching Restart or Fullscreen. Hand focus back to the document after a
     *pointer* press only: keyboard activation still keeps focus, so Tab
     navigation and Enter/Space on real controls are untouched. */
  function wireFocusRelease() {
    /* Runs on click, not pointerdown: the browser focuses a button on mousedown
       and re-asserts that focus after the pointer sequence, so blurring during
       pointerdown is undone a moment later. click fires once focus has settled. */
    bind(bootListeners, document, 'click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      if (!t.closest('button, a[href], input, select, textarea, [contenteditable]')) return;
      var el = document.activeElement;
      if (el && typeof el.blur === 'function' && el !== document.body) el.blur();
    }, true);
  }

  function setBusy(busy) {
    if (dom.hud) dom.hud.classList.toggle('is-busy', !!busy);
  }
  function ready(on) {
    if (dom.stage) dom.stage.classList.toggle('is-ready', !!on);
  }

  /* Restart / game switch / page exit all funnel through here:
     destroy() first (so the module can kill rAF + listeners), then DOM,
     then the per-game listeners. */
  function teardown() {
    if (current.instance && typeof current.instance.destroy === 'function') {
      try { current.instance.destroy(); } catch (e) { /* never block the shell */ }
    }
    current.instance = null;
    current.meta = null;
    if (current.over && current.over.parentNode) {
      current.over.parentNode.removeChild(current.over);
    }
    current.over = null;
    gameListeners.forEach(function (l) {
      l[0].removeEventListener(l[1], l[2], l[3] && l[3].capture);
    });
    gameListeners.length = 0;
    removeStructuredData();
    var r = $('#game-root', dom.stage);
    if (r) r.innerHTML = '';
  }

  /* ------------------------------------------------------------------ HUD */
  function setScore(n) {
    var v = Number(n) || 0;
    current.scoreValue = v;                       /* numeric score, for the restart heuristic */
    if (current.score) current.score.textContent = String(v);   /* current.score is the DOM node */
    if (current.meta && v > readBest(current.meta.slug)) {
      writeBest(current.meta.slug, v);
      setBest(v);
    }
    /* A run restarting itself is invisible to the shell — no game calls back
       when it resets. But every game drops its score back to near zero the
       moment a new run starts, so a score that goes DOWN while the round-over
       scrim is up is a reliable signal. Retire the scrim so the fresh run is
       visible and clickable. */
    if (current.over && current.over.classList.contains('is-on') && v < current.overScoreValue) {
      current.over.classList.remove('is-on');
      setStatus('Playing');
    }
    if (current.over) {
      var s = $('.p-over__score', current.over);
      if (s && current.over.classList.contains('is-on')) s.textContent = String(v);
    }
  }
  function setBest(n) {
    var v = Number(n) || 0;
    if (current.best) current.best.textContent = String(v);
  }

  function showGameOver(score) {
    var stage = dom.stage;
    if (!stage) return;
    var v = Number(score) || 0;
    if (!current.over || !current.over.parentNode) {
      current.over = el('div', 'p-over');
      current.over.setAttribute('role', 'dialog');
      current.over.setAttribute('aria-label', 'Round over');
      var box = el('div', 'p-over__box');
      box.appendChild(el('span', 'p-over__label', 'Round over'));
      current.overScore = el('span', 'p-over__score', String(v));
      box.appendChild(current.overScore);
      current.overBest = el('span', 'p-over__best', '');
      box.appendChild(current.overBest);
      var actions = el('div', 'p-over__actions');
      var again = el('button', 'btn btn--primary', 'Play again');
      again.type = 'button';
      actions.appendChild(again);
      var back = el('a', 'btn btn--ghost', 'All games');
      back.href = 'games.html';
      actions.appendChild(back);
      box.appendChild(actions);
      current.over.appendChild(box);
      stage.appendChild(current.over);
      bind(gameListeners, again, 'click', function () { restart(); });
      /* Tapping anywhere on the card restarts, not just the button. The box is
         centred over the stage, so it swallowed the one tap a player naturally
         makes — right in the middle of the screen — and the game read as
         completely unresponsive. */
      bind(gameListeners, current.over, 'click', function (e) {
        if (e.target.closest && e.target.closest('a, button')) return;  /* let the real controls act */
        e.stopPropagation();
        restart();
      });
      current.over.setAttribute('aria-label', 'Round over — tap anywhere to play again');
    }
    if (current.overScore) current.overScore.textContent = String(v);
    current.overScoreValue = v;
    if (current.overBest) {
      current.overBest.textContent = 'Best ' + (current.meta ? readBest(current.meta.slug) : 0);
    }
    current.over.classList.add('is-on');
    setStatus('Game over');
  }

  var api = {
    setScore: setScore,
    setBest: setBest,
    gameOver: function (score) {
      var v = Number(score) || 0;
      if (current.meta && v > readBest(current.meta.slug)) {
        writeBest(current.meta.slug, v);
        setBest(v);
      }
      showGameOver(v);
    },
    /* Games may report their own state. Without this the HUD said "Playing"
       through every pause and every game over, in all 24 cabinets. */
    setStatus: setStatus
  };

  /* -------------------------------------------------------------- messages */
  function clearMissing() {
    if (!dom.missing) return;
    dom.missing.hidden = true;
    dom.missing.classList.remove('is-on');
  }
  function showMissing(code, title, message) {
    if (dom.missingTitle) dom.missingTitle.textContent = title;
    if (dom.missingText) dom.missingText.textContent = message;
    if (dom.missing) {
      dom.missing.hidden = false;
      dom.missing.classList.add('is-on');
      dom.missing.setAttribute('data-code', code || '404');
    }
    if (dom.title) dom.title.textContent = title;
    if (dom.crumb) dom.crumb.textContent = 'Not found';
    if (dom.meta) dom.meta.hidden = true;
    if (dom.blurb) {
      dom.blurb.textContent = 'This cabinet is not on the floor right now — the full library is one click away.';
    }
    ready(true);
    setStatus('Unavailable');
    if (current.score) current.score.textContent = '0';
    if (current.best) current.best.textContent = '0';
  }

  function setHead(meta) {
    if (dom.title) dom.title.textContent = meta ? meta.title : 'Game not found';
    if (dom.crumb) dom.crumb.textContent = meta ? meta.title : 'Not found';
    if (dom.blurb) {
      dom.blurb.textContent = meta
        ? (meta.blurb || 'Free instant-play browser game. No install, no account, no download.')
        : 'That game is not in the PixelRush library right now.';
    }
    if (dom.meta) {
      dom.meta.innerHTML = '';
      if (meta) {
        dom.meta.hidden = false;
        [meta.genre, meta.difficulty, meta.players, meta.duration].forEach(function (v) {
          if (v) dom.meta.appendChild(el('li', '', v));
        });
      } else {
        dom.meta.hidden = true;
      }
    }
    document.title = meta
      ? meta.title + ' — Play Free | PixelRush'
      : 'Game not found | PixelRush';
    var desc = $('meta[name="description"]');
    if (desc && meta) {
      desc.setAttribute('content', 'Play ' + meta.title + ' free in your browser on PixelRush. ' +
        (meta.blurb || 'No download, no signup — press START and play instantly.'));
    }
    var canonical = $('link[rel="canonical"]');
    if (canonical) {
      canonical.href = 'https://pixelrush.example/play.html' +
        (meta ? '?game=' + encodeURIComponent(meta.slug) : '');
    }
    /* Open Graph and Twitter have to follow the game too, or every shared link
       says "Play — PixelRush" and points at the bare shell. */
    function setMeta(sel, value) {
      var el = $(sel);
      if (el) el.setAttribute('content', value);
    }
    if (meta) {
      var shareTitle = meta.title + ' — Play Free | PixelRush';
      var shareDesc = 'Play ' + meta.title + ' free in your browser on PixelRush. ' +
        (meta.blurb || 'No download, no signup — press START and play instantly.');
      var shareUrl = 'https://pixelrush.example/play.html?game=' + encodeURIComponent(meta.slug);
      setMeta('meta[property="og:title"]', shareTitle);
      setMeta('meta[property="og:description"]', shareDesc);
      setMeta('meta[property="og:url"]', shareUrl);
      setMeta('meta[name="twitter:title"]', shareTitle);
      setMeta('meta[name="twitter:description"]', shareDesc);
    }
    if (dom.stage) {
      dom.stage.setAttribute('aria-label', meta ? meta.title + ' game screen' : 'Game screen');
    }
  }

  /* ------------------------------------------------------- structured data
     play.html is noindex, and the identity of the page is not known until
     ?game= has been resolved, so static schema in play.html would be wasted.
     Instead the player injects ONE <script type="application/ld+json"> block
     describing the cabinet that actually booted, and removes it again in
     teardown(). It joins the site-wide @id graph: the Organization is
     referenced by @id only, never duplicated here (qa/SEO-GUIDE.md).

     Every value comes from window.GAMES or from the canonical identity in
     qa/SEO-GUIDE.md. Nothing is invented. Note the catalog carries `rating`
     but no review count, and Google requires a ratingCount/reviewCount next
     to a rating value — so aggregateRating is emitted only if an entry ever
     gains a `reviews` number. Never fabricate that count.                  */
  var LD_ID = 'player-game-ldjson';
  var LD_ORG = 'https://pixelrush.example/#organization';
  var LD_PLAY = 'https://pixelrush.example/play.html';

  function gameUrl(slug) {
    return LD_PLAY + '?game=' + encodeURIComponent(slug);
  }
  function removeStructuredData() {
    var node = document.getElementById(LD_ID);
    if (node && node.parentNode) node.parentNode.removeChild(node);
  }

  function structuredDataFor(meta) {
    var game = {
      '@type': 'VideoGame',
      '@id': gameUrl(meta.slug) + '#game',
      url: gameUrl(meta.slug),
      name: meta.title,
      inLanguage: 'en',
      isAccessibleForFree: true,
      publisher: { '@id': LD_ORG }
    };
    if (meta.blurb) game.description = meta.blurb;
    if (meta.genre) game.gameGenre = meta.genre;
    if (meta.tags && meta.tags.length) game.keywords = meta.tags.join(', ');
    var feats = [];
    if (meta.difficulty) feats.push('Difficulty: ' + meta.difficulty);
    if (meta.players) feats.push(meta.players);
    if (meta.duration) feats.push(meta.duration);
    if (feats.length) game.features = feats;
    if (typeof meta.rating === 'number' && typeof meta.reviews === 'number') {
      game.aggregateRating = {
        '@type': 'AggregateRating',
        ratingValue: meta.rating,
        ratingCount: meta.reviews,
        bestRating: 5,
        worstRating: 1
      };
    }
    return { '@context': 'https://schema.org', '@graph': [game] };
  }

  function applyStructuredData(meta) {
    /* must never throw — schema is an optimisation, not a feature gate */
    try {
      removeStructuredData();
      if (!meta || !meta.slug) return;
      var s = document.createElement('script');
      s.type = 'application/ld+json';
      s.id = LD_ID;
      /* `</` is escaped so catalog text can never close the block early */
      s.textContent = JSON.stringify(structuredDataFor(meta)).replace(/<\//g, '<\\/');
      (document.head || document.documentElement).appendChild(s);
    } catch (e) { /* no head, no JSON.stringify, whatever — the shell carries on */ }
  }

  function renderHowTo() {
    if (!dom.howTo) return;
    var mod = window.PixelGame;
    var text = mod && typeof mod.instructions === 'string' ? mod.instructions : '';
    if (!text) { dom.howTo.textContent = 'How to play: this game has not published its controls yet.'; return; }
    dom.howTo.textContent = text;
  }

  /* -------------------------------------------------------------- loading */
  var pending = {};   /* in-flight injections only. A *resolved* module is
                         re-injected on every launch so a restart gets a
                         fresh window.PixelGame; the HTTP cache makes that
                         free on a real site. */
  function loadScript(src) {
    if (pending[src]) return pending[src];
    var p = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.async = false;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('Failed to load ' + src)); };
      document.head.appendChild(s);
    });
    pending[src] = p;
    var clear = function () { delete pending[src]; };
    p.then(clear, clear);
    return p;
  }

  /* ------------------------------------------------------------ fullscreen */
  function fsElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }
  function fsSupported(node) {
    return !!(node.requestFullscreen || node.webkitRequestFullscreen ||
      node.webkitEnterFullscreen || node.msRequestFullscreen);
  }
  function fsRequest(node) {
    var fn = node.requestFullscreen || node.webkitRequestFullscreen ||
      node.webkitEnterFullscreen || node.msRequestFullscreen;
    if (!fn) return false;
    try { fn.call(node); } catch (e) { return false; }
    return true;
  }
  function fsExit() {
    var fn = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
    if (fn) { try { fn.call(document); } catch (e) { /* ignore */ } }
  }
  function setFsState(on) {
    var btn = hudButtons().fullscreen;
    if (!btn) return;
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.setAttribute('aria-label', on ? 'Exit fullscreen' : 'Enter fullscreen');
  }
  function wireFullscreen() {
    var btn = hudButtons().fullscreen;
    var target = dom.stage;
    if (!btn) return;    bind(bootListeners, document, 'fullscreenchange', function () {
      setFsState(!!fsElement());
      if (!fsElement() && target) target.classList.remove('is-expanded');
    });
    bind(bootListeners, document, 'webkitfullscreenchange', function () {
      setFsState(!!fsElement());
    });
    if (!fsSupported(target)) {
      /* Graceful fallback: no Fullscreen API (old iOS, locked-down webviews).
         Degrade to a CSS "expanded" stage instead of a dead button. */
      btn.setAttribute('aria-disabled', 'true');
      btn.setAttribute('aria-label', 'Fullscreen is not supported by this browser');
      if (btn.tagName === 'BUTTON') btn.disabled = true;
      bind(bootListeners, btn, 'click', function (e) {
        e.preventDefault();
        if (target) target.classList.toggle('is-expanded');
      });
      return;
    }
    bind(bootListeners, btn, 'click', function (e) {
      e.preventDefault();
      if (fsElement()) { fsExit(); return; }
      if (!fsRequest(target) && target) {      /* request refused -> emulate */
        target.classList.add('is-expanded');
        setFsState(true);
      }
    });
    setFsState(false);
  }

  /* ---------------------------------------------------------------- picker */
  function pickGames(currentSlug) {
    var others = catalog().filter(function (g) {
      return g && g.slug && String(g.slug) !== String(currentSlug);
    });
    var live = others.filter(function (g) { return g.status === 'live'; });
    var pool = live.length >= PICKER_COUNT ? live : others;
    var me = findGame(currentSlug);
    return pool.slice().sort(function (a, b) {
      var aSame = (me && a.genre === me.genre) ? 1 : 0;
      var bSame = (me && b.genre === me.genre) ? 1 : 0;
      if (aSame !== bSame) return bSame - aSame;   /* same genre first */
      return (b.plays || 0) - (a.plays || 0);      /* then most played  */
    }).slice(0, PICKER_COUNT);
  }

  function pickCard(game) {
    var card = el('a', 'player-pick');
    card.href = 'play.html?game=' + encodeURIComponent(game.slug);
    card.setAttribute('data-goto', game.slug);
    card.setAttribute('data-genre', game.genre || '');
    card.setAttribute('data-status', game.status || 'live');
    card.setAttribute('aria-label', 'Play ' + game.title);
    card.style.setProperty('--g', colorVar(game.color));

    var art = el('div', 'player-pick__art');
    if (game.glyph) art.innerHTML = game.glyph;   /* catalog data, inline SVG */
    card.appendChild(art);
    card.appendChild(el('p', 'player-pick__t', game.title));
    card.appendChild(el('p', 'player-pick__m',
      [game.genre, game.duration].filter(Boolean).join(' · ')));
    return card;
  }

  function renderPicker(currentSlug) {
    if (!dom.picker) return;
    var picks = pickGames(currentSlug);
    var host = dom.rail && dom.rail !== dom.picker ? dom.rail : dom.picker;
    if (!picks.length) { dom.picker.hidden = true; return; }
    /* Only build when the set actually changed — avoids clobbering the
       shell's own header markup that lives inside #game-picker. */
    var wanted = picks.map(function (g) { return g.slug; }).join(',');
    if (dom.picker.getAttribute('data-pick') !== wanted) {
      dom.picker.setAttribute('data-pick', wanted);
      if (dom.rail && dom.rail !== dom.picker) dom.rail.innerHTML = '';
      picks.forEach(function (g) { host.appendChild(pickCard(g)); });
    }
    dom.picker.hidden = false;
  }

  function wirePicker() {
    var host = dom.rail || dom.picker;
    if (!host) return;
    bind(bootListeners, host, 'click', function (e) {
      var link = e.target && e.target.closest ? e.target.closest('[data-goto]') : null;
      if (!link) return;
      var slug = link.getAttribute('data-goto');
      if (!slug) return;
      e.preventDefault();
      startGame(slug, true);
      if (dom.shell && typeof dom.shell.scrollIntoView === 'function') {
        dom.shell.scrollIntoView({ behavior: motionOn() ? 'smooth' : 'auto', block: 'start' });
      }
    });
  }

  /* ----------------------------------------------------------- how-to-play */
  function wireHowTo() {
    if (!dom.howToggle || !dom.howBox) return;
    bind(bootListeners, dom.howToggle, 'click', function () {
      var open = dom.howToggle.getAttribute('aria-expanded') !== 'true';
      dom.howBox.toggleAttribute('hidden', !open);
      dom.howToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  /* ------------------------------------------------------------- shortcuts */
  function wireKeys() {
    bind(bootListeners, document, 'keydown', function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.key === 'r' || e.key === 'R') {
        if (current.meta) { e.preventDefault(); restart(); }
      } else if (e.key === 'f' || e.key === 'F') {
        var btn = hudButtons().fullscreen;
        if (btn && !btn.disabled) { e.preventDefault(); btn.click(); }
      }
    });
  }

  function wireBack() {
    if (!dom.back) return;
    bind(bootListeners, dom.back, 'click', function () { teardown(); });
  }

  function wireUnload() {
    bind(bootListeners, window, 'pagehide', teardown);
    bind(bootListeners, window, 'beforeunload', teardown);
    bind(bootListeners, window, 'popstate', function () {
      var slug = slugFromLocation();
      if (slug !== (current.meta && current.meta.slug)) startGame(slug, false);
    });
  }

  /* ------------------------------------------------------------------ core */
  function restart() {
    if (current.meta) startGame(current.meta.slug, false);
  }

  function startGame(slug, pushUrl) {
    teardown();
    clearMissing();
    if (pushUrl) {
      try { history.pushState({ game: slug }, '', 'play.html?game=' + encodeURIComponent(slug)); }
      catch (e) { /* file:// or sandboxed — plain navigation still works */ }
    }
    var meta = findGame(slug);
    renderPicker(slug);
    resolveHudNodes();
    setStatus('Idle');
    setBusy(false);
    ready(false);

    if (!meta) {
      setHead(null);
      showMissing('404', 'Game not found',
        'We could not find "' + (slug || 'unknown') + '" in the PixelRush library. ' +
        'It may have been renamed, or the link may be from an older build.');
      return;
    }
    setHead(meta);
    if (meta.status !== 'live') {
      showMissing('SOON', meta.title + ' is coming soon',
        'This cabinet is still being wired up. Meanwhile, pick another game from the library below.');
      return;
    }
    if (meta.engine !== 'js' || !meta.file) {
      showMissing('PY', meta.title + ' runs on Python',
        'This title is a Python build and is not playable in the browser yet. Coming soon — ' +
        'meanwhile the other cabinets are all live.');
      return;
    }

    current.meta = meta;
    setBest(readBest(meta.slug));
    setScore(0);
    setStatus('Loading…');
    setBusy(true);
    var btns = hudButtons();
    bind(gameListeners, btns.restart, 'click', function () { restart(); });

    loadScript('games/' + meta.file).then(function () {
      /* the player may already have navigated on while we were loading */
      if (current.meta !== meta) return;
      var mod = window.PixelGame;
      if (!mod || typeof mod.start !== 'function') {
        current.meta = null;
        setBusy(false);
        ready(true);
        showMissing('ERR', 'This cabinet failed to boot',
          'games/' + meta.file + ' loaded but did not register a PixelGame module. ' +
          'It is most likely still a work in progress.');
        return;
      }
      renderHowTo();
      try {
        current.instance = mod.start(root(), api) || null;
      } catch (err) {
        current.meta = null;
        setBusy(false);
        ready(true);
        showMissing('ERR', 'This cabinet crashed',
          'The game threw an error while starting. Try reloading the page, or pick another game.');
        return;
      }
      setBusy(false);
      ready(true);
      setStatus('Playing');
      applyStructuredData(meta);   /* only now is the cabinet really loaded */
      if (dom.howBox) dom.howBox.removeAttribute('hidden');
    }).catch(function () {
      if (current.meta !== meta) return;
      current.meta = null;
      setBusy(false);
      ready(true);
      showMissing('ERR', 'Game file not found',
        'We could not load games/' + meta.file + '. That build has not shipped yet — ' +
        'try another cabinet from the library.');
    });
  }

  /* ------------------------------------------------------------------ boot */
  function boot() {
    installStyles();
    resolveDom();
    resolveHudNodes();
    wirePicker();
    wireFullscreen();
    wireFocusRelease();
    wireHowTo();
    wireKeys();
    wireBack();
    wireUnload();
    startGame(slugFromLocation(), false);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
