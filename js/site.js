/* =============================================================
   PIXELRUSH — js/site.js
   Index page behaviour. Pure vanilla, no deps.

   PUBLIC SURFACE: none. This is an IIFE — it exports no globals and
   registers no listeners other than the ones it owns. Everything it
   does is fire-and-forget on DOM ready.

   EXPECTS FROM THE DOM (all optional, all feature-detected):
     header.nav / .nav         -> 1. sticky "is-scrolled" state
     #nav-toggle + its panel   -> 2. mobile menu (panel resolved via
                                  aria-controls, #nav-menu, .nav__menu,
                                  .nav__panel, [data-nav-menu], sibling)
     a[href^="#"]              -> 3. smooth scroll to in-page anchors
     #hero / .hero             -> 4. pointer parallax (--mx / --my)
     [data-count-to]           -> 5. stat counters
     .rail__track + .scene     -> 6. pinned horizontal rail (--rail-x)
     #games .rail (if empty)   -> 7. featured cards built from GAMES
     .ticker__track            -> 8. marquee duplication
     details, .faq, [data-faq] -> 9. FAQ accordion
     #motion-toggle            -> 10. motion on/off (state owned by PX)

   Depends on: window.PX (js/engine.js, loaded before this),
   optional: window.GAMES (js/games-data.js).

   NOT OWNED HERE — do not add to this file:
     * Structured data. Every page's JSON-LD is static markup in that
       page's own <head> (index.html, games.html, about.html, ...), and
       play.html's single-game block is injected by js/player.js. This
       file runs on every page of the site, so injecting schema from
       here would emit the home page's graph on about.html too.
     * Search / filtering (js/catalog.js) and game state (js/player.js).

   Hard requirement from SPEC: this file must never throw when a
   hook element is absent — every section is feature-detected, and the
   shared rAF flush swallows per-section errors so one broken section
   cannot take the page down.
   ============================================================= */
