/* ============================================================================
   PIXELRUSH — js/games-data.js
   The single source of truth for what games exist. Everything else is a
   consumer of this file: nothing here reads the DOM, and nothing here
   renders. It is a plain data file plus a few read-only lookup helpers.

   PUBLIC SURFACE (the only two things it adds to the page)
     window.GAMES    -> Array<Entry>, 24 entries, in a deliberate order.
     window.PX_DATA  -> { colors, genres, bySlug, live, featured, others }
                         small read-only helpers over the same array.

   EXPECTS FROM THE DOM: nothing. Safe to load first on any page.
   LOADS BEFORE:         js/catalog.js, js/player.js, js/site.js, js/engine.js
                         (all of them read window.GAMES / window.PX_DATA at
                         their own run time, so load order only has to be
                         "this file before those").

   HOW A NEW GAME GETS ADDED (all four, or the site breaks)
     1. an entry here, appended to the G array;
     2. a matching games/<file> module implementing the game contract;
     3. a matching qa/<file>.report.md;
     4. the same count updated in the site copy ("Twenty-four ... games").
     The first entry (reaction) is ALSO the featured slot-1 game, and is
     duplicated in the hero markup on index.html — changing it changes both.

   ---------------------------------------------------------------------------
   ENTRY SCHEMA — fixed by SPEC.md > "Game data shape (js/games-data.js)"
   ---------------------------------------------------------------------------
     slug       string   URL key. Must match the ?game= value on play.html and
                        the file name stem in games/ (reaction <-> reaction.js).
     title      string   Display name. Plain text, inserted with textContent.
     genre      string   One of PX_DATA.genres, below. Drives the data-genre
                        filter and the genre chips on games.html.
     tags       string[] Free-form descriptors: "reflex", "one tap", ...
                        Search terms only. No card renders them.
     difficulty string   'Easy' | 'Medium' | 'Hard' — editorial, for humans.
     players    string   '1 Player' | '1-2 Players' — display only.
     duration   string   Typical session length, e.g. '5 min'. Display only.
     rating     number   0-5, one decimal. The site's only rating signal.
     plays      number   Lifetime play count. Drives the "popular" sort and
                        the most-played list; 0 means "not counted yet".
     blurb      string   One-line pitch. Plain text, textContent — never
                        markup. This is also the game description published in
                        the VideoGame JSON-LD, so it must read as a real
                        description rather than a slogan fragment.
     glyph      string   Raw inline SVG markup, viewBox 0 0 64 64, stroked and
                        filled with currentColor, 1-3 shapes. The ONLY field
                        inserted with innerHTML (catalog.js:108,
                        site.js:435, player.js:494), so it is the only field
                        that must contain trusted markup. Keep it hand-written
                        and free of ids/classes that could collide.
     color      string   Accent key: 'cyan' | 'magenta' | 'acid' | 'orange' |
                        'violet'. Mapped to a CSS custom property by the
                        consumer, never to a raw colour value.
     engine     string   'js' — the loader in player.js:605 refuses to start
                        anything else, so a non-'js' game renders as a card
                        that cannot launch. Only 'py' is allowed, and no
                        entry uses it yet.
     file       string   Module file name inside games/, resolved by player.js.
     status     string   'live' | 'coming-soon' — see below.
   ---------------------------------------------------------------------------
   THE status FIELD
   ---------------------------------------------------------------------------
     'live'        The game is playable. Gets a real link to
                   play.html?game=<slug>, is counted in PX_DATA.live() and
                   PX_DATA.others(), and is eligible for the popular and
                   featured lists.
     'coming-soon' Not yet playable. Renders with a "SOON" badge and a
                   disabled card with no link (catalog.js:86-89, which also
                   stamps data-status="coming-soon" on the card), and is
                   excluded from live(), others() and every listing.
     The test is `status !== 'coming-soon'` in some places (site.js:417) and
     `status === 'live'` in others, so ONLY those two literals are safe.
     Every current entry is 'live'; two of them (rhythm-pulse, rogue-shift)
     also have plays: 0, which means unrated-by-volume, NOT unplayable.
   ---------------------------------------------------------------------------
   THE ORDER OF THE ARRAY IS MEANINGFUL
   ---------------------------------------------------------------------------
     Index 0        the featured slot-1 game (reaction).
     Index 0..n     PX_DATA.featured(n) slices from the front, so the order
                    here is the order the home-page rail shows.
     By genre       games.html sorts and filters client-side, so reordering
                    does not change those views — but it does change the
                    home page. Append new games; do not reshuffle.
   ========================================================================== */
