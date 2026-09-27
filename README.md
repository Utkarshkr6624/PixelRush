# PixelRush

A free browser arcade. Static site — vanilla HTML, CSS and JavaScript. No build step,
no frameworks, no backend, no external assets beyond two Google Fonts.

**Live base URL:** `https://pixelrush.example/`

---

## Run it locally

The site is pure static files, so anything that serves a directory works. A local
file:// open will *mostly* work, but `games/<slug>.js` is loaded by script injection
and some browsers block that from `file://` — use a real server.

**Python (already installed on most machines):**

```bash
cd /path/to/pixel-PixelRush
python -m http.server 8000
# -> http://localhost:8000
```

**Node:**

```bash
npx serve .
# -> http://localhost:3000
```

**PHP:**

```bash
php -S localhost:8000
```

Then open <http://localhost:8000>.

Check these three URLs after starting:
`/index.html`, `/games.html`, `/play.html?game=reaction`.

> Note: `python -m http.server` will not render `404.html` for unknown paths on its
> own — it serves its own error page. That is a dev-server detail only; on a real host
> (GitHub Pages, Netlify, Cloudflare Pages) `404.html` at the root is served
> automatically for unmatched routes.

---

## Folder structure

Deploy-ready root = the repository root. Nothing lives outside it.

```
.
├── index.html              # cinematic home (hero, ticker, rail, genres, stats, how, cta)
├── games.html              # full catalog with search / genre filter / sort
├── play.html               # game player shell, reads ?game=slug
├── about.html              # who is behind it, philosophy, tech, roadmap
├── contact.html            # the one inbox, suggest / report / say hello
├── privacy.html            # what we collect (nothing) and why
├── terms.html              # plain-English terms of use
├── 404.html                # on-brand not-found page
├── robots.txt              # allow all, disallow the thin player shell, point at the sitemap
├── sitemap.xml             # the seven indexable pages
├── manifest.webmanifest    # PWA manifest, inline-SVG data-URI icon
├── README.md
├── css/
│   ├── base.css            # design tokens, reset, type, buttons, nav, footer, a11y
│   ├── scenes.css          # depth-0…depth-5 system, every home section, all keyframes
│   └── games.css           # catalog, cards, filters, player shell, marquee, 404
├── js/
│   ├── engine.js           # scroll driver, reveal observer, perf-lite, cursor, preloader
│   ├── site.js             # index behaviour: nav state, mobile menu, tilt, counters
│   ├── catalog.js          # games.html: render, search, filter, sort, tilt
│   ├── player.js           # play.html: load game module, HUD, fullscreen, highscore
│   └── games-data.js       # window.GAMES = [ …24 entries ]
└── games/
    ├── reaction.js         # Neon Reaction — reference game, proves the window.PixelGame contract
    ├── snake.js            # Neon Snake
    ├── blockfall.js        # Blockfall
    └── neon-paddle.js      # Neon Paddle
```

**Playable right now:** Neon Reaction, Neon Snake, Blockfall, Neon Paddle.
The other 20 catalog entries ship as `status: 'coming-soon'` — they render a
locked "SOON" card and a "under construction" panel, so the catalog can be
laid out and reviewed before each game is actually written. Flip a game's
`status` to `'live'` in `js/games-data.js` once its file exists in `games/`.

**Script order on every page** — `engine.js` first, because the other files rely on
`window.PX` existing:

```html
<script src="js/engine.js" defer></script>
<script src="js/games-data.js" defer></script>
<script src="js/site.js" defer></script>
```

`games.html` also loads `js/catalog.js`; `play.html` also loads `js/player.js`.

---

## Add a new JavaScript game (end to end)

Four steps. Roughly 10 minutes.

### 1. Write the game file

Create `games/<slug>.js`. It must be fully self-contained — no imports, no build, no
dependencies — and expose a single global:

```js
window.PixelGame = {
  name: 'Neon Reaction',
  instructions: 'Wait for the panel to turn green, then tap. Too early = restart.',

  start(root, api) {
    // root : the DOM node inside #game-stage — build your canvas/DOM here
    // api   : { setScore(n), setBest(n), gameOver(score) }
    root.innerHTML = '<canvas id="c" width="640" height="360"></canvas>';

    let raf = 0, score = 0;
    const onKey = (e) => { if (e.code === 'Space') hit(); };
    const onHit = () => hit();

    function hit() { score++; api.setScore(score); }
    function loop(t) { raf = requestAnimationFrame(loop); /* draw at t */ }
    raf = requestAnimationFrame(loop);
    root.addEventListener('pointerdown', onHit);
    window.addEventListener('keydown', onKey);

    return {
      destroy() {
        cancelAnimationFrame(raf);              // ALWAYS kill the rAF
        root.removeEventListener('pointerdown', onHit);
        window.removeEventListener('keydown', onKey);
        api.gameOver(score);                    // optional, only on real game over
      }
    };
  }
};
```

