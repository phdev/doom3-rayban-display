# DOOM 3 Display

This is an open-source DOOM 3-compatible engine/demo shell for Meta Ray-Ban
Display. It is designed around a [dhewm3](https://github.com/dhewm/dhewm3)
WebAssembly engine build, a user-supplied `base/pak0XX.pk4`, Meta Neural Band
gesture input, and W3C `DeviceOrientationEvent` head turning.

It is the DOOM 3 sibling of
[glquake2-rayban-display](https://github.com/phdev/glquake2-rayban-display) and
follows the same architecture: a Vite web app shell, an engine source patch, and
a local packaging workflow.

> **Status — DOOM 3 renders in the browser.** The engine compiles, boots, loads
> real data, runs the render loop at ~50–60 fps, and **presents to the canvas**:
> the DOOM 3 main menu (Mars backdrop, starfield, UI frame, and the full
> NEW GAME / LOAD GAME / MULTIPLAYER / OPTIONS / MODS / UPDATES / CREDITS / EXIT
> bar) draws correctly. Unlike Quake II (Qwasm2/Yamagi), dhewm3 ships no official
> Emscripten target, so this repo adds one. The patch + build scripts have been
> verified end to end against real, owned DOOM 3 data: dhewm3 builds to a ~6 MB
> `dhewm3.wasm` with GL4ES, instantiates against a WebGL2 context on the
> `#gameCanvas` element, mounts a user PK4, and runs the **complete engine
> bring-up, main loop, and present**:
>
> ```
> dhewm3 1.5.5 emscripten-x86 ... using SDL v3.x
> Loaded pk4 /base/pak-display.pk4 with checksum 0x...  (4021 files)
> ----- Initializing Decls -----      5206 strings read from strings/english.lang
> LIBGL: Initialising gl4es ... Using GLES 2.0 backend
> OpenGL renderer: GL4ES using WebKit WebGL    (600x600)
> ARB2 renderer: Available.
> ----- Initializing Game -----  Compiled 'script/doom_main.script'
> ----- Initializing Session -----
> ... main loop running at ~50–60 fps; main menu compositing to #gameCanvas ...
> ```
>
> Every hard browser blocker is solved (anti-root check, networking, worker
> threads, the async-sound tic, terminal/stdin input, mouse-grab pointer-lock,
> the legacy-GL proc table, C++ exceptions, the blocking frame loop, the
> GL4ES↔WebGL binding, **and the present/compositing path** — see
> [the canvas-selector fix](#the-canvas-selector-fix-how-doom-3-reaches-the-screen)).
> **Remaining item:** the menu's central animated logo panel shows a placeholder
> (a reduced-pak cinematic/subview detail, not a present-path bug). See
> [Limitations](#limitations). This repo does **not** include DOOM 3 game data —
> you must own DOOM 3 and provide your own `base/*.pk4`.

## Play URL

URL:

```text
https://phdev.github.io/doom3-rayban-display/?pk4=
```

Add the URL for your legally obtained, display-optimized `pak-display.pk4` after
`?pk4=`. The PK4 URL should be URL-encoded:

```text
https://phdev.github.io/doom3-rayban-display/?pk4=https%3A%2F%2Fexample.com%2Fbase%2Fpak-display.pk4
```

The PK4 must be served over HTTP(S) with browser fetch access enabled. A local
filesystem path such as `/Users/.../pak-display.pk4` cannot be fetched by the
hosted app. After the first successful URL load, the app caches the PK4 in
browser storage for later launches with the same URL.

PK4 files are ordinary ZIP archives, so they can be large. The app supports
gzip (`?pk4=…/pak-display.pk4` will also try `pak-display.pk4.gz`) and a chunk
manifest (`pak-display.pk4.manifest.json`) for resilient loading inside the
glasses' WebView. `scripts/install-demo-data.sh` produces all three.

## Optimize Your PK4

DOOM 3's base data is several gigabytes across `pak000.pk4`–`pak008.pk4` — far
too large for Meta Ray-Ban Display. Build a reduced single-map package from your
own legally obtained DOOM 3 data.

Recommended target:

- Start with your owned `base/` directory (all `pak0XX.pk4`).
- Keep one playable map, usually `game/mars_city1` (the opening level).
- Keep all declaration files (`materials/*.mtr`, `def/*.def`, `script/*.script`,
  `*.sndshd`, `guis/*.gui`) plus the textures, models, animations, sounds, and
  GUIs the map actually references.
- Remove unused maps, cinematics (`.bik` videos), other levels, multiplayer-only
  assets, and anything the target map never references.
- Downsample retained WAV audio to reduce size while preserving first-level
  sounds.
- Gzip and chunk the final PK4 for transfer.

Do not delete by folder or filename alone. DOOM 3 asset dependencies are
connected through declaration files, so run a dependency pass first.
`scripts/reduce-d3-map-pk4.py` does this automatically:

```bash
# Merge your owned base/*.pk4 and build a reduced, gzipped, chunked
# pak-display.pk4 into public/wasm/base/ for the target map.
D3_DATA_DIR="/path/to/owned/doom3/base" \
D3_MAP="game/mars_city1" \
  npm run install:demo-data
```

Or reduce a single owned PK4 directly:

```bash
python3 scripts/reduce-d3-map-pk4.py \
  --input /path/to/owned/base/pak000.pk4 \
  --map game/mars_city1 \
  --audio-rate 11025 --audio-width 1 \
  --output dist-pak/base/pak-display.pk4
```

The reducer is conservative (it favors a working map over the smallest size) and
prints a report. Use `--keep-list scripts/reduced-pk4.example.json` to
force-include extra globs. Do not paste or upload copyrighted PK4 contents into a
third-party chat service.

## Controls

Meta Neural Band gestures are translated through platform input events into
DOOM 3 actions:

- Pinch tap → toggle perpetual forward
- **Pinch and hold → toggle flashlight** (DOOM 3's signature mechanic)
- Swipe up → jump
- Swipe down → recenter IMU
- Swipe left/right → large turn burst

Head turning (`DeviceOrientationEvent` yaw) steers the view through the exported
C function `D3_AddViewAngles`, with a deadzone and comfort-tuned sensitivity.

Auto-fire engages when a valid enemy target is centered in view. When auto-fire
starts, sticky forward is toggled off and IMU yaw sensitivity is halved briefly.
Left/right edge indicators light up when a hostile is off-screen to your side; a
turn-burst gesture toward an indicator snaps your view onto that enemy.

The app intercepts platform navigation-style input in the capture phase so the
WebView layer has less opportunity to consume it first. The primary camera path
is the exported C function, not browser-generated mouse movement.

## Game-Module & Engine Changes

All native changes live in `patches/dhewm3-meta-rayban-display.patch`, generated
against the pinned dhewm3 commit in `scripts/build-dhewm3.sh`. The patch adds:

- `neo/framework/d3_wearable.{h,cpp}` — the wearable bridge. JavaScript head
  tracking calls `D3_AddViewAngles`; gestures call `D3_SetWearableAction`. View
  deltas and latched actions are folded into the usercmd inside
  `idUsercmdGenLocal::MakeCurrent`.
- `neo/game/D3Wearable.{h,cpp}` — game-side enemy assist. Traces forward from the
  player view and injects attack when a valid hostile is centered; lights side
  indicators; snaps to side enemies on a turn request. Hooked with a single line
  in `idPlayer::Think`.
- `neo/sys/wasm/d3_runtime_exports.js` — re-exposes Emscripten runtime helpers
  (`FS`, `callMain`, …) on `Module` so the web shell installs PK4 data itself.
- `neo/CMakeLists.txt` — an `if(EMSCRIPTEN)` block with the WebAssembly link
  flags, exported functions, and `--preload-file`, plus the two new sources.

The client view-control export is:

```c
EMSCRIPTEN_KEEPALIVE
void D3_AddViewAngles(float dyaw, float dpitch);
```

JavaScript reads head orientation, calculates a yaw step, and calls the engine
directly.

## Build the Engine (experimental)

Requires the [Emscripten SDK](https://emscripten.org/) active in your shell.

```bash
# 1. Build GL4ES (OpenGL -> WebGL) with Emscripten.
npm run build:gl4es

# 2. Build dhewm3 to WebAssembly with the wearable patch (monolithic,
#    HARDLINK_GAME). Outputs public/wasm/dhewm3.{js,wasm,data}.
GL4ES_PATH="$PWD/.build/gl4es" npm run build:dhewm3

# 3. Stage your owned, reduced DOOM 3 data.
D3_DATA_DIR="/path/to/owned/doom3/base" npm run install:demo-data

# 4. Build and preview the web app shell.
npm run build && npm run preview
```

The web app shell alone (no engine) builds with `npm run build` and is what CI
deploys to GitHub Pages.

## What the Emscripten patch does to dhewm3

dhewm3 has no Emscripten target, so the patch adds one. Beyond the wearable
bridge, it makes these engine changes (all guarded by `#ifdef __EMSCRIPTEN__`)
that were needed to get DOOM 3 running in a browser:

- **Build system** (`CMakeLists.txt`): skip `-march`; use Emscripten's built-in
  SDL3 + OpenAL ports instead of `find_package`; emit `dhewm3.{js,wasm,data}`
  with the `D3_*` exports (monolithic `HARDLINK_GAME`); enable `-fexceptions` so
  dhewm3's recoverable `idException` errors drop to the console instead of
  hard-aborting (Emscripten disables C++ exceptions by default).
- **GL4ES binding** (`sys/glimp.cpp`): initialize GL4ES against the SDL/WebGL2
  context (`set_getprocaddress` / `set_getmainfbsize` / `initialize_gl4es`) and
  resolve all runtime GL lookups through `gl4es_GetProcAddress` — otherwise the
  engine gets the browser's bare GLES2 pointers and every fixed-function entry
  point (`glBegin`, `glColor*`, …) is null. Also pin the canvas size, since
  Emscripten's SDL reports a 0×0 window. GL4ES must be **whole-archived** at link
  (see `scripts/build-dhewm3.sh`).
- **Present / canvas selector** (`sys/glimp.cpp`): set
  `SDL_HINT_EMSCRIPTEN_CANVAS_SELECTOR` to `#gameCanvas` before window creation so
  SDL3 builds the WebGL context on the page's actual canvas, then present with
  `SDL_GL_SwapWindow` (flushing GL4ES via `gl4es_pre_swap` first). See
  [the canvas-selector fix](#the-canvas-selector-fix-how-doom-3-reaches-the-screen).
- **GL proc table** (`renderer/RenderSystem_init.cpp`): warn instead of aborting
  on the legacy GL entry points GL4ES legitimately omits (accumulation buffer).
- **Sound** (`snd_local.h`): pull in vendored OpenAL-Soft EFX headers, since
  Emscripten's OpenAL port ships only a stub `alext.h` (see `vendor/openal-efx`).
- **Startup / main loop** (`sys/linux/main.cpp`): skip the anti-root check
  (sandbox uid 0) and **convert the blocking `while(1)` frame loop to
  `emscripten_set_main_loop`** so frames yield to the browser.
- **Input** (`sys/events.cpp`): skip `handleMouseGrab` (pointer-lock) and
  `Sys_ConsoleInput` (stdin) in `Sys_GenerateEvents` — both **deadlock** in the
  browser; the wearable bridge drives the camera instead.
- **Networking** (`posix_net.cpp`): skip `getifaddrs` interface enumeration.
- **Threads** (`FileSystem.cpp`, `Common.cpp`): skip the background-download and
  async worker threads (no pthreads); the async sound tic is simply not run.

## The canvas-selector fix (how DOOM 3 reaches the screen)

For a long time the engine ran the full main loop at ~60 fps but the canvas
stayed **black** — frames rendered, nothing showed. The root cause was the
WebGL context landing on the wrong canvas:

- SDL3's Emscripten video driver creates its WebGL context with
  `emscripten_webgl_create_context(selector, …)`, where `selector` defaults to
  **`#canvas`** (`SDL_HINT_EMSCRIPTEN_CANVAS_SELECTOR`).
- Emscripten 6 resolves that selector with `document.querySelector(selector)` —
  there is no `#canvas`→`Module.canvas` alias anymore.
- This app hosts the engine on **`#gameCanvas`**, so the selector resolved to
  `null`, context creation returned `0`, `GLctx` stayed undefined (the
  `getSupportedExtensions` crash), and every frame rendered into a context that
  was never composited to the visible canvas.

The fix is one line — tell SDL3 which canvas to use, before creating the window:

```c
SDL_SetHint(SDL_HINT_EMSCRIPTEN_CANVAS_SELECTOR, "#gameCanvas");
```

With the context on the right canvas, the normal path works: render through
GL4ES, `gl4es_pre_swap()` to flush, then `SDL_GL_SwapWindow()` to present — the
same approach the working Quake II reference ([Qwasm2](https://github.com/yamagi/Qwasm2)'s
GL4ES `ref_gl1`) uses with SDL2 (which passes the canvas *element* directly via
`Browser.createContext`, so it never hit this). No `GL_PREINITIALIZED_CONTEXT`
and no manual `emscripten_webgl_make_context_current` are needed.

## Limitations

- **Menu logo placeholder.** The main menu renders correctly, but its central
  animated DOOM 3 logo panel shows grey banding instead of the spinning logo.
  That panel is a render-to-texture subview / cinematic; the placeholder is a
  reduced-pak asset/cinematic-decode detail, not a present-path bug (the rest of
  the menu — fonts, planet, starfield, buttons — composites correctly). Loading
  fuller owned data via `?pk4=` may fill it in. This is the main thing left to
  polish.
- **Reduced-pak completeness.** `scripts/reduce-d3-map-pk4.py` is a heuristic
  dependency walker; it can miss entity-referenced models (e.g. a `mars_city1`
  moveable), which `-fexceptions` now turns into a recoverable drop instead of a
  crash. A more complete pak, or loading the full owned data via `?pk4=`, avoids
  this.
- **Single-threaded.** SDL thread/condvar creation fails (non-pthread build).
  Harmless for boot, but sound and any worker threads are stubbed. A fuller
  build may want `-pthread` + `-sPROXY_TO_PTHREAD` (the app already sends the
  COOP/COEP headers SharedArrayBuffer needs).
- **Performance.** DOOM 3's renderer (per-pixel lighting, stencil shadows) is
  heavy; the app defaults to `r_shadows 0`, low machine spec, and downsized
  textures. Headless software WebGL hits ~50 fps at 600×600; real GPU hardware
  (and the glasses) should do better.
- **Game data is proprietary.** Nothing here downloads DOOM 3 data; you must own
  it and reduce it locally. If you bump `DHEWM3_COMMIT`, regenerate the patch.

## License & Notices

GPL-3.0-or-later. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md) for upstream
engine sources (dhewm3, id Tech 4, GL4ES, Emscripten) and their licenses.
