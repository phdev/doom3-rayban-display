# DOOM 3 Display

This is an open-source DOOM 3-compatible engine/demo shell for Meta Ray-Ban
Display. It is designed around a [dhewm3](https://github.com/dhewm/dhewm3)
WebAssembly engine build, a user-supplied `base/pak0XX.pk4`, Meta Neural Band
gesture input, and W3C `DeviceOrientationEvent` head turning.

It is the DOOM 3 sibling of
[glquake2-rayban-display](https://github.com/phdev/glquake2-rayban-display) and
follows the same architecture: a Vite web app shell, an engine source patch, and
a local packaging workflow.

> **Status — experimental engine.** Unlike Quake II (Qwasm2/Yamagi), dhewm3 does
> not ship an official Emscripten target. The web app shell, input/assist
> system, PK4 packaging, and the engine patch are complete and the shell builds
> and deploys today, but compiling DOOM 3 to WebAssembly and getting it
> performant on Meta Ray-Ban Display hardware is a work in progress. See
> [Limitations](#limitations). This repo does not include DOOM 3 game data — you
> must own DOOM 3 and provide your own `base/*.pk4`.

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

## Limitations

- **No official dhewm3 Emscripten target.** The patch and build script lay out
  the intended pipeline (GL4ES renderer, `MAIN_MODULE=2`, 512 MB initial memory,
  hard-linked game), but exact SDL/GL flag tuning against the pinned commit may
  still need iteration. If you bump `DHEWM3_COMMIT`, regenerate the patch.
- **Memory & performance.** DOOM 3's renderer (per-pixel lighting, stencil
  shadows) is heavy for a wearable WebView; expect to disable shadows / bump
  effects and downsize images for an acceptable frame rate.
- **Game data is proprietary.** Nothing here downloads DOOM 3 data; you must own
  it and reduce it locally.

## License & Notices

GPL-3.0-or-later. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md) for upstream
engine sources (dhewm3, id Tech 4, GL4ES, Emscripten) and their licenses.
