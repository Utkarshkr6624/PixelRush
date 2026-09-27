/* ==========================================================================
   PIXELRUSH — js/engine.js
   Loaded first on every page (defer). Exposes window.PX.
   Owns: reduced-motion + perf-lite detection, the single rAF scroll driver
   that writes --scroll-y, the IntersectionObserver reveal engine,
   the #preloader, the custom cursor, and magnetic buttons.

   PUBLIC SURFACE — window.PX
     PX.version        string   build tag, bumped when behaviour changes
     PX.reduced        boolean  the OS asked for prefers-reduced-motion
     PX.perfLite       boolean  coarse pointer, <=4 cores or <=4GB — the
                                stylesheet's .perf-lite hook, set on <html>
     PX.motionOn       boolean  live motion state, mirrored to the
                                .motion-off class on <html>
     PX.scenes         array    reserved for the measured .scene list; the
                                live list is module-private, so this stays
                                empty today and no page reads it yet
     PX.onReady(fn)    void     run fn once the preloader clears (or on
                                DOMContentLoaded when there is no preloader);
                                calling it after that point runs fn at once
     PX.reveal(el?)    void     observe .reveal / force-reveal a subtree
     PX.setMotion(on)  void     flip and persist the motion preference; also
                                dispatches the px:motionchange window event
     PX.registerPointerTilt(sel, opts)  attach the 3D hover tilt to sel;
                                opts = { max: degrees, perspective: px }

   DOM CONTRACT — all optional, the file degrades without any of them
     #preloader (.preloader__bar span)  progress bar, drives PX.onReady
     #motion-toggle                     button, kept aria-pressed in sync
     .scene                             parallax regions tracked per-section
     .reveal / [data-animate]           elements revealed on scroll
     .btn .chip .icon-btn               elements the magnet pulls toward
     Nothing here is required: a page missing every one of these still boots.
   ========================================================================== */