Rules the player shell depends on:

- Assign `window.PixelGame` synchronously at top level — the shell calls `start()`
  the moment the script's `load` event fires, so a deferred assignment is too late.
- `start(root, api)` returns an object with a `destroy()` method. The shell calls
  `destroy()` on restart, on game change and on `pagehide`. **Every rAF id, timer,
  interval, listener and observer you create must be torn down there** or the next
  game will run at half speed.
- `api.setScore(n)` / `api.setBest(n)` write to the side HUD.
  `api.gameOver(score)` ends the run; the shell saves the high score to
  `localStorage` under `pixelrush.best.<slug>`.
- Drive input from `pointerdown`/`keydown` on `window` or `root`, not `click` —
  mobile taps must register without the 300ms focus delay.
- Size the canvas to `root.clientWidth` and keep a fixed 16:9 aspect; the stage is
  letterboxed.

### 2. Add the catalog entry

Append one object to the `window.GAMES` array in `js/games-data.js`:

```js
{
  slug: 'neon-snake',                  // matches games/neon-snake.js
  title: 'Neon Snake',
  genre: 'Arcade',                     // Arcade|Puzzle|Racing|Strategy|Casual|Sports
  tags: ['reflex', 'classic'],
  difficulty: 'Easy',                   // Easy|Medium|Hard
  players: '1 Player',
  duration: '2 min',
  rating: 4.6,                         // 0–5
  plays: 0,                            // integer, rendered as "1.2k"
  blurb: 'One tap. One reaction. One absurdly high score.',
  glyph: '<svg viewBox="0 0 64 64" …></svg>',   // raw SVG string, 64x64, currentColor, max 2 shapes
  color: 'cyan',                       // cyan|magenta|acid|orange|violet -> maps to CSS var --g
  engine: 'js',                        // 'js' now, 'py' for the future Pygame games
  file: 'neon-snake.js',
  status: 'live'                       // 'coming-soon' renders a disabled SOON card
}
```

The `glyph` is a **raw SVG string** inserted with `innerHTML` — do not escape it.
`title` and `blurb` are inserted with `textContent` and must be plain text.

### 3. Add it to the home rail

The home page's featured rail renders 6 `.gcard` elements from `GAMES` in
`js/site.js`. If the new game should be featured, add or move its slug in the
featured list there; otherwise it appears automatically on `games.html`.

### 4. Verify

```bash
python -m http.server 8000
```

- `http://localhost:8000/play.html?game=neon-snake` loads your game and the HUD
  updates on score.
- Reload, hit **Restart** — exactly one rAF loop is running (no double-speed drift).
- Navigate to another game and back — no leaked loops, no duplicate listeners.
- Toggle **motion** off in the nav and reload; the game must still be playable.
- Check the console: zero errors, zero 404s.

That's it. Nothing needs a build, a bundler, or a deploy hook — the file on disk
is the deployed site.

---

## Python / Pygame games

The catalog schema already reserves a slot for them: `engine: 'py'`.

Pygame needs a real Python process and a display server, which a static host cannot
provide, so the planned shape is: a small local runner that serves the same
`games-data.js` catalog, plus a `<canvas>` bridge (SSE or WebSocket) between Python
and the page. Games written this way keep the exact same entry shape —
`{ engine: 'py', file: 'snake.py', … }` — so `play.html` renders the existing
"Runs with Python — coming soon" panel instead of the stage, and switching them on
later is a change to the `engine` flag and the runner, not to the catalog or the
card markup.

`games/reaction.js` is deliberately a pure-JS reference implementation of the
`window.PixelGame` contract, so use it as the template.

---

## Conventions worth knowing before you edit

- **Design tokens** live in `css/base.css` (`--cyan`, `--magenta`, `--acid`,
  `--bg`, `--ease-out`, `--maxw`, …). Never hard-code a colour or a radius.
- **Easing:** `var(--ease-out)` = `cubic-bezier(.16,1,.3,1)` for entrances.
- **Depth:** every `.scene` holds `.layer.depth-0` … `.layer.depth-5`. The parallax
  is driven by the `--scroll-y` custom property that `js/engine.js` writes in a
  single rAF loop — never attach a per-element scroll listener.
- **Animate only** `transform`, `opacity`, `filter`, `clip-path`. Animating
  `width`/`height`/`top`/`left`/`margin`/`font-size` causes layout thrash.
- **Accessibility:** one `<h1>` per page, no skipped heading levels,
  `aria-hidden="true"` on every decorative layer, `:focus-visible` outlines, and a
  full `prefers-reduced-motion` block. The motion toggle persists to
  `localStorage.pixelrush.motion`.
- **No image assets.** All visuals are CSS gradients or inline SVG — that is what
  keeps the whole site under ~120 KB of CSS + JS.

## License / credit

Site code is yours to reuse. Game logic and artwork are original and are released
with the site.