(function () {
  'use strict';

  /* ==========================================================================
     THE CATALOG
     window.GAMES is this array, by reference. Nothing downstream mutates it.
     ====================================================================== */
  var G = [
    /* Featured slot-1. Also duplicated in the hero on index.html and is the
       game the home page names first — change it in both places. */
    {
      slug: 'reaction',
      title: 'Neon Reaction',
      genre: 'Arcade',
      tags: ['reflex', 'time attack'],
      difficulty: 'Easy',
      players: '1 Player',
      duration: '1 min',
      rating: 4.7,
      plays: 18420,
      blurb: 'One tap. One reaction. One absurdly high score.',
      glyph: '<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="18" fill="none" stroke="currentColor" stroke-width="4"/><circle cx="32" cy="32" r="5" fill="currentColor"/><path d="M32 6v8M32 50v8M6 32h8M50 32h8" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>',
      color: 'cyan',
      engine: 'js',
      file: 'reaction.js',
      status: 'live'
    },
    {
      slug: 'snake',
      title: 'Neon Snake',
      genre: 'Arcade',
      tags: ['classic', 'endless', 'high score'],
      difficulty: 'Easy',
      players: '1 Player',
      duration: '3 min',
      rating: 4.8,
      plays: 26140,
      blurb: 'Grow a light-streak through the grid. Wall yourself and it is over.',
      glyph: '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M12 46V22a6 6 0 016-6h22a6 6 0 016 6v8H30a6 6 0 00-6 6v10" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="48" cy="46" r="5" fill="currentColor"/></svg>',
      color: 'acid',
      engine: 'js',
      file: 'snake.js',
      status: 'live'
    },
    {
      slug: 'neon-paddle',
      title: 'Neon Paddle',
      genre: 'Arcade',
      tags: ['pong', 'versus', 'reflex'],
      difficulty: 'Medium',
      players: '1-2 Players',
      duration: '2 min',
      rating: 4.6,
      plays: 15770,
      blurb: 'Volley against a wall or a friend. First to eleven takes the grid.',
      glyph: '<svg viewBox="0 0 64 64" aria-hidden="true"><rect x="8" y="27" width="6" height="10" rx="3" fill="currentColor"/><rect x="50" y="27" width="6" height="10" rx="3" fill="currentColor"/><path d="M24 20a16 16 0 000 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>',
      color: 'magenta',
      engine: 'js',
      file: 'neon-paddle.js',
      status: 'live'
    },
    {
      slug: 'turbo-drift',
      title: 'Turbo Drift',
      genre: 'Racing',
      tags: ['drift', 'speed', 'keyboard'],
      difficulty: 'Medium',
      players: '1 Player',
      duration: '4 min',
      rating: 4.5,
      plays: 13980,
      blurb: 'Hold the slide, stack the score, survive the neon highway.',
      glyph: '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M10 40h44l-4-10-6-6H24l-8 8z" fill="currentColor" opacity=".9"/><path d="M12 46l14 4M52 46l-14 4" stroke="currentColor" stroke-width="4" stroke-linecap="round" fill="none"/></svg>',
      color: 'orange',
      engine: 'js',
      file: 'turbo-drift.js',
      status: 'live'
    },
    {
      slug: 'blockfall',
      title: 'Blockfall',
      genre: 'Puzzle',
      tags: ['blocks', 'lines', 'classic'],
      difficulty: 'Medium',
      players: '1 Player',
      duration: '5 min',
      rating: 4.6,
      plays: 21330,
      blurb: 'Stack falling neon blocks and clear four lines before the grid fills.',
      glyph: '<svg viewBox="0 0 64 64" aria-hidden="true"><rect x="10" y="10" width="20" height="20" rx="3" fill="currentColor"/><rect x="34" y="10" width="20" height="20" rx="3" fill="currentColor" opacity=".45"/><rect x="10" y="34" width="44" height="20" rx="3" fill="none" stroke="currentColor" stroke-width="4"/></svg>',
      color: 'violet',
      engine: 'js',
      file: 'blockfall.js',
      status: 'live'
    },
    {
      slug: 'minefield',
      title: 'Minefield',
      genre: 'Strategy',
      tags: ['mines', 'deduction', 'flags'],
      difficulty: 'Hard',
      players: '1 Player',
      duration: '6 min',
      rating: 4.4,
      plays: 11260,
      blurb: 'Clear the grid with logic, not luck. One wrong flag ends the run.',
      glyph: '<svg viewBox="0 0 64 64" aria-hidden="true"><rect x="10" y="10" width="44" height="44" rx="4" fill="none" stroke="currentColor" stroke-width="4"/><path d="M32 10v44M10 32h44" stroke="currentColor" stroke-width="3" opacity=".6"/><circle cx="44" cy="20" r="6" fill="currentColor"/></svg>',
      color: 'cyan',
      engine: 'js',
      file: 'minefield.js',
      status: 'live'
    },
    {
      slug: 'hexmerge',
      title: 'Hex Merge',
      genre: 'Puzzle',
      tags: ['merge', 'strategy', 'numbers'],
      difficulty: 'Easy',
      players: '1 Player',
      duration: '4 min',
      rating: 4.3,
      plays: 9040,
      blurb: 'Drop hexes onto the board and merge equal ranks into bigger, richer ones.',
      glyph: '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 8l16 10v20L32 48 16 38V18z" fill="currentColor" opacity=".45"/><path d="M24 32l8-5 8 5v10l-8 5-8-5z" fill="currentColor"/></svg>',
      color: 'acid',
      engine: 'js',
      file: 'hexmerge.js',
      status: 'live'
    },
    {
      slug: 'circuit-flow',
      title: 'Circuit Flow',
      genre: 'Puzzle',
      tags: ['logic', 'pipes', 'routing'],
      difficulty: 'Medium',
      players: '1 Player',
      duration: '5 min',
      rating: 4.5,
      plays: 12510,
      blurb: 'Route power from core to every dead node before the timer burns out.',
      glyph: '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M14 14h14v14h18v22" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="14" cy="14" r="5" fill="currentColor"/><circle cx="46" cy="50" r="5" fill="currentColor"/></svg>',
      color: 'magenta',
      engine: 'js',
      file: 'circuit-flow.js',
      status: 'live'
    },
    {
      slug: 'wordshift',
      title: 'Word Shift',
      genre: 'Puzzle',
      tags: ['words', 'anagram', 'letters'],
      difficulty: 'Easy',
      players: '1 Player',
      duration: '3 min',
      rating: 4.1,
      plays: 6820,
      blurb: 'Shuffle the letters until the hidden word snaps into place.',
      glyph: '<svg viewBox="0 0 64 64" aria-hidden="true"><rect x="10" y="14" width="20" height="20" rx="4" fill="none" stroke="currentColor" stroke-width="4"/><rect x="34" y="30" width="20" height="20" rx="4" fill="currentColor" opacity=".55"/></svg>',
      color: 'orange',
      engine: 'js',
      file: 'wordshift.js',
      status: 'live'
    },
    {
      slug: 'apex-velocity',
      title: 'Apex Velocity',
      genre: 'Racing',
      tags: ['time trial', 'tracks', 'speed'],
      difficulty: 'Hard',
      players: '1 Player',
      duration: '5 min',
      rating: 4.4,
      plays: 8760,
      blurb: 'Chase the ghost line through five apex-heavy circuits. Beat your own ghost.',
      glyph: '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M10 52c6-4 8-14 16-14s10 10 18 10 8-8 10-16" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"/><path d="M12 20h40" stroke="currentColor" stroke-width="3" opacity=".5" stroke-dasharray="5 5"/></svg>',
      color: 'magenta',
      engine: 'js',
      file: 'apex-velocity.js',
      status: 'live'
    },
    {
      slug: 'night-rally',
      title: 'Night Rally',
      genre: 'Racing',
      tags: ['rally', 'dirt', 'handling'],
      difficulty: 'Hard',
      players: '1 Player',
      duration: '6 min',
      rating: 4.2,
      plays: 7310,
      blurb: 'Headlights, loose gravel, zero brakes. Hold the line through the dark.',
      glyph: '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 8l8 20-8 8-8-8z" fill="currentColor"/><path d="M20 54c4-8 6-12 12-12s8 4 12 12" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>',
      color: 'violet',
      engine: 'js',
      file: 'night-rally.js',
      status: 'live'
    },
    {
      slug: 'speed-trap',
      title: 'Speed Trap',
      genre: 'Arcade',
      tags: ['reflex', 'tuning', 'arcade'],
      difficulty: 'Easy',
      players: '1 Player',
      duration: '2 min',
      rating: 4.0,
      plays: 5940,
      blurb: 'Ride the needle in the green. Too fast overheats, too slow disappoints.',
      glyph: '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M12 46a20 20 0 0140 0" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M32 42l12-12" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>',
      color: 'cyan',
      engine: 'js',
      file: 'speed-trap.js',
      status: 'live'
    },
    {
      slug: 'tower-guard',
      title: 'Tower Guard',
      genre: 'Strategy',
      tags: ['defence', 'waves', 'towers'],
      difficulty: 'Hard',
      players: '1 Player',
      duration: '8 min',
      rating: 4.5,
      plays: 10230,
      blurb: 'Spend credits, stack turrets, hold the lane through twelve escalating waves.',
      glyph: '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M20 54V26l12-14 12 14v28z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><circle cx="32" cy="38" r="5" fill="currentColor"/></svg>',
      color: 'orange',
      engine: 'js',
      file: 'tower-guard.js',
      status: 'live'
    },
    {
      slug: 'base-builder',
      title: 'Base Builder',
      genre: 'Strategy',
      tags: ['economy', 'build', 'idle'],
      difficulty: 'Medium',
      players: '1 Player',
      duration: '7 min',
      rating: 4.3,
      plays: 8170,
      blurb: 'Balance income, upkeep and expansion across a grid that never sleeps.',
      glyph: '<svg viewBox="0 0 64 64" aria-hidden="true"><rect x="12" y="38" width="16" height="14" fill="currentColor" opacity=".5"/><rect x="32" y="26" width="16" height="26" fill="currentColor"/><path d="M12 38l8-10 8 10" fill="none" stroke="currentColor" stroke-width="3"/></svg>',
      color: 'acid',
      engine: 'js',
      file: 'base-builder.js',
      status: 'live'
    },
    {
      slug: 'juice-jam',
      title: 'Juice Jam',
      genre: 'Casual',
      tags: ['match', 'fruits', 'relax'],
      difficulty: 'Easy',
      players: '1 Player',
      duration: '3 min',
      rating: 4.2,
      plays: 9640,
      blurb: 'Swap, splash, and cascade into longer chains of glowing fruit.',
      glyph: '<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="36" r="16" fill="currentColor" opacity=".55"/><path d="M32 20c0-6 5-9 9-9" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>',
      color: 'magenta',
      engine: 'js',
      file: 'juice-jam.js',
      status: 'live'
    },
    {
      slug: 'stack-tower',
      title: 'Stack Tower',
      genre: 'Puzzle',
      tags: ['timing', 'balance', 'one tap'],
      difficulty: 'Medium',
      players: '1 Player',
      duration: '2 min',
      rating: 4.4,
      plays: 14320,
      blurb: 'Drop blocks dead-centre or watch the whole tower lean into the void.',
      glyph: '<svg viewBox="0 0 64 64" aria-hidden="true"><rect x="20" y="12" width="24" height="8" fill="currentColor"/><rect x="16" y="24" width="30" height="8" fill="currentColor" opacity=".7"/><rect x="14" y="36" width="34" height="8" fill="currentColor" opacity=".5"/><rect x="12" y="48" width="38" height="6" fill="currentColor" opacity=".35"/></svg>',
      color: 'acid',
      engine: 'js',
      file: 'stack-tower.js',
      status: 'live'
    },
    {
      slug: 'neon-bubbles',
      title: 'Neon Bubbles',
      genre: 'Casual',
      tags: ['pop', 'aim', 'bubble'],
      difficulty: 'Easy',
      players: '1 Player',
      duration: '3 min',
      rating: 4.1,
      plays: 7480,
      blurb: 'Bounce the shot off the walls and pop every cluster before it drifts away.',
      glyph: '<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="26" cy="30" r="12" fill="none" stroke="currentColor" stroke-width="4"/><circle cx="44" cy="40" r="8" fill="currentColor" opacity=".6"/></svg>',
      color: 'cyan',
      engine: 'js',
      file: 'neon-bubbles.js',
      status: 'live'
    },
    {
      slug: 'lucky-claw',
      title: 'Lucky Claw',
      genre: 'Casual',
      tags: ['crane', 'luck', 'grab'],
      difficulty: 'Easy',
      players: '1 Player',
      duration: '2 min',
      rating: 3.8,
      plays: 5210,
      blurb: 'Time the drop, snag a prize, and try to beat the crane that cheats.',
      glyph: '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 10v10M24 20h16l-4 8h-8z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M32 28v10" stroke="currentColor" stroke-width="3"/><rect x="26" y="38" width="12" height="12" rx="2" fill="currentColor" opacity=".6"/></svg>',
      color: 'orange',
      engine: 'js',
      file: 'lucky-claw.js',
      status: 'live'
    },
    {
      slug: 'penalty-kick',
      title: 'Penalty Kick',
      genre: 'Sports',
      tags: ['football', 'aim', 'keeper'],
      difficulty: 'Medium',
      players: '1 Player',
      duration: '3 min',
      rating: 4.3,
      plays: 12050,
      blurb: 'Five kicks, one keeper who reads you. Place it in the corner and take the cup.',
      glyph: '<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="34" r="16" fill="none" stroke="currentColor" stroke-width="4"/><path d="M32 26l7 5-7 5-7-5z" fill="currentColor"/></svg>',
      color: 'cyan',
      engine: 'js',
      file: 'penalty-kick.js',
      status: 'live'
    },
    {
      slug: 'swish',
      title: 'Swish!',
      genre: 'Sports',
      tags: ['basketball', 'arcade', 'angles'],
      difficulty: 'Medium',
      players: '1 Player',
      duration: '3 min',
      rating: 4.2,
      plays: 9860,
      blurb: 'Bank it off the backboard, swish it clean, and own the arcade court.',
      glyph: '<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="38" r="14" fill="none" stroke="currentColor" stroke-width="4"/><path d="M18 20h28v10" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>',
      color: 'magenta',
      engine: 'js',
      file: 'swish.js',
      status: 'live'
    },
    {
      slug: 'bullseye',
      title: 'Bullseye Dash',
      genre: 'Sports',
      tags: ['darts', 'aim', 'accuracy'],
      difficulty: 'Hard',
      players: '1 Player',
      duration: '4 min',
      rating: 4.4,
      plays: 7620,
      blurb: 'Ninety, sixty, thirty. Land the bullseye for a perfect nine-dart finish.',
      glyph: '<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="22" fill="none" stroke="currentColor" stroke-width="3"/><circle cx="32" cy="32" r="12" fill="none" stroke="currentColor" stroke-width="3"/><circle cx="32" cy="32" r="4" fill="currentColor"/><path d="M50 14L38 26" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>',
      color: 'acid',
      engine: 'js',
      file: 'bullseye.js',
      status: 'live'
    },
    {
      slug: 'neon-golf',
      title: 'Neon Golf',
      genre: 'Sports',
      tags: ['golf', 'physics', 'courses'],
      difficulty: 'Medium',
      players: '1-2 Players',
      duration: '6 min',
      rating: 4.5,
      plays: 10640,
      blurb: 'Bank the walls, read the slopes, and sink it in as few taps as you can.',
      glyph: '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M14 52V22l20-10v40" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><circle cx="46" cy="46" r="5" fill="currentColor"/></svg>',
      color: 'violet',
      engine: 'js',
      file: 'neon-golf.js',
      status: 'live'
    },
    {
      slug: 'rhythm-pulse',
      title: 'Rhythm Pulse',
      genre: 'Arcade',
      tags: ['music', 'timing', 'beat'],
      difficulty: 'Hard',
      players: '1 Player',
      duration: '4 min',
      rating: 4.6,
      plays: 0,
      blurb: 'Chase the beat, chain the hits, and never miss a single downbeat.',
      glyph: '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M12 40V24M24 46V18M36 40V24M48 46V18" stroke="currentColor" stroke-width="5" stroke-linecap="round" fill="none"/></svg>',
      color: 'magenta',
      engine: 'js',
      file: 'rhythm-pulse.js',
      status: 'live'
    },
    {
      slug: 'rogue-shift',
      title: 'Rogue Shift',
      genre: 'Strategy',
      tags: ['roguelike', 'turns', 'deck'],
      difficulty: 'Hard',
      players: '1 Player',
      duration: '10 min',
      rating: 4.7,
      plays: 0,
      blurb: 'Every run reshuffles the map. Spend your shifts wisely, descend once.',
      glyph: '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 10l20 12v20L32 54 12 42V22z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M32 24l6 8h-12z" fill="currentColor"/></svg>',
      color: 'violet',
      engine: 'js',
      file: 'rogue-shift.js',
      status: 'live'
    }
,
    {
      slug: 'pacman',
      title: 'Neon Pac',
      genre: 'Arcade',
      tags: ['maze', 'ghosts', 'pellets', 'classic'],
      difficulty: 'Medium',
      players: '1 Player',
      duration: '5 min',
      rating: 4.8,
      plays: 27310,
      blurb: 'Clear the maze. Four ghosts hunt you, and only one of them is really paying attention.',
      glyph: '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M33 9 51 32 33 55a23 23 0 1 1 0-46z" fill="currentColor"/><circle cx="55" cy="32" r="4" fill="currentColor"/></svg>',
      color: 'acid',
      engine: 'js',
      file: 'pacman.js',
      status: 'live'
    },
    {
      slug: 'flappy',
      title: 'Flappy Rush',
      genre: 'Arcade',
      tags: ['one button', 'endless', 'precision'],
      difficulty: 'Easy',
      players: '1 Player',
      duration: '2 min',
      rating: 4.6,
      plays: 31870,
      blurb: 'One button, one gap, three lives. The pipes only get closer.',
      glyph: '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M12 44c0-11 9-20 20-20h6V12l14 14-14 14V30h-6a9 9 0 0 0-9 9v5z" fill="currentColor"/><circle cx="47" cy="26" r="3" fill="currentColor"/></svg>',
      color: 'cyan',
      engine: 'js',
      file: 'flappy.js',
      status: 'live'
    },
    {
      slug: 'dino',
      title: 'Dino Dash',
      genre: 'Arcade',
      tags: ['endless', 'jump', 'runner'],
      difficulty: 'Easy',
      players: '1 Player',
      duration: '2 min',
      rating: 4.7,
      plays: 29540,
      blurb: 'Run, jump, duck, and grab an acid orb for a one-hit shield. The road only speeds up.',
      glyph: '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M16 54V32h7V18h11v9h8l6 7h8v6H41v14h-5V40h-8v14h-5V32h-7z" fill="currentColor"/></svg>',
      color: 'orange',
      engine: 'js',
      file: 'dino.js',
      status: 'live'
    }
  ];

  /* ==========================================================================
     PUBLISH
     Both globals are assigned once, here, at the end — so by the time any
     consumer reads them the whole file has run. window.GAMES is the live
     array, not a copy: treat it as read-only.
     ====================================================================== */
  window.GAMES = G;

  /* ==========================================================================
     window.PX_DATA — small read-only helpers over the same array
     Used by catalog.js / player.js / site.js. Additive only — nothing here
     replaces or reshapes window.GAMES, and every helper returns entries by
     reference, so a caller that wants a copy must slice() it itself.

     colors / genres  the two vocabularies. `colors` maps to the CSS custom
                      properties in css/base.css; `genres` must stay in sync
                      with the genre filter chips on games.html and index.html.
     bySlug(slug)     -> the entry for that slug, or null. This is how
                      player.js resolves ?game=, so an unknown slug returning
                      null is a normal, handled case, not an error.
     live()           -> entries with status 'live', in array order.
     featured(n=6)    -> the first n entries, NOT filtered by status: a
                      coming-soon game placed in the top slots is still
                      featured (it renders as a disabled card).
     others(slug,n=3) -> up to n other live games, for the "more games" rail
                      on play.html. Keeps array order, so the most recent
                      additions appear first.
     ====================================================================== */
  window.PX_DATA = {
    colors: ['cyan', 'magenta', 'acid', 'orange', 'violet'],
    genres: ['Arcade', 'Puzzle', 'Racing', 'Strategy', 'Casual', 'Sports'],
    bySlug: function (slug) {
      for (var i = 0; i < G.length; i++) if (G[i].slug === slug) return G[i];
      return null;
    },
    live: function () { return G.filter(function (g) { return g.status === 'live'; }); },
    featured: function (n) { return G.slice(0, n || 6); },
    others: function (slug, n) {
      return G.filter(function (g) { return g.slug !== slug && g.status === 'live'; }).slice(0, n || 3);
    }
  };
})();