(function () {
  'use strict';

  var doc = document;
  var root = doc.documentElement;
  var LS_MOTION = 'pixelrush.motion';
  var LS_SEEN = 'pixelrush.seen';

  /* ------------------------------------------- capability detection */
  /* The `|| 8` fallbacks are deliberate: hardwareConcurrency and deviceMemory
     are both undefined in Firefox and Safari. Defaulting to 8 keeps those
     browsers on the full-fat path instead of mislabelling every desktop as a
     low-spec device and stripping the parallax and blur work from them. */
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var coarse = window.matchMedia('(pointer: coarse)').matches;
  var fewCores = (navigator.hardwareConcurrency || 8) <= 4;
  var smallMem = (navigator.deviceMemory || 8) <= 4;
  var perfLite = coarse || fewCores || smallMem;

  /* A stored preference outranks the OS setting: someone who deliberately
     turned motion back on keeps it, even though the OS asks for reduction.
     The getItem is wrapped because Safari in private mode throws on access
     to localStorage rather than returning null. */
  var stored = null;
  try { stored = localStorage.getItem(LS_MOTION); } catch (e) { /* private mode */ }
  var motionOn = stored === null ? !reduced : stored === '1';

  root.classList.toggle('perf-lite', perfLite);
  root.classList.toggle('motion-off', !motionOn);

  var PX = {
    version: '1.0.0',
    reduced: reduced,
    perfLite: perfLite,
    motionOn: motionOn,
    scenes: [],
    onReady: onReady,
    reveal: reveal,
    setMotion: setMotion,
    registerPointerTilt: registerPointerTilt
  };
  window.PX = PX;

  /* ---------------------------------------------------------------- ready */
  /* Deferred boot signal. A late subscriber that registers after fireReady has
     already run is called synchronously, so callers never have to poll. */
  var readyCbs = [];
  var isReady = false;
  function onReady(fn) {
    if (typeof fn !== 'function') return;
    if (isReady) { fn(); return; }
    readyCbs.push(fn);
  }
  function fireReady() {
    if (isReady) return;
    isReady = true;
    readyCbs.splice(0).forEach(function (fn) {
      try { fn(); } catch (e) { /* one bad hook must not stop the rest */ }
    });
  }

  /* ------------------------------------------------------ scroll driver */
  /* One passive listener + one rAF. Writes --scroll-y on <html>; every
     .depth-* layer derives its own offset from that single variable. */
  var lastY = -1;
  var ticking = false;
  var reduceMotion = reduced || !motionOn;

  /* --scroll-y is cumulative, so a single document-level value drifts
     unbounded on a long page — by the footer the near layers were being
     pushed 400px+ out of view. Each .scene therefore gets its own value:
     0 when its centre sits at the centre of the viewport, negative while it
     is entering from below, positive once it has left above, clamped so the
     offset can never exceed ~24px on the content layers. */
  var scenes = null;

  function measureScenes() {
    if (!scenes) return;
    var y = window.pageYOffset || 0;
    for (var i = 0; i < scenes.length; i++) {
      var r = scenes[i].el.getBoundingClientRect();
      scenes[i].top = r.top + y;
      scenes[i].h = r.height;
    }
  }

  function collectScenes() {
    var found = doc.querySelectorAll('.scene');
    if (!found.length) return;
    scenes = [];
    for (var i = 0; i < found.length; i++) scenes.push({ el: found[i], top: 0, h: 0 });
    measureScenes();
  }

  function writeScenes(y, vh) {
    if (!scenes) return;
    for (var i = 0; i < scenes.length; i++) {
      var s = scenes[i];
      var d = (y + vh * 0.5 - (s.top + s.h * 0.5)) / vh;
      if (d > 1.2) d = 1.2; else if (d < -1.2) d = -1.2;
      s.el.style.setProperty('--scroll-y', (d * 20).toFixed(2));
    }
  }

  function writeScroll() {
    ticking = false;
    var y = window.pageYOffset || root.scrollTop || 0;
    var vh = window.innerHeight || 1;
    /* A resize that does not move the scroll position still has to run the
       sweep, so the scroll-variable writes are what get skipped, not the pass. */
    if (y === lastY) { sweep(); return; }
    lastY = y;
    /* Progress through the document, in viewport units, for anything that is
       not inside a .scene. */
    root.style.setProperty('--scroll-y', ((y / Math.max(vh, 1)) * 60).toFixed(2));
    writeScenes(y, vh);
    sweep();
  }

  function onScroll() {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(writeScroll);
  }

  if (!reduceMotion) {
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    writeScroll();
  }
  collectScenes();
  window.addEventListener('resize', function () {
    measureScenes();
    onScroll();
  }, { passive: true });
  if (doc.fonts && doc.fonts.ready && doc.fonts.ready.then) {
    /* webfonts change section heights, so the cached offsets must be redone */
    doc.fonts.ready.then(function () { measureScenes(); onScroll(); }, function () { /* ignore */ });
  }
  window.addEventListener('load', function () { measureScenes(); onScroll(); }, { once: true });

  /* ------------------------------------------------------------ reveals */
  var revealIO = null;
  function reveal(el) {
    var targets = el ? [].slice.call(el.querySelectorAll('.reveal:not(.is-in)')).concat(el.classList.contains('reveal') ? [el] : [])
                      : doc.querySelectorAll('.reveal:not(.is-in)');
    if (!('IntersectionObserver' in window)) {
      targets.forEach(function (t) { t.classList.add('is-in'); });
      return;
    }
    if (!revealIO) {
      revealIO = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-in');
          revealIO.unobserve(entry.target);
        });
      }, { rootMargin: '0px 0px -12% 0px', threshold: 0 });
    }
    targets.forEach(function (t) { revealIO.observe(t); });
  }

  /* [data-animate] elements are also revealed by the same observer. */
  var animateIO = null;
  function observeAnimate(root) {
    var nodes = (root || doc).querySelectorAll('[data-animate]');
    if (!nodes.length) return;
    if (!('IntersectionObserver' in window)) {
      Array.prototype.forEach.call(nodes, function (n) { n.classList.add('is-in'); });
      return;
    }
    if (!animateIO) {
      animateIO = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-in');
          animateIO.unobserve(entry.target);
        });
      /* threshold MUST be 0: the wipe-up / clip-reveal pre-states use
         clip-path: inset(100% ...), which collapses the intersection rect to
         a ratio of 0. Any threshold above 0 is then never crossed and the
         element is never revealed. */
      }, { rootMargin: '0px 0px -10% 0px', threshold: 0 });
    }
    Array.prototype.forEach.call(nodes, function (n) { animateIO.observe(n); });
    /* `pending` is declared further down this IIFE; `var` hoists it, so this
       assignment is safe and reads in the right order for a human. It lives
       here rather than in reveal() because the geometry sweep only backs up
       the [data-animate] observer, not the plain .reveal one. */
    pending = nodes;
  }

  /* IntersectionObserver alone is not trustworthy for this page:
       · the wipe-up / clip-reveal pre-states are clip-path: inset(100%), which
         drives the intersection ratio to 0;
       · .scene uses content-visibility: auto, and Chrome reports children of a
         skipped subtree as never intersecting.
     Both left real text permanently invisible. So a geometry sweep rides the
     existing rAF scroll driver and reveals anything whose box is on screen.
     It only ever walks the not-yet-revealed list, which shrinks to zero. */
  var pending = null;
  function sweep() {
    if (!pending || !pending.length) { pending = null; return; }
    var vh = window.innerHeight || 1;
    /* Content flush with the end of the document can never satisfy a
       "top is above 92% of the viewport" test once the user is scrolled to the
       bottom — that is how the whole FAQ block on games.html stayed at
       opacity 0 forever. Reaching the end of the page reveals the remainder. */
    var atBottom = (window.pageYOffset || 0) + vh >= (doc.documentElement.scrollHeight - 2);
    var still = [];
    for (var i = 0; i < pending.length; i++) {
      var n = pending[i];
      if (!n.isConnected) continue;
      if (n.classList.contains('is-in')) continue;
      var r = n.getBoundingClientRect();
      if ((r.top < vh || atBottom) && r.bottom > 0) {
        n.classList.add('is-in');
        if (animateIO) animateIO.unobserve(n);
      } else {
        still.push(n);
      }
    }
    pending = still.length ? still : null;
  }

  /* ------------------------------------------------------- motion toggle */
  function setMotion(on) {
    motionOn = !!on;
    PX.motionOn = motionOn;
    try { localStorage.setItem(LS_MOTION, motionOn ? '1' : '0'); } catch (e) { /* ignore */ }
    root.classList.toggle('motion-off', !motionOn);

    var btn = doc.getElementById('motion-toggle');
    if (btn) {
      btn.setAttribute('aria-pressed', motionOn ? 'true' : 'false');
      btn.setAttribute('aria-label', motionOn ? 'Motion on — turn animations off' : 'Motion off — turn animations on');
    }
    try { window.dispatchEvent(new CustomEvent('px:motionchange', { detail: { motionOn: motionOn } })); } catch (e) { /* older engines */ }

    if (motionOn) {
      /* The scroll listeners are only ever bound once. A user toggling motion
         off and on repeatedly must not stack a new listener per toggle. */
      if (!PX._scrollBound) {
        PX._scrollBound = true;
        window.addEventListener('scroll', onScroll, { passive: true });
        window.addEventListener('resize', onScroll, { passive: true });
        lastY = -1;
        writeScroll();
      }
      reveal();
      observeAnimate(doc);
    } else {
      root.style.setProperty('--scroll-y', '0');
      Array.prototype.forEach.call(doc.querySelectorAll('.reveal, [data-animate]'), function (n) {
        n.classList.add('is-in');
      });
    }
  }

  function initMotionToggle() {
    var btn = doc.getElementById('motion-toggle');
    if (!btn) return;
    btn.setAttribute('aria-pressed', motionOn ? 'true' : 'false');
    /* engine.js owns motion state (SPEC: engine owns the motion toggle).
       Any page script that also wants to reflect the state listens for the
       px:motionchange event instead of toggling again — stopping further
       click listeners here keeps a second handler from double-toggling. */
    btn.addEventListener('click', function (e) {
      e.stopImmediatePropagation();
      setMotion(!motionOn);
      btn.animate && btn.animate(
        [{ transform: 'scale(1)' }, { transform: 'scale(.85)' }, { transform: 'scale(1)' }],
        { duration: 320, easing: 'cubic-bezier(.16,1,.3,1)' }
      );
    });
  }

  /* -------------------------------------------------------- preloader */
  function initPreloader() {
    var pre = doc.getElementById('preloader');
    /* No preloader on this page: nothing to wait for, so PX.onReady
       subscribers can go now. */
    if (!pre) { fireReady(); return; }
    var bar = pre.querySelector('.preloader__bar span');
    var p = 0;
    var timer = window.setInterval(function () {
      p = Math.min(p + (p < 70 ? 9 : 4), 100);
      if (bar) bar.style.inlineSize = p + '%';
    }, 110);

    function done() {
      window.clearInterval(timer);
      if (bar) bar.style.inlineSize = '100%';
      pre.classList.add('is-done');
      try { localStorage.setItem(LS_SEEN, '1'); } catch (e) { /* ignore */ }
      window.setTimeout(function () {
        pre.setAttribute('hidden', 'hidden');
        fireReady();
      }, 750);
    }

    if (doc.readyState === 'complete') { window.setTimeout(done, 320); }
    else window.addEventListener('load', function () { window.setTimeout(done, 320); });
    /* never trap the user behind a stalled asset */
    window.setTimeout(done, 6000);
  }

  /* ----------------------------------------------------- custom cursor */
  /* The cursor's own chrome is injected here rather than living in a
     stylesheet, so it works identically on every page regardless of which
     CSS files that page links. All motion stays on transform/opacity. */
  var CURSOR_CSS =
    '.px-cursor{position:fixed;top:0;left:0;z-index:150;' +
    'width:var(--px-size,28px);height:var(--px-size,28px);' +
    'margin:calc(var(--px-size,28px) / -2) 0 0 calc(var(--px-size,28px) / -2);' +
    'border-radius:50%;border:1px solid var(--cyan,#22e7ff);pointer-events:none;opacity:0;' +
    'box-shadow:0 0 14px rgba(34,231,255,.7),inset 0 0 10px rgba(34,231,255,.35);' +
    'transform:translate3d(var(--cursor-x,0),var(--cursor-y,0),0) scale(.6);' +
    'transition:opacity .3s,transform .18s cubic-bezier(.16,1,.3,1);will-change:transform;}' +
    '.px-cursor.is-live{opacity:1;}' +
    '.px-cursor.is-hot{transform:translate3d(var(--cursor-x,0),var(--cursor-y,0),0) scale(1.9);' +
    'background:rgba(34,231,255,.12);}' +
    '@media (pointer:coarse){.px-cursor{display:none!important;}}' +
    '@media (prefers-reduced-motion:reduce){.px-cursor{display:none!important;}}' +
    /* Where the system pointer comes back, the ring gets out of the way — the
       two must never be drawn on top of each other. */
    '.px-cursor.is-native{opacity:0!important;}' +
    /* The custom ring replaces the native cursor, it does not sit on top of it.
       Text controls keep the real cursor so caret placement stays obvious. */
    'html.px-cursor-on,html.px-cursor-on *{cursor:none!important;}' +
    'html.px-cursor-on input,html.px-cursor-on textarea,html.px-cursor-on select,' +
    'html.px-cursor-on option,html.px-cursor-on [contenteditable=""],' +
    'html.px-cursor-on [contenteditable="true"]{cursor:auto!important;}';

  function initCursor() {
    if (coarse || reduced) return;
    /* readPrefs runs here as well as in initSettings: the follow factor reads
       prefs.speed on the very first pointermove, and this function boots first. */
    readPrefs();
    applyCursorPref();
    if (!doc.getElementById('px-cursor-style')) {
      var st = doc.createElement('style');
      st.id = 'px-cursor-style';
      st.textContent = CURSOR_CSS;
      doc.head.appendChild(st);
    }
    var dot = doc.createElement('div');
    dot.className = 'px-cursor';
    dot.setAttribute('aria-hidden', 'true');
    dot.id = 'px-cursor';
    doc.body.appendChild(dot);

    var x = 0, y = 0, live = false, queued = false, seen = false;
    var mx = window.innerWidth / 2, my = window.innerHeight / 2;

    /* prefs.speed is the "Pointer speed" (DPI) slider: it scales how much of the
       distance between the ring and the real pointer is closed each frame, so a
       higher value visibly tightens the tracking. The product is clamped to 1 so
       the ring can never overshoot past the pointer and oscillate. */
    function followFactor() {
      var sp = (typeof prefs.speed === 'number' && isFinite(prefs.speed)) ? prefs.speed : 1;
      if (sp < 0.4) sp = 0.4; else if (sp > 2.5) sp = 2.5;
      /* Remapped onto a wide, clearly visible band: 0.4 lags noticeably behind
         the real pointer, 1.0 is the default feel, 2.5 is almost glued to it.
         A narrow multiplier (0.22 x speed) made the three settings feel
         identical, which is why the control looked broken. */
      var f = 0.05 + ((sp - 0.4) / 2.1) * 0.90;
      return f < 0.05 ? 0.05 : (f > 0.95 ? 0.95 : f);
    }

    /* Fullscreen puts its element in the browser's top layer, which does not
       paint anything outside it. A cursor ring parented to <body> therefore
       vanishes the moment a game goes fullscreen — and so does the native
       cursor we hid, leaving no pointer at all. Re-parent the ring into the
       fullscreen element and back again on exit. */
    function reparent() {
      var fs = doc.fullscreenElement || doc.webkitFullscreenElement || doc.msFullscreenElement || null;
      var host = fs || doc.body;
      if (dot.parentNode !== host) host.appendChild(dot);
      // entering or leaving fullscreen fires a pointerleave, which blanks the
      // ring; restore it as soon as we know the pointer has been seen at all.
      if (seen) dot.classList.add('is-live');
      x = mx; y = my;
      dot.style.setProperty('--cursor-x', x.toFixed(1) + 'px');
      dot.style.setProperty('--cursor-y', y.toFixed(1) + 'px');
    }
    doc.addEventListener('fullscreenchange', reparent);
    doc.addEventListener('webkitfullscreenchange', reparent);

    window.addEventListener('pointermove', function (e) {
      if (e.pointerType !== 'mouse') return;
      mx = e.clientX; my = e.clientY;
      if (!live) { live = true; seen = true; dot.classList.add('is-live'); }
      if (queued) return;
      queued = true;
      window.requestAnimationFrame(function () {
        queued = false;
        var f = followFactor();
        x += (mx - x) * f;
        y += (my - y) * f;
        dot.style.setProperty('--cursor-x', x.toFixed(1) + 'px');
        dot.style.setProperty('--cursor-y', y.toFixed(1) + 'px');
      });
    }, { passive: true });

    doc.addEventListener('pointerover', function (e) {
      var t = e.target;
      var hot = t && t.closest && t.closest('a, button, .gcard, .chip, summary, [role="button"]');
      dot.classList.toggle('is-hot', !!hot);
      /* Anything interactive or text-bearing gets the real system pointer back
         (css/base.css), so the ring must vanish there rather than sit on top of
         it. Native-only, so it costs nothing on coarse pointers. */
      var native = t && t.closest && t.closest(NATIVE_CURSOR_SEL);
      dot.classList.toggle('is-native', !!native && prefs.cursor !== 'off');
    }, { passive: true });

    doc.addEventListener('pointerleave', function () { live = false; dot.classList.remove('is-live'); });
  }


  /* ============================================================ settings
     The neon ring hides the native cursor, so it has to be possible to get
     the real pointer back, resize the ring, and switch animation off from the
     UI rather than only from the OS. Preferences live in one localStorage key
     and are applied as data attributes on <html> so the CSS does the work. */
  var LS_SET = 'pixelrush.settings';
  var SIZES = { s: 'S', m: 'MED', l: 'L', xl: 'XL' };
  var prefs = { cursor: 'on', size: 'm', speed: 1, motion: null };  /* motion null = follow OS/motion-toggle */

  /* Pointer speed (DPI) — a plain multiplier on the ring's follow factor. */
  var DPI_MIN = 0.4, DPI_MAX = 2.5, DPI_STEP = 0.1;
  function clampDpi(v) {
    var n = parseFloat(v);
    if (!isFinite(n)) return 1;
    if (n < DPI_MIN) n = DPI_MIN;
    else if (n > DPI_MAX) n = DPI_MAX;
    return Math.round(n * 10) / 10;   /* keep it on the slider's 0.1 grid */
  }

  /* Selector mirrored by the cursor:pointer / cursor:auto block in css/base.css.
     Kept as one string so the ring hides over exactly what the stylesheet
     restores the system pointer for. */
  var NATIVE_CURSOR_SEL =
    'a, button, select, input, textarea, summary, label, [contenteditable=""], [contenteditable="true"],' +
    '[role="button"], [role="link"], [role="switch"], [role="tab"], [role="menuitem"],' +
    '[role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="slider"],' +
    '[role="checkbox"], [role="radio"], [role="combobox"], [role="listbox"], [role="textbox"],' +
    '[role="searchbox"], [role="spinbutton"], [role="treeitem"]';

  function readPrefs() {
    try {
      var raw = localStorage.getItem(LS_SET);
      if (raw) {
        var p = JSON.parse(raw);
        if (p && typeof p === 'object') {
          if (p.cursor === 'off' || p.cursor === 'on') prefs.cursor = p.cursor;
          if (SIZES[p.size]) prefs.size = p.size;
          if (typeof p.speed === 'number' || typeof p.speed === 'string') prefs.speed = clampDpi(p.speed);
          if (typeof p.motion === 'boolean') prefs.motion = p.motion;
        }
      }
    } catch (e) { /* private mode / disabled storage: defaults are fine */ }
  }
  function writePrefs() {
    try { localStorage.setItem(LS_SET, JSON.stringify(prefs)); } catch (e) { /* ignore */ }
  }
  /* The native cursor must come back exactly when the ring goes away. */
  function applyCursorPref() {
    var on = prefs.cursor !== 'off';
    root.classList.toggle('px-cursor-on', on);
    root.setAttribute('data-px-cursor', on ? 'on' : 'off');
    root.setAttribute('data-px-size', prefs.size);
    var sw = doc.getElementById('px-cursor-switch');
    if (sw) sw.setAttribute('aria-checked', on ? 'true' : 'false');
    var val = doc.getElementById('px-size-val');
    if (val) val.textContent = SIZES[prefs.size] || SIZES.m;
    var seg = doc.getElementById('px-size-seg');
    if (seg) {
      var btns = seg.querySelectorAll('button[data-px-size]');
      for (var i = 0; i < btns.length; i++) {
        btns[i].setAttribute('aria-checked', btns[i].getAttribute('data-px-size') === prefs.size ? 'true' : 'false');
      }
    }
    root.style.setProperty('--px-dpi', String(prefs.speed));
    root.setAttribute('data-px-speed', prefs.speed.toFixed(1));
    var range = doc.getElementById('px-dpi');
    if (range && range.value !== String(prefs.speed)) range.value = String(prefs.speed);
    var dval = doc.getElementById('px-dpi-val');
    if (dval) dval.textContent = prefs.speed.toFixed(1) + '×';
  }

  /* The Pointer speed control is injected rather than hand-authored into six
     navs, so the dialog markup in the HTML pages stays exactly as it is. */
  function injectDpiControl(panel) {
    if (doc.getElementById('px-dpi-row')) return;
    var row = doc.createElement('div');
    row.className = 'nav__row';
    row.id = 'px-dpi-row';
    row.innerHTML =
      '<div class="nav__row-top"><span>Pointer speed</span>' +
      '<span class="nav__row-val" id="px-dpi-val">1.0&times;</span></div>' +
      '<input class="nav__range" id="px-dpi" type="range" min="' + DPI_MIN + '" max="' + DPI_MAX +
      '" step="' + DPI_STEP + '" value="' + prefs.speed +
      '" aria-label="Pointer speed, ring tracking multiplier">' +
      '<p class="nav__hint">Higher values make the ring track the mouse faster.</p>';
    /* before the Animations switch, so the dialog reads top-down: cursor,
       size, tracking, motion */
    var ms = doc.getElementById('px-motion-switch');
    if (ms && ms.parentNode === panel) panel.insertBefore(row, ms);
    else panel.appendChild(row);
  }
  function setCursorPref(on) {
    prefs.cursor = on ? 'on' : 'off';
    writePrefs(); applyCursorPref();
    var dot = doc.getElementById('px-cursor');
    if (dot) { if (on) dot.classList.add('is-live'); else dot.classList.remove('is-live'); }
    window.dispatchEvent(new CustomEvent('px:settings', { detail: prefs }));
  }

  function initSettings() {
    readPrefs();
    if (prefs.motion === false) motionOn = false;
    applyCursorPref();
    var btn = doc.getElementById('nav-settings');
    var panel = doc.getElementById('nav-settings-panel');
    if (!btn || !panel) return;
    injectDpiControl(panel);
    applyCursorPref();
    var lastFocus = null;
    function setOpen(open) {
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      panel.classList.toggle('is-open', open);
      if (open) panel.setAttribute('aria-modal', 'true'); else panel.removeAttribute('aria-modal');
      if (open) {
        lastFocus = doc.activeElement;
        /* the panel animates in via a visibility transition; focus() called in
           the same tick lands on an element the browser still treats as hidden */
        /* double rAF: the first frame commits the class, the second runs after
           the browser has recalculated visibility, so focus() is not ignored */
        function focusFirst() {
          if (btn.getAttribute('aria-expanded') !== 'true') return;
          var f = panel.querySelector('button, [href], input, select');
          if (f) f.focus();
        }
        window.requestAnimationFrame(function () { window.requestAnimationFrame(focusFirst); });
        window.setTimeout(focusFirst, 80);   /* belt and braces: the panel's
           visibility transition can swallow every frame-based attempt */
      }
      else if (lastFocus && lastFocus.focus) lastFocus.focus();
    }
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      setOpen(btn.getAttribute('aria-expanded') !== 'true');
    });
    doc.addEventListener('click', function (e) {
      if (btn.getAttribute('aria-expanded') !== 'true') return;
      if (panel.contains(e.target) || btn.contains(e.target)) return;
      setOpen(false);
    });
    doc.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && btn.getAttribute('aria-expanded') === 'true') { setOpen(false); btn.focus(); return; }
      /* Keep Tab inside the dialog while it is open — without this, Tab walks
         straight out into the page and the panel looks dismissed but is not. */
      if (e.key !== 'Tab' || btn.getAttribute('aria-expanded') !== 'true') return;
      var stops = panel.querySelectorAll('button, [href], input, select, [tabindex]:not([tabindex="-1"])');
      if (!stops.length) return;
      var list = Array.prototype.slice.call(stops).filter(function (n) { return n.offsetParent !== null || n === document.activeElement; });
      if (!list.length) return;
      var first = list[0], last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      else if (!panel.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    });
    var sw = doc.getElementById('px-cursor-switch');
    if (sw) sw.addEventListener('click', function () { setCursorPref(sw.getAttribute('aria-checked') !== 'true'); });
    var seg = doc.getElementById('px-size-seg');
    if (seg) seg.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('button[data-px-size]') : null;
      if (!b || !seg.contains(b)) return;
      prefs.size = b.getAttribute('data-px-size') || 'm';
      writePrefs(); applyCursorPref();
      window.dispatchEvent(new CustomEvent('px:settings', { detail: prefs }));
    });
    var dpi = doc.getElementById('px-dpi');
    if (dpi) {
      dpi.addEventListener('input', function () {
        prefs.speed = clampDpi(dpi.value);
        writePrefs(); applyCursorPref();
        window.dispatchEvent(new CustomEvent('px:settings', { detail: prefs }));
      });
    }
    var ms = doc.getElementById('px-motion-switch');
    if (ms) {
      ms.addEventListener('click', function () {
        var on = ms.getAttribute('aria-checked') !== 'true';
        prefs.motion = on; writePrefs();
        if (typeof setMotion === 'function') setMotion(on);
        window.dispatchEvent(new CustomEvent('px:settings', { detail: prefs }));
      });
    }
    /* the existing motion button and the panel switch must never disagree */
    window.addEventListener('px:motionchange', function (e) {
      if (ms) ms.setAttribute('aria-checked', e.detail && e.detail.motionOn ? 'true' : 'false');
    });
  }

  /* ======================================================= nav active link
     Two cases, both previously wrong:
       · on a sub-page the underline must sit on that page's own link;
       · on the home page the links are section anchors, so the underline has
         to follow the section currently under the viewport instead of staying
         stuck on the first link. */
  function initNavActive() {
    var links = doc.querySelectorAll('.nav__menu .nav__link');
    if (!links.length) return;
    var path = (location.pathname.split('/').pop() || 'index.html');
    links.forEach(function (a) {
      var href = (a.getAttribute('href') || '').split('#')[0];
      if (href && href === path) a.setAttribute('aria-current', 'page');
    });
    var anchorLinks = [];
    links.forEach(function (a) {
      var full = a.getAttribute('href') || '';
      var i = full.indexOf('#');
      if (i === -1) return;                                  // not a section link
      var base = full.slice(0, i);
      if (base === '' || base === path) anchorLinks.push({ a: a, id: full.slice(i + 1) });
    });
    if (!anchorLinks.length) return;
    var targets = anchorLinks.map(function (l) { return { link: l.a, el: doc.getElementById(l.id) }; })
      .filter(function (t) { return t.el; });
    if (!targets.length) return;
    function update() {
      var best = null;
      targets.forEach(function (t) {
        var r = t.el.getBoundingClientRect();
        if (r.top <= window.innerHeight * 0.4) best = t;
      });
      targets.forEach(function (t) { t.link.classList.toggle('is-active', t === best); });
    }
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(update, { rootMargin: '-40% 0px -55% 0px', threshold: 0 });
      targets.forEach(function (t) { io.observe(t.el); });
    }
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('load', update);
    update();
  }

  /* ------------------------------------------------- magnetic buttons */
  /* One document-level pointermove with a hit test, rather than a listener per
     button: a page can carry a hundred .chip elements, and adding that many
     handlers to fire on every mouse move is the kind of cost that shows up as
     jank. The topmost four hits are enough because anything deeper is covered
     by an element we already tested. */
  var MAGNET = '.btn, .chip, .icon-btn';
  function initMagnetic() {
    if (coarse || reduced || !motionOn) return;
    window.addEventListener('pointermove', function (e) {
      if (e.pointerType !== 'mouse') return;
      var els = doc.elementsFromPoint ? doc.elementsFromPoint(e.clientX, e.clientY) : [];
      for (var i = 0; i < els.length && i < 4; i++) {
        var el = els[i] && els[i].closest ? els[i].closest(MAGNET) : null;
        if (el) { pull(el, e.clientX, e.clientY); return; }
      }
    }, { passive: true });
  }
  function pull(el, cx, cy) {
    var r = el.getBoundingClientRect();
    var mx = r.left + r.width / 2, my = r.top + r.height / 2;
    var dx = (cx - mx), dy = (cy - my);
    var d = Math.sqrt(dx * dx + dy * dy);
    var reach = Math.max(r.width, r.height) * 0.8;
    /* The independent `translate` property is used so the pull composes with
       whatever `transform` the element's own hover state already applies. */
    if (d > reach) { el.style.translate = ''; return; }
    el.style.translate = (dx * 0.18).toFixed(2) + 'px ' + (dy * 0.18).toFixed(2) + 'px';
    if (!el._magBound) {
      el._magBound = true;
      el.addEventListener('pointerleave', function () { el.style.translate = ''; });
    }
  }

  /* --------------------------------------------- pointer tilt (3D cards) */
  /* Opt-in per page, so a card that should stay flat simply is not passed to
     PX.registerPointerTilt. el._tiltBound guards against a page registering
     the same node twice, which would apply the rotation twice over. When
     motion is off or the pointer is coarse, nothing is bound at all rather
     than bound and disabled. */
  var tiltEls = [];
  function registerPointerTilt(sel, opts) {
    opts = opts || {};
    var els = typeof sel === 'string' ? doc.querySelectorAll(sel) : sel;
    if (!els || !els.length) return;
    var max = opts.max == null ? 8 : opts.max;
    var perspective = opts.perspective == null ? 900 : opts.perspective;
    var enabled = !coarse && !reduced && motionOn;
    Array.prototype.forEach.call(els, function (el) {
      if (el._tiltBound || !enabled) return;
      el._tiltBound = true;
      el.style.transformStyle = 'preserve-3d';
      el.addEventListener('pointermove', function (e) {
        var r = el.getBoundingClientRect();
        var px = (e.clientX - r.left) / r.width - .5;
        var py = (e.clientY - r.top) / r.height - .5;
        el.style.transform =
          'perspective(' + perspective + 'px) rotateX(' + (-py * max).toFixed(2) + 'deg) rotateY(' +
          (px * max).toFixed(2) + 'deg) translateY(-8px) scale(1.02)';
      }, { passive: true });
      el.addEventListener('pointerleave', function () { el.style.transform = ''; });
    });
    tiltEls.push(els);
  }

  /* -------------------------------------------------------- boot */
  /* Ordered deliberately: the motion toggle must be live before anything can
     switch motion off, and the preloader is started early so it can record
     the load timestamp the rest of the boot measures against. */
  function boot() {
    initMotionToggle();
    initPreloader();
    initCursor();
    initSettings();
    initNavActive();
    initMagnetic();
    reveal();
    observeAnimate(doc);
    PX.reveal = reveal;
    /* The sweep only runs on scroll; pages that fit without scrolling (or
       layouts that settle late) still need one pass. */
    sweep();
    window.addEventListener('load', sweep, { once: true });
    if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
      document.fonts.ready.then(function () { sweep(); window.setTimeout(sweep, 120); }, function () { /* ignore */ });
    }
    window.setTimeout(sweep, 900);
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* Fire PX.onReady on DOM ready even when there is no preloader. */
  doc.addEventListener('DOMContentLoaded', function () {
    if (!doc.getElementById('preloader')) window.setTimeout(fireReady, 0);
  });
})();