(function () {
  'use strict';

  var PX = window.PX || {};
  var doc = document;
  var root = doc.documentElement;

  /* ---------- helpers ------------------------------------------------ */

  function onReady(fn) {
    if (doc.readyState === 'loading') {
      doc.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  function reduced() {
    if (typeof PX.reduced === 'boolean') return PX.reduced;
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function coarse() {
    return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches) || root.classList.contains('perf-lite');
  }

  /* Single shared rAF scheduler: every scroll/pointer handler flags a
     job and a single frame flushes them all. No per-frame layout reads
     happen here — each job owns its own cached geometry. */
  var jobs = Object.create(null);
  var frameId = 0;
  function schedule(name, fn) {
    jobs[name] = fn;
    if (frameId) return;
    frameId = requestAnimationFrame(flush);
  }
  function flush() {
    frameId = 0;
    for (var k in jobs) {
      var fn = jobs[k];
      jobs[k] = null;
      try { fn(); } catch (e) { /* never let one section break the page */ }
    }
  }
  function onScrollPassive(fn, name) {
    window.addEventListener('scroll', function () { schedule(name || 'scroll', fn); }, { passive: true });
  }

  function cssEl(name) {
    try { return document.createElement(name); } catch (e) { return null; }
  }

  function setVar(el, prop, value) {
    if (el && el.style && typeof el.style.setProperty === 'function') el.style.setProperty(prop, value);
  }

  /* ---------- 1. sticky nav: .is-scrolled ---------------------------- */

  function initNavScroll() {
    var nav = doc.querySelector('header.nav') || doc.querySelector('.nav');
    if (!nav) return;
    var lastY = -1;
    function update() {
      var y = window.pageYOffset || root.scrollTop || 0;
      if (y === lastY) return;
      lastY = y;
      var threshold = 12;
      var cs = getComputedStyle(root);
      var navH = parseInt(cs.getPropertyValue('--nav-h'), 10);
      if (!navH || isNaN(navH)) navH = 74;
      var shrunk = y > Math.max(threshold, navH * 0.35);
      if (shrunk) nav.classList.add('is-scrolled'); else nav.classList.remove('is-scrolled');
      /* The nav shrinks when it sticks, but anything parked underneath it
         (the catalog search bar) was still using the full --nav-h, which left a
         gap the page scrolled through. Publish the nav's REAL height so
         sticky siblings can sit flush against it. */
      var live = Math.round(nav.getBoundingClientRect().height);
      if (live > 0) root.style.setProperty('--nav-live', live + 'px');
    }
    update();
    onScrollPassive(update, 'nav');
    window.addEventListener('resize', function () { schedule('nav', update); }, { passive: true });
  }

  /* ---------- 2. mobile menu ----------------------------------------- */

  function initMobileMenu() {
    var toggle = doc.getElementById('nav-toggle');
    if (!toggle) return;

    /* The spec names #nav-toggle but not the panel. Resolve the panel in
       this order: aria-controls → #nav-menu → .nav__menu → .nav__panel →
       [data-nav-menu] → the toggle's own next <nav>/<div>. */
    var panel = null;
    var ac = toggle.getAttribute('aria-controls');
    if (ac) panel = doc.getElementById(ac);
    if (!panel) panel = doc.getElementById('nav-menu');
    if (!panel) panel = doc.querySelector('.nav__menu, .nav__panel, [data-nav-menu]');
    if (!panel) {
      var sib = toggle.parentNode && toggle.parentNode.querySelector('nav, ul, div');
      panel = sib || null;
    }

    var isOpen = false;
    var lastFocused = null;

    function setOpen(next) {
      if (isOpen === next) return;
      isOpen = next;
      toggle.setAttribute('aria-expanded', next ? 'true' : 'false');
      toggle.classList.toggle('is-active', next);
      if (panel) {
        panel.classList.toggle('is-open', next);
        panel.setAttribute('aria-hidden', next ? 'false' : 'true');
      }
      root.classList.toggle('nav-open', next);
      if (next) {
        lastFocused = doc.activeElement;
        var first = panel && panel.querySelector('a[href], button:not([disabled])');
        if (first) { try { first.focus({ preventScroll: true }); } catch (e) { first.focus(); } }
      } else if (lastFocused && lastFocused.focus) {
        try { lastFocused.focus({ preventScroll: true }); } catch (e) { lastFocused.focus(); }
        lastFocused = null;
      }
    }

    toggle.addEventListener('click', function (e) {
      e.preventDefault();
      setOpen(!isOpen);
    });

    /* Close after following an in-page link, and close on outside tap. */
    if (panel) {
      panel.addEventListener('click', function (e) {
        var t = e.target;
        while (t && t !== panel) {
          if (t.tagName === 'A') { setOpen(false); return; }
          t = t.parentNode;
        }
      });
    }
    doc.addEventListener('click', function (e) {
      if (!isOpen) return;
      if (toggle.contains(e.target)) return;
      if (panel && panel.contains(e.target)) return;
      setOpen(false);
    });

    doc.addEventListener('keydown', function (e) {
      if (!isOpen) return;
      if (e.key === 'Escape' || e.key === 'Esc') {
        e.preventDefault();
        setOpen(false);
      } else if (e.key === 'Tab' && panel) {
        /* keep focus inside the open panel */
        var f = panel.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])');
        if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if (e.shiftKey && doc.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && doc.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });

    doc.addEventListener('keyup', function (e) {
      if (isOpen && (e.key === 'Escape' || e.key === 'Esc')) setOpen(false);
    });

    /* Reset state if the viewport grows past the breakpoint. */
    var mq = window.matchMedia && window.matchMedia('(min-width: 901px)');
    if (mq) {
      var onChange = function (ev) { if (ev.matches) setOpen(false); };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
  }

  /* ---------- 3. smooth scroll for in-page anchors -------------------- */

  function initSmoothScroll() {
    doc.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[href^="#"]') : null;
      if (!a) return;
      var hash = a.getAttribute('href');
      if (!hash || hash === '#' || hash.length < 2) return;
      var id = hash.slice(1);
      var target = null;
      try { target = doc.getElementById(id); } catch (err) { target = null; }
      if (!target) return;

      e.preventDefault();
      var offset = 0;
      try {
        var navH = parseInt(getComputedStyle(root).getPropertyValue('--nav-h'), 10);
        offset = (isNaN(navH) ? 74 : navH) + 8;
      } catch (err) { offset = 82; }

      var top = target.getBoundingClientRect().top + (window.pageYOffset || 0) - offset;
      if (top < 0) top = 0;

      if (reduced() || !window.scrollTo) {
        window.scrollTo(0, top);
      } else {
        try { window.scrollTo({ top: top, behavior: 'smooth' }); }
        catch (err) { window.scrollTo(0, top); }
      }
      /* keep the URL shareable without a double jump */
      if (history && history.replaceState) history.replaceState(null, '', hash);

      if (target.hasAttribute('tabindex')) target.focus({ preventScroll: true });
      else if (!/^(A|AREA|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(target.tagName)) {
        target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
      }
    }, { passive: false });
  }

  /* ---------- 4. hero pointer parallax: --mx / --my -------------------- */

  function initHeroParallax() {
    var hero = doc.getElementById('hero') || doc.querySelector('.hero');
    if (!hero) return;
    if (reduced() || coarse()) {
      setVar(hero, '--mx', '0px');
      setVar(hero, '--my', '0px');
      return;
    }
    var strength = 1;
    var attr = hero.getAttribute('data-parallax-strength');
    if (attr) { var s = parseFloat(attr); if (!isNaN(s)) strength = s; }

    var rect = null;               /* cached geometry — no per-frame reads */
    var tx = 0, ty = 0, cx = 0, cy = 0;  /* target vs. eased current */
    var active = false;

    function measure() {
      rect = hero.getBoundingClientRect();
    }
    function apply() {
      cx += (tx - cx) * 0.09;
      cy += (ty - cy) * 0.09;
      setVar(hero, '--mx', (cx * 26 * strength).toFixed(2) + 'px');
      setVar(hero, '--my', (cy * 18 * strength).toFixed(2) + 'px');
      if (Math.abs(tx - cx) > 0.001 || Math.abs(ty - cy) > 0.001) schedule('heroPtr', apply);
      else { setVar(hero, '--mx', (cx * 26 * strength).toFixed(2) + 'px');
             setVar(hero, '--my', (cy * 18 * strength).toFixed(2) + 'px'); }
    }

    hero.addEventListener('pointerenter', function () {
      if (reduced() || coarse()) return;
      active = true; measure(); hero.classList.add('is-pointing');
    });
    hero.addEventListener('pointermove', function (e) {
      if (!active || !rect) return;
      var w = rect.width || hero.offsetWidth || 1;
      var h = rect.height || hero.offsetHeight || 1;
      tx = ((e.clientX - rect.left) / w - 0.5) * 2;
      ty = ((e.clientY - rect.top) / h - 0.5) * 2;
      schedule('heroPtr', apply);
    }, { passive: true });
    function release() {
      active = false; hero.classList.remove('is-pointing');
      tx = 0; ty = 0; schedule('heroPtr', apply);
    }
    hero.addEventListener('pointerleave', release);
    hero.addEventListener('pointercancel', release);
    hero.addEventListener('blur', release);

    window.addEventListener('resize', function () {
      measure();
      if (!active) schedule('heroPtr', apply);
    }, { passive: true });
    onScrollPassive(function () { if (active) { measure(); } }, 'heroMeasure');
  }

  /* ---------- 5. stat counters: 0 → data-count-to --------------------- */

  function easeOutExpo(t) { return t === 1 ? 1 : 1 - Math.pow(2, -10 * t); }
  function easeOutQuint(t) { return 1 - Math.pow(1 - t, 5); }

  function runCounter(el) {
    var to = parseFloat(el.getAttribute('data-count-to'));
    if (isNaN(to)) return;
    if (reduced()) { el.textContent = format(to, el); return; }

    var dur = parseFloat(el.getAttribute('data-count-duration'));
    if (isNaN(dur) || dur <= 0) dur = 1600;
    var suffix = el.getAttribute('data-count-suffix') || '';
    var prefix = el.getAttribute('data-count-prefix') || '';
    var start = null;
    el.classList.add('is-counting');

    function step(ts) {
      if (start === null) start = ts;
      var p = Math.min(1, (ts - start) / dur);
      var v = to * easeOutExpo(p);
      el.textContent = prefix + format(v, el) + suffix;
      if (p < 1) requestAnimationFrame(step);
      else {
        el.textContent = prefix + format(to, el) + suffix;
        el.classList.remove('is-counting');
        el.classList.add('is-counted');
      }
    }
    requestAnimationFrame(step);
  }

  function format(v, el) {
    var decimals = parseInt(el.getAttribute('data-count-decimals') || '0', 10);
    if (isNaN(decimals)) decimals = 0;
    if (decimals > 0) return v.toFixed(decimals);
    var n = Math.round(v);
    if (el.getAttribute('data-count-format') === 'plain') return String(n);
    return n.toLocaleString ? n.toLocaleString('en-US') : String(n);
  }

  function initCounters() {
    var nodes = doc.querySelectorAll('[data-count-to]');
    if (!nodes.length) return;
    if (!('IntersectionObserver' in window)) {
      for (var i = 0; i < nodes.length; i++) runCounter(nodes[i]);
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        runCounter(e.target);
      }
    /* threshold 0 — a stat number can sit inside a clip-path reveal, which
       drives its intersection ratio to 0 and would stall any higher threshold. */
    }, { threshold: 0, rootMargin: '0px 0px -8% 0px' });
    for (var j = 0; j < nodes.length; j++) {
      var n = nodes[j];
      if (n.textContent === '' || n.textContent === '0') n.textContent = '0';
      io.observe(n);
    }
  }

  /* ---------- 6. pinned horizontal game rail: --rail-x ----------------- */
  /* The rail is a horizontal strip inside a vertical page. While the
     section is under the viewport we translate the track sideways with
     scroll progress, so CSS alone owns every visual and this section
     only publishes two custom properties: --rail-x (the offset) and
     --rail-progress (0..1, for any progress bar the page wants). */

  function initRail() {
    var track = doc.querySelector('.rail__track') || doc.querySelector('.rail');
    if (!track) return;
    var section = track.closest ? track.closest('.scene') : null;
    if (!section) section = doc.getElementById('games') || doc.querySelector('.scene--rail') || null;
    if (!section) return;

    var vw = 0, travel = 0, startY = 0, endY = 0, current = -1;
    var hasProgress = false;

    function measure() {
      vw = window.innerWidth || doc.documentElement.clientWidth || 1;
      startY = section.getBoundingClientRect().top + (window.pageYOffset || 0);
      var h = section.offsetHeight || 0;
      endY = startY + h - vw;
      travel = Math.max(0, (track.scrollWidth || 0) - vw + 48);
      hasProgress = h > vw + 8;
    }

    function write(v) {
      if (v === current) return;
      current = v;
      var px = (reduced() || !hasProgress) ? 0 : (-v * travel);
      var str = px.toFixed(2) + 'px';
      setVar(root, '--rail-x', str);
      setVar(section, '--rail-x', str);
      setVar(track, '--rail-x', str);
      setVar(section, '--rail-progress', v.toFixed(4));
      track.style.transform = '';
    }

    function update() {
      if (!hasProgress) { write(0); return; }
      var y = window.pageYOffset || root.scrollTop || 0;
      var p = (y - startY) / (endY - startY || 1);
      if (p < 0) p = 0; else if (p > 1) p = 1;
      write(p);
    }

    measure();
    update();

    onScrollPassive(update, 'rail');
    var t = 0;
    window.addEventListener('resize', function () {
      clearTimeout(t);
      t = setTimeout(function () { measure(); update(); }, 120);
    }, { passive: true });
    window.addEventListener('orientationchange', function () {
      setTimeout(function () { measure(); update(); }, 240);
    });
    if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
      document.fonts.ready.then(function () { measure(); update(); }).catch(function () {});
    }
    if (window.ResizeObserver && !coarse()) {
      try {
        var ro = new ResizeObserver(function () { measure(); update(); });
        ro.observe(track);
        ro.observe(section);
      } catch (e) { /* ignore */ }
    }
  }

  /* ---------- 7. featured rail cards from window.GAMES ----------------- */
  /* Progressive enhancement only. The HTML author may have authored the
     rail markup by hand; this only fills an empty track, and it retries
     briefly because games-data.js is a separate file that may land
     after this one. One <a> per card, and cards marked coming-soon get
     aria-disabled + tabindex="-1" instead of a real href, so they never
     reach the keyboard tab order as a dead link. */

  function buildGCard(g) {
    var a = cssEl('article');
    if (!a) return null;
    a.className = 'gcard';
    a.setAttribute('data-genre', g.genre || '');
    a.setAttribute('data-status', g.status || 'live');
    a.setAttribute('data-title', String(g.title || '').toLowerCase());

    var live = g.status !== 'coming-soon';

    var link = cssEl('a');
    link.className = 'gcard__link';
    if (live) {
      link.setAttribute('href', 'play.html?game=' + encodeURIComponent(g.slug));
      link.setAttribute('aria-label', 'Play ' + g.title);
    } else {
      link.setAttribute('aria-disabled', 'true');
      link.setAttribute('tabindex', '-1');
    }

    var art = cssEl('div');
    art.className = 'gcard__art';
    art.setAttribute('aria-hidden', 'true');
    art.style.setProperty('--g', 'var(--' + (g.color || 'cyan') + ')');
    var glyph = cssEl('span');
    glyph.className = 'gcard__glyph';
    glyph.innerHTML = g.glyph || '';
    art.appendChild(glyph);
    var scan = cssEl('span'); scan.className = 'gcard__scan'; art.appendChild(scan);
    var shine = cssEl('span'); shine.className = 'gcard__shine'; art.appendChild(shine);

    var body = cssEl('div');
    body.className = 'gcard__body';
    var h3 = cssEl('h3'); h3.className = 'gcard__title'; h3.textContent = g.title || '';
    var p = cssEl('p'); p.className = 'gcard__blurb'; p.textContent = g.blurb || '';
    var meta = cssEl('ul'); meta.className = 'gcard__meta';
    [g.genre, g.difficulty, g.duration].forEach(function (v) {
      if (!v) return;
      var li = cssEl('li'); li.textContent = v; meta.appendChild(li);
    });
    body.appendChild(h3); body.appendChild(p); body.appendChild(meta);

    var play = cssEl('span');
    play.className = 'gcard__play';
    play.textContent = live ? 'PLAY' : 'SOON';

    link.appendChild(art);
    link.appendChild(body);
    link.appendChild(play);
    a.appendChild(link);
    return a;
  }

  function initFeatured() {
    var rail = doc.querySelector('#games .rail') || doc.querySelector('.rail');
    if (!rail) return;
    var track = rail.querySelector('.rail__track') || rail;
    /* Never wipe markup the HTML author already authored. */
    if (track.children.length) return;

    function render() {
      var list = window.GAMES;
      if (!list || !list.length) return false;
      var featured = list.slice(0, 6);
      var frag = doc.createDocumentFragment();
      for (var i = 0; i < featured.length; i++) {
        var c = buildGCard(featured[i]);
        if (c) frag.appendChild(c);
      }
      track.appendChild(frag);
      rail.setAttribute('data-featured-count', String(featured.length));
      return true;
    }

    if (!render()) {
      var tries = 0;
      var iv = setInterval(function () {
        if (render() || ++tries > 40) clearInterval(iv);
      }, 50);
    }
  }


  /* The featured rail is a native horizontal scroller now (the scroll-linked
     pin was removed — vertical scrolling must only ever scroll vertically).
     These are the affordances that make that obvious: arrows, drag-to-pan on
     a mouse, and a progress fill that tracks how far along the strip is. */
  function initRailControls() {
    var rail = doc.querySelector('#games .rail');
    if (!rail) return;
    var prev = doc.querySelector('[data-rail-prev]');
    var next = doc.querySelector('[data-rail-next]');
    var fill = doc.querySelector('#games .rail-progress__fill');

    function step() { return Math.max(180, Math.round(rail.clientWidth * 0.8)); }
    function sync() {
      var max = rail.scrollWidth - rail.clientWidth;
      if (prev) prev.disabled = rail.scrollLeft <= 2;
      if (next) next.disabled = rail.scrollLeft >= max - 2;
      if (fill) {
        var p = max > 4 ? rail.scrollLeft / max : 0;
        fill.style.transform = 'scaleX(' + (0.18 + p * 0.82).toFixed(3) + ')';
      }
    }
    if (prev) prev.addEventListener('click', function () { rail.scrollBy({ left: -step(), behavior: 'smooth' }); });
    if (next) next.addEventListener('click', function () { rail.scrollBy({ left: step(), behavior: 'smooth' }); });
    rail.addEventListener('scroll', sync, { passive: true });

    /* drag to pan with a mouse — a scroller you cannot grab reads as stuck */
    var down = false, startX = 0, startLeft = 0, moved = 0;
    rail.addEventListener('pointerdown', function (e) {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      down = true; moved = 0; startX = e.clientX; startLeft = rail.scrollLeft;
      rail.style.cursor = 'grabbing'; rail.style.scrollSnapType = 'none';
    });
    window.addEventListener('pointermove', function (e) {
      if (!down) return;
      var dx = e.clientX - startX;
      moved = Math.max(moved, Math.abs(dx));
      rail.scrollLeft = startLeft - dx;
    });
    window.addEventListener('pointerup', function () {
      if (!down) return;
      down = false; rail.style.cursor = ''; rail.style.scrollSnapType = '';
    });
    /* a drag must not also open the card it started on */
    rail.addEventListener('click', function (e) {
      if (moved > 6) { e.preventDefault(); e.stopPropagation(); }
    }, true);
    window.addEventListener('resize', sync, { passive: true });
    sync();
  }

  /* ---------- 8. ticker marquee duplication --------------------------- */
  /* A CSS marquee scrolls one <set> across and needs a second identical
     <set> to butt against it seamlessly. Guarded per track so a rebuild
     never stacks a third copy. */

  function initMarquee() {
    var tracks = doc.querySelectorAll('.ticker__track');
    for (var i = 0; i < tracks.length; i++) {
      var t = tracks[i];
      if (t.getAttribute('data-marquee-clone') === 'done') continue;
      if (t.parentNode && t.parentNode.getAttribute('data-marquee-built') === '1') {
        t.setAttribute('data-marquee-clone', 'done');
        continue;
      }
      /* The markup already ships the second, aria-hidden .ticker__set inside the
         track (that is the shape the marquee keyframes are written against).
         Cloning the whole track again stacked a second copy under the first,
         which doubled the ticker height and read as a wrapped second row. */
      if (t.querySelectorAll('.ticker__set').length >= 2) {
        t.setAttribute('data-marquee-clone', 'done');
        if (t.parentNode) t.parentNode.setAttribute('data-marquee-built', '1');
        continue;
      }
      var clone = t.cloneNode(true);
      clone.setAttribute('aria-hidden', 'true');
      clone.setAttribute('data-marquee-clone', 'done');
      t.setAttribute('data-marquee-clone', 'done');
      if (t.parentNode) {
        t.parentNode.appendChild(clone);
        t.parentNode.setAttribute('data-marquee-built', '1');
      }
    }
  }

  /* ---------- 9. FAQ accordion ---------------------------------------- */
  /* Two markup shapes are supported: native <details> (the preferred
     one — open/close works with no JS and no ARIA) and a
     .faq__q[aria-expanded] button + .faq__a panel pair. Both get
     single-open behaviour within their group. */

  function initFaq() {
    /* Native <details> accordion: keep one open at a time. */
    var groups = doc.querySelectorAll('.faq, [data-faq], #faq');
    var detailsList = doc.querySelectorAll('details');
    var any = false;
    if (groups.length) {
      for (var g = 0; g < groups.length; g++) {
        if (groups[g].querySelector('details, .faq__q')) { any = true; break; }
      }
    }
    if (detailsList.length) any = true;
    if (!any) return;

    function closeSiblings(item) {
      var parent = item.parentNode;
      while (parent && parent !== doc.body) {
        if (parent.classList && (parent.classList.contains('faq') || parent.hasAttribute('data-faq'))) break;
        parent = parent.parentNode;
      }
      if (!parent || parent === doc.body) parent = item.parentNode;
      var sibs = parent.querySelectorAll('details[open], .faq__item.is-open');
      for (var i = 0; i < sibs.length; i++) {
        if (sibs[i] === item) continue;
        if (sibs[i].tagName === 'DETAILS') sibs[i].removeAttribute('open');
        else sibs[i].classList.remove('is-open');
        var h = sibs[i].querySelector ? sibs[i].querySelector('.faq__q[aria-expanded]') : null;
        if (h) h.setAttribute('aria-expanded', 'false');
      }
    }

    for (var i = 0; i < detailsList.length; i++) {
      (function (d) {
        d.addEventListener('toggle', function () {
          if (d.open) closeSiblings(d);
          d.classList.toggle('is-open', d.open);
        });
      })(detailsList[i]);
    }

    /* Button-driven variant: .faq__q[aria-expanded] + .faq__a / .faq__item */
    var qs = doc.querySelectorAll('.faq__q[aria-expanded]');
    for (var j = 0; j < qs.length; j++) {
      (function (btn) {
        var item = btn.closest('.faq__item') || btn.parentNode;
        var panel = item ? item.querySelector('.faq__a, .faq__answer') : null;
        var ctl = btn.getAttribute('aria-controls');
        if (!panel && ctl) panel = doc.getElementById(ctl);
        btn.addEventListener('click', function () {
          var open = btn.getAttribute('aria-expanded') === 'true';
          if (!open) closeSiblings(item);
          btn.setAttribute('aria-expanded', open ? 'false' : 'true');
          if (item) item.classList.toggle('is-open', !open);
          if (panel) {
            if (open) {
              if (panel.style.height === '0px' || panel.style.height) {
                panel.style.height = panel.scrollHeight + 'px';
                setTimeout(function () { panel.style.height = ''; }, 380);
              } else panel.removeAttribute('hidden');
            } else {
              panel.style.height = panel.scrollHeight + 'px';
              void panel.offsetHeight;
              panel.style.height = '0px';
            }
          }
        });
      })(qs[j]);
    }
  }

  /* ---------- 10. motion toggle wiring (optional; engine owns state) -- */
  /* engine.js owns the actual preference (PX.motionOn / PX.setMotion) and
     broadcasts 'px:motionchange'. This section only reflects that state onto
     the button, so the two never disagree. */

  function initMotionToggle() {
    var btn = doc.getElementById('motion-toggle');
    if (!btn) return;
    function sync() {
      var on = typeof PX.motionOn === 'boolean' ? PX.motionOn : !reduced();
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.setAttribute('aria-label', on ? 'Motion on — turn animations off' : 'Motion off — turn animations on');
      btn.classList.toggle('is-on', on);
      var t = btn.querySelector('[data-motion-label]');
      /* the button is a 40px circle — anything longer than a couple of
         characters is clipped to an unreadable stub */
      if (t) t.textContent = on ? 'ON' : 'OFF';
    }
    sync();
    btn.addEventListener('click', function () {
      if (typeof PX.setMotion !== 'function') return;
      PX.setMotion(!(typeof PX.motionOn === 'boolean' ? PX.motionOn : !reduced()));
      sync();
    });
    if (typeof PX.onReady === 'function') PX.onReady(sync);
    window.addEventListener('px:motionchange', sync);
  }

  /* ---------- boot ----------------------------------------------------- */
  /* Every init* below is independent and safe to run in any order; each
     returns immediately when its hook markup is absent. */

  function boot() {
    initNavScroll();
    initMobileMenu();
    initSmoothScroll();
    initHeroParallax();
    initCounters();
    initFeatured();
    initRail();
    initRailControls();
    initMarquee();
    initFaq();
    initMotionToggle();
  }

  if (typeof PX.onReady === 'function') PX.onReady(boot);
  else onReady(boot);
})();
