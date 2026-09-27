/* PIXELRUSH — js/catalog.js
 *
 * games.html behaviour. Renders window.GAMES into #game-grid, wires search /
 * genre chips / sort, debounces input, keeps #result-count live, toggles
 * #no-results, mirrors state into the URL, adds pointer tilt, and publishes the
 * page's structured data (JSON-LD) into <head>.
 *
 * Public surface: none. This file is an IIFE — it only touches the DOM and the
 * address bar. Everything it reads comes from the globals below.
 *
 * Depends on: js/engine.js (window.PX — optional tilt helper + perf flags),
 *             js/games-data.js (window.GAMES — the catalogue source of truth).
 *
 * Expects from the DOM (all optional except #game-grid, which gates init):
 *   #game-grid      grid container the cards are rendered into
 *   #game-search    search input
 *   #genre-filters  container of .chip filter buttons
 *   #game-sort      <select> for the sort order
 *   #result-count   live region announcing the visible game count
 *   #no-results     empty-state block shown when nothing matches
 *
 * Must never throw: it runs on a page where any of the above may be missing,
 * and a catalogue script is not allowed to take the page down with it.
 */
(function () {
  'use strict';

  /* ------------------------------------------------ canonical SEO identity */
  /* Values are fixed by qa/SEO-GUIDE.md. Change them in the guide first, then
     here — the @id graph has to be identical across every page for the
     entities to join up. The base URL is a placeholder the owner replaces. */

  var SITE = {
    base: 'https://pixelrush.example',
    description: 'PixelRush is a free browser arcade. Twenty-four instant-play ' +
      'canvas games — arcade, puzzle, racing, strategy, casual and sports. ' +
      'No download, no signup, plays in one tap.'
  };
  var SCHEMA_ID = 'px-catalog-schema';   // id of the script tag we inject
  var ORG_ID = SITE.base + '/#organization';
  var WEBSITE_ID = SITE.base + '/#website';
  var PAGE_ID = SITE.base + '/games.html#webpage';
  var PAGE_URL = SITE.base + '/games.html';

  /* Card accent colours, keyed by the `color` token in games-data.js. An
     unknown token falls back to cyan rather than emitting an empty --g. */
  var COLOR_VARS = {
    cyan: 'var(--cyan)',
    magenta: 'var(--magenta)',
    acid: 'var(--acid)',
    orange: 'var(--orange)',
    violet: 'var(--violet)'
  };

  /* Sort comparators for #game-sort. `az` uses localeCompare; every other key
     falls back to title so ties never shuffle between renders. */
  var SORTS = {
    popular: function (a, b) { return (b.plays || 0) - (a.plays || 0); },
    rating: function (a, b) { return (b.rating || 0) - (a.rating || 0); },
    az: function (a, b) { return String(a.title || '').localeCompare(String(b.title || '')); }
  };
  var DEFAULT_SORT = 'popular';

  var GRID = null;
  var SEARCH = null;
  var CHIPS = null;
  var SORT_SEL = null;
  var COUNT = null;
  var EMPTY = null;

  var state = { q: '', genres: [], sort: DEFAULT_SORT };
  var games = [];
  var debounceId = 0;
  var tiltBound = false;

  /* --------------------------------------------------------- structured data
   * games.html is the page that lists the catalogue, so it is also the page
   * that publishes the ItemList of every game. The guide wants one
   * <script type="application/ld+json"> in <head> holding a @graph of
   * CollectionPage + ItemList + BreadcrumbList + WebPage.
   *
   * Every value below is read from window.GAMES (js/games-data.js). Nothing is
   * invented: no title, blurb, rating or count is typed in by hand. Games that
   * carry no rating get no aggregateRating, and ratingCount only appears when
   * the entry has a non-zero `plays` figure — the repo holds no review data,
   * so a review count would have to be made up.
   */

  function videoGameNode(g) {
    var url = SITE.base + '/play.html?game=' + encodeURIComponent(g.slug || '');
    var node = {
      '@type': 'VideoGame',
      '@id': url + '#game',
      name: String(g.title || ''),
      url: url,
      description: String(g.blurb || ''),
      inLanguage: 'en',
      isAccessibleForFree: true,
      gameGenre: String(g.genre || ''),
      keywords: toArray(g.tags).join(', ')
    };
    if (g.difficulty) node.gameDifficulty = String(g.difficulty);
    if (g.players) node.numberOfPlayers = String(g.players);
    if (typeof g.rating === 'number' && isFinite(g.rating)) {
      node.aggregateRating = {
        '@type': 'AggregateRating',
        ratingValue: g.rating,
        bestRating: 5,
        worstRating: 1
      };
      if (typeof g.plays === 'number' && g.plays > 0) {
        node.aggregateRating.ratingCount = g.plays;
      }
    }
    return node;
  }

  function schemaGraph(list) {
    var items = list.map(videoGameNode);
    return {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'WebPage',
          '@id': PAGE_ID,
          url: PAGE_URL,
          name: 'All Games — PixelRush',
          description: SITE.description,
          isPartOf: { '@id': WEBSITE_ID },
          about: { '@id': ORG_ID },
          inLanguage: 'en',
          breadcrumb: { '@id': PAGE_URL + '#breadcrumb' }
        },
        {
          '@type': 'BreadcrumbList',
          '@id': PAGE_URL + '#breadcrumb',
          itemListElement: [
            {
              '@type': 'ListItem',
              position: 1,
              name: 'Home',
              item: SITE.base + '/index.html'
            },
            {
              '@type': 'ListItem',
              position: 2,
              name: 'Games',
              item: PAGE_URL
            }
          ]
        },
        {
          '@type': 'CollectionPage',
          '@id': PAGE_URL + '#collection',
          url: PAGE_URL,
          name: 'All Games — PixelRush',
          description: SITE.description,
          isPartOf: { '@id': WEBSITE_ID },
          inLanguage: 'en',
          mainEntity: {
            '@type': 'ItemList',
            '@id': PAGE_URL + '#gamelist',
            numberOfItems: items.length,
            itemListOrder: 'https://schema.org/ItemListOrderAscending',
            itemListElement: items.map(function (n, i) {
              return {
                '@type': 'ListItem',
                position: i + 1,
                item: { '@id': n['@id'] }
              };
            })
          }
        }
      ].concat(items)
    };
  }

  /* Injects the @graph into <head>.
     games.html now also carries a static ld+json block, which is the one search
     engines should see. This is the fallback for the case where that block is
     missing: if any ld+json script is already in <head> we do nothing, so the
     page can never end up with two competing graphs. */
  function injectSchema(list) {
    try {
      if (!list || !list.length) return;
      if (!document.head) return;
      var head = document.head;
      var existing = head.querySelector('#' + SCHEMA_ID);
      if (existing) { head.removeChild(existing); }
      if (head.querySelector('script[type="application/ld+json"]')) return;

      var script = document.createElement('script');
      script.type = 'application/ld+json';
      script.id = SCHEMA_ID;
      script.textContent = JSON.stringify(schemaGraph(list));
      head.appendChild(script);
    } catch (e) { /* structured data is never worth a console error */ }
  }

  /* ---------------------------------------------------------------- utils */

  function px() { return window.PX || null; }

  function lite() {
    var P = px();
    if (P && (P.perfLite || P.reduced)) return true;
    try {
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return true;
    } catch (e) {}
    return false;
  }

  function toArray(list) {
    if (!list) return [];
    try { return Array.prototype.slice.call(list); } catch (e) { return []; }
  }

  function norm(s) {
    return String(s == null ? '' : s).toLowerCase().trim();
  }

  function debounce(fn, ms) {
    return function () {
      if (debounceId) clearTimeout(debounceId);
      debounceId = setTimeout(function () { debounceId = 0; fn(); }, ms);
    };
  }

  /* ----------------------------------------------------------------- card */

  function colorVar(c) { return COLOR_VARS[c] || COLOR_VARS.cyan; }

  function metaFor(g) {
    var out = [];
    if (g.genre) out.push(String(g.genre));
    if (g.difficulty) out.push(String(g.difficulty));
    if (g.players) out.push(String(g.players));
    if (g.duration) out.push(String(g.duration));
    return out.slice(0, 3);
  }

  function el(tag, cls) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
  }

  function buildCard(g) {
    var soon = g.status === 'coming-soon';
    var article = el('article', soon ? 'gcard is-locked' : 'gcard');
    article.setAttribute('data-genre', String(g.genre || ''));
    article.setAttribute('data-status', soon ? 'coming-soon' : 'live');
    article.setAttribute('data-title', norm(g.title));
    article.setAttribute('data-slug', String(g.slug || ''));

    var inner;
    if (soon) {
      inner = el('div', 'gcard__link');
      inner.setAttribute('aria-disabled', 'true');
    } else {
      inner = el('a', 'gcard__link');
      inner.setAttribute('href', 'play.html?game=' + encodeURIComponent(g.slug || ''));
      inner.setAttribute('aria-label', 'Play ' + String(g.title || 'this game'));
    }

    var art = el('div', 'gcard__art');
    art.style.setProperty('--g', colorVar(g.color));

    var glyph = el('span', 'gcard__glyph');
    // trusted, in-repo inline SVG string
    glyph.innerHTML = typeof g.glyph === 'string' && g.glyph ? g.glyph : '';

    art.appendChild(glyph);
    art.appendChild(el('span', 'gcard__scan'));
    art.appendChild(el('span', 'gcard__shine'));

    var body = el('div', 'gcard__body');

    var title = el('h3', 'gcard__title');
    title.textContent = String(g.title || '');
    body.appendChild(title);

    var blurb = el('p', 'gcard__blurb');
    blurb.textContent = String(g.blurb || '');
    body.appendChild(blurb);

    var meta = el('ul', 'gcard__meta');
    metaFor(g).forEach(function (m) {
      var li = document.createElement('li');
      li.textContent = m;
      meta.appendChild(li);
    });
    body.appendChild(meta);

    inner.appendChild(art);
    inner.appendChild(body);

    if (soon) {
      var badge = el('span', 'gcard__soon');
      badge.textContent = 'SOON';
      inner.appendChild(badge);
    } else {
      var play = el('span', 'gcard__play');
      play.textContent = 'PLAY';
      play.setAttribute('aria-hidden', 'true');
      inner.appendChild(play);
    }

    article.appendChild(inner);
    return article;
  }

  /* ------------------------------------------------------------- filtering */

  function matches(g) {
    var qs = state.q;
    if (qs) {
      var hay = norm(g.title) + ' ' + norm(g.blurb) + ' ' + norm(g.genre) + ' ' +
        toArray(g.tags).map(norm).join(' ');
      if (hay.indexOf(qs) === -1) return false;
    }
    if (state.genres.length) {
      var gv = norm(g.genre);
      var ok = false;
      for (var i = 0; i < state.genres.length; i++) {
        if (gv === state.genres[i]) { ok = true; break; }
      }
      if (!ok) return false;
    }
    return true;
  }

  function sorted(list) {
    var cmp = SORTS[state.sort] || SORTS[DEFAULT_SORT];
    return list.slice().sort(function (a, b) {
      var r = cmp(a, b);
      return r !== 0 ? r : String(a.title || '').localeCompare(String(b.title || ''));
    });
  }

  /* ---------------------------------------------------------------- render */

  function render() {
    if (!GRID) return;
    var list = sorted(games.filter(matches));

    var frag = document.createDocumentFragment();
    list.forEach(function (g) { frag.appendChild(buildCard(g)); });
    GRID.textContent = '';
    GRID.appendChild(frag);

    if (COUNT) {
      COUNT.textContent = list.length === 0 ? 'No games match'
        : list.length + (list.length === 1 ? ' game' : ' games');
    }
    if (EMPTY) {
      var empty = list.length === 0;
      if (empty) EMPTY.removeAttribute('hidden');
      else EMPTY.setAttribute('hidden', '');
      EMPTY.classList.toggle('is-visible', empty);
    }
    GRID.classList.toggle('is-empty', list.length === 0);

    bindTilt();
  }

  /* ------------------------------------------------------------------ tilt */

  function bindTilt() {
    if (tiltBound || !GRID) return;
    var P = px();
    if (P && typeof P.registerPointerTilt === 'function') {
      try { P.registerPointerTilt('.gcard__link'); tiltBound = true; return; }
      catch (e) { /* fall through to local fallback */ }
    }
    if (lite()) return;
    tiltBound = true;
    localTilt(GRID);
  }

  // Minimal self-contained fallback when engine.js offers no tilt helper.
  function localTilt(scope) {
    var MAX = 6;
    var targets = toArray(scope.querySelectorAll('.gcard__link:not([aria-disabled])'));
    targets.forEach(function (node) {
      var raf = 0;
      var rect = null;
      function onMove(e) {
        if (raf) return;
        var pt = e.touches ? e.touches[0] : e;
        if (!pt) return;
        raf = requestAnimationFrame(function () {
          raf = 0;
          if (!rect) rect = node.getBoundingClientRect();
          var cx = rect.left + rect.width / 2;
          var cy = rect.top + rect.height / 2;
          var dx = Math.max(-MAX, Math.min(MAX, ((pt.clientX - cx) / (rect.width / 2)) * MAX));
          var dy = Math.max(-MAX, Math.min(MAX, ((pt.clientY - cy) / (rect.height / 2)) * MAX));
          node.style.transform = 'perspective(700px) rotateX(' + (-dy).toFixed(2) + 'deg) rotateY(' + dx.toFixed(2) + 'deg) translateZ(0) scale(1.02)';
        });
      }
      function onLeave() {
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        rect = null;
        node.style.transform = '';
      }
      if (window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
        node.addEventListener('pointermove', onMove, { passive: true });
        node.addEventListener('pointerleave', onLeave, { passive: true });
      }
    });
  }

  /* ------------------------------------------------------------------- URL */

  function readURL() {
    var p = {};
    try { p = new URLSearchParams(window.location.search || ''); } catch (e) { p = null; }
    if (!p) {
      var s = String(window.location.search || '').replace(/^\?/, '');
      s.split('&').forEach(function (pair) {
        if (!pair) return;
        var i = pair.indexOf('=');
        var k = decodeURIComponent(i === -1 ? pair : pair.slice(0, i)).toLowerCase();
        p[k] = i === -1 ? '' : decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' '));
      });
    }
    function param(key) {
      if (p && typeof p.get === 'function') {
        var v = p.get(key);
        return v == null ? '' : String(v);
      }
      return p[key] || '';
    }

    state.q = norm(param('q'));
    state.genres = param('genre').split(',').map(norm)
      .filter(function (g) { return g && g !== 'all' && g !== 'any'; });
    var srt = norm(param('sort'));
    if (srt && SORTS[srt]) state.sort = srt;
  }

  function writeURL() {
    if (!window.history || !window.history.replaceState) return;
    var qs = [];
    if (state.q) qs.push('q=' + encodeURIComponent(state.q));
    if (state.genres.length) {
      qs.push('genre=' + state.genres.map(function (g) {
        return encodeURIComponent(g.charAt(0).toUpperCase() + g.slice(1));
      }).join(','));
    }
    if (state.sort !== DEFAULT_SORT) qs.push('sort=' + encodeURIComponent(state.sort));
    var url = window.location.pathname + (qs.length ? '?' + qs.join('&') : '') + window.location.hash;
    try { window.history.replaceState(null, '', url); } catch (e) {}
  }

  /* ----------------------------------------------------------------- chips */

  function chipValue(btn) {
    return norm(btn.getAttribute('data-genre') ||
      btn.getAttribute('data-value') || btn.getAttribute('value') || '');
  }

  function syncChips() {
    if (!CHIPS) return;
    toArray(CHIPS.querySelectorAll('.chip')).forEach(function (btn) {
      var v = chipValue(btn);
      var on = (v === '' || v === 'all' || v === 'any')
        ? state.genres.length === 0
        : state.genres.indexOf(v) !== -1;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function onChipClick(e) {
    var btn = e.target && e.target.closest ? e.target.closest('.chip') : null;
    if (!btn || btn.disabled) return;
    var v = chipValue(btn);
    if (v === '' || v === 'all' || v === 'any') {
      state.genres = [];
    } else {
      var i = state.genres.indexOf(v);
      if (i === -1) state.genres.push(v);
      else state.genres.splice(i, 1);
    }
    syncChips();
    writeURL();
    render();
  }

  /* ------------------------------------------------------------------ init */

  function collectGenres() {
    if (!CHIPS) return;
    toArray(CHIPS.querySelectorAll('.chip')).forEach(function (btn) {
      var v = chipValue(btn);
      if (v && v !== 'all' && v !== 'any') {
        var label = (btn.textContent || '').trim();
        if (label) btn.setAttribute('title', 'Filter: ' + label);
      }
    });
  }

  function init() {
    GRID = document.getElementById('game-grid');
    SEARCH = document.getElementById('game-search');
    CHIPS = document.getElementById('genre-filters');
    SORT_SEL = document.getElementById('game-sort');
    COUNT = document.getElementById('result-count');
    EMPTY = document.getElementById('no-results');
    if (!GRID) return;

    games = (Array.isArray(window.GAMES) ? window.GAMES : [])
      .filter(function (g) { return g && typeof g === 'object'; });

    // Publish the catalogue as structured data before rendering, so the
    // ItemList reflects the full library, not the active filter.
    injectSchema(games);

    readURL();
    collectGenres();

    if (SEARCH) {
      SEARCH.value = state.q;
      var onType = debounce(function () {
        state.q = norm(SEARCH.value);
        writeURL();
        render();
      }, 180);
      SEARCH.addEventListener('input', onType, { passive: true });
      SEARCH.addEventListener('search', onType, { passive: true });
    }

    if (CHIPS) CHIPS.addEventListener('click', onChipClick);

    if (SORT_SEL) {
      if (state.sort) SORT_SEL.value = state.sort;
      SORT_SEL.addEventListener('change', function () {
        var v = norm(SORT_SEL.value) || DEFAULT_SORT;
        state.sort = SORTS[v] ? v : DEFAULT_SORT;
        writeURL();
        render();
      });
    }

    syncChips();
    render();
    writeURL();
  }

  function start() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
      init();
    }
  }

  if (document.readyState === 'loading') start();
  else start();
})();
