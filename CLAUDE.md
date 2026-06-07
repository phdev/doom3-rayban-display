# CLAUDE.md — doom3-rayban-display

Guidance for working in this repo. Keep this file updated as the project changes.

## What this is

An open-source DOOM 3 engine/demo shell for Meta Ray-Ban Display: a
[dhewm3](https://github.com/dhewm/dhewm3) (GPL id Tech 4) build compiled to
WebAssembly, wrapped in a Vite web app, driven by Neural Band gestures +
`DeviceOrientationEvent` head turning. Sibling of
[glquake2-rayban-display](https://github.com/phdev/glquake2-rayban-display).

**No game data lives here.** DOOM 3 PK4s are proprietary; users supply their own
reduced `base/pak-display.pk4` (or `?pk4=<url>`).

## Layout

- `src/` — Vite web app shell. `d3Runtime.js` boots the engine, mounts the PK4,
  builds the cvar/autoexec config; `main.js` wires the canvas (`#gameCanvas`),
  overlays, and input; `headTracking.js` / `wearableInput.js` feed the camera.
- `patches/dhewm3-meta-rayban-display.patch` — the Emscripten/wearable patch,
  generated against the pinned `DHEWM3_COMMIT` in `scripts/build-dhewm3.sh`.
- `scripts/` — `build-gl4es.sh`, `build-dhewm3.sh` (clone → apply patch →
  emcmake → stage `public/wasm/dhewm3.{js,wasm,data}`), `reduce-d3-map-pk4.py`
  (heuristic single-map PK4 reducer), `install-demo-data.sh`.
- `public/wasm/` — staged engine artifacts (gitignored) + `base/pak-display.pk4`
  (user-supplied, gitignored).

## Build

```bash
npm install
GL4ES_PATH=/path/to/gl4es-emscripten npm run build:gl4es   # once
GL4ES_PATH=/path/to/gl4es-emscripten npm run build:dhewm3   # engine → public/wasm
npm run build                                               # web app → dist/
```

The engine is **SDL3** + **GL4ES** (desktop-GL → WebGL2 translation), monolithic
`HARDLINK_GAME`, `-fexceptions`. The engine build tree used during development is
a manual checkout (e.g. `/tmp/dhewm3` with a `build/` dir); the canonical path is
`scripts/build-dhewm3.sh`, which applies the patch to a fresh clone. **If you edit
engine source, regenerate the patch:** `git -C <dhewm3> diff <DHEWM3_COMMIT> >
patches/dhewm3-meta-rayban-display.patch`.

## State (2026-06)

DOOM 3 **renders the 3D game world in the browser, including on a physical iPhone
(Mobile Safari).** The app boots straight into `D3_DEFAULT_MAP` (`game/mars_city1`,
the iconic Mars City Hangar opening) and renders the 3D world to `#gameCanvas`. The
bundled pak is reduced per-map (`D3_DEFAULT_MAP` must match it). The main menu is
bypassed on boot (it draws black with the reduced pak — open item). Override the map
with `?args=%2Bmap%20game/<name>`.

`mars_city1` opens directly into a lit space (best "see it running" demo). Note that
most other DOOM 3 levels *start* in a deliberately dark transition room — an airlock
or elevator with only a couple of ceiling fixtures (`game/admin` → a near-black
elevator, `game/alphalabs1` → an "AIR LOCK"). You walk forward into the lit level
proper, and the flashlight (auto-on, see Controls) lights the way.

### Opening cinematic — auto-skipped (engine patch)

`mars_city1` (and most levels) open with a scripted **cinematic** (a `func_cameraview`
takes the view; HUD/crosshair hidden). On a touchscreen there is no ESC key to skip
it (`idPlayer::HandleESC` → `SkipCinematic`), and cinematics render poorly with the
reduced data + `r_skipROQ`. So the engine patch adds **`g_skipCinematics`** (default
0; the app sets it **1**): in `idGameLocal::SetCamera`, the instant a cinematic
starts it sets `skipCinematic`/`cinematicMaxSkipTime` (the non-disconnect path of
`SkipCinematic`), fast-forwarding every cinematic so the player drops straight into
gameplay. Fast-forward (not abort) means the cinematic's script triggers still fire,
so progression isn't broken.

### Controls (mobile / wearable profile)

- **Movement pad** — a bottom-left on-screen d-pad (`#moveControls`, forward / back /
  strafe-left / strafe-right). Each button drives the engine's existing `w/a/s/d`
  binds via **synthetic `KeyboardEvent`s** (verified to reach the SDL/Emscripten
  keyboard listener), so no engine change was needed. Head-turning still aims.
- **No tap-to-melee** — SDL maps a touch tap to the left mouse button, so the default
  `MOUSE1 -> _attack` bind made every tap swing the fists. The wearable profile now
  `unbind`s `mouse1`/`mouse2` in the autoexec (desktop keeps them).
- **Flashlight** — auto-enabled ~2.6 s after spawn (`config.autoFlashlight`) and
  toggled by a long pinch. Its view-model effect surfaces (`beam1`/`flare`/`flare2`/
  `bulb`) have **no material in the game data**, so the engine built implicit OPAQUE
  materials and the light-beam billboard rendered as a **solid white quad** stuck to
  the flashlight. Fix: the app writes a loose `base/materials/zz_flashlight_fix.mtr`
  declaring those four as additive-`_black` (invisible) — the real illumination comes
  from the projected light, not these cosmetic surfaces.

### Brightness / gamma (a WebGL dead end)

DOOM 3 is a dark game and relies on gamma correction to lift dim areas. **In this
build there is effectively no working gamma:**

- **Hardware gamma is gone** — SDL3 dropped `SDL_SetWindowGammaRamp`, so
  `GLimp_SetGamma` is a no-op (it only warns). `r_gammaInShader 0` therefore does
  nothing.
- **In-shader gamma** (`r_gammaInShader 1`, the dhewm3 default) injects
  `pow(color, 1/gamma)` into every ARB fragment program, but its effect is not
  observable through GL4ES on the maps tested — `r_gamma`/`r_brightness`/
  `r_lightScale` do not visibly change the frame.

CSS `filter: brightness()` (`config.displayBrightness` → `--d3-display-brightness`)
is a compositor *multiply*, so it lifts the whole frame but cannot rescue dark
surfaces (1.2 × 9 ≈ 11, still black). `r_gamma`/`r_brightness`/`r_lightScale` are
set (correct intent) but the in-shader gamma is inert on the iPhone GPU.

**The fix — raise the black floor with native `contrast()` (compositor).** The
on-device probe showed the lit world comes out near-black-but-nonzero (`frame-px
avg(9,5,3)`, `max 165` — the bright fixtures render, the lit walls don't). The
right tool is a curve that lifts darks, not a multiply.

- First attempt was an **SVG `feComponentTransfer type="gamma"` filter**
  (`pow(9/255,0.45)≈50`). It works great in Playwright WebKit (~19%→~96% non-black)
  but **barely applies on real iOS Safari** — the filter runs in a different color
  space there, so the lit only crept `avg(7,2,1)`→`(11,7,4)`. Abandoned (don't
  re-try SVG `url()` gamma on iOS).
- Shipped instead: **native `contrast()` below 1**, which raises the black floor (a
  pedestal that lifts dark pixels — `brightness()` is a multiply and can't), then
  `brightness()` scales. Both are native CSS filter functions and reliable on iOS.
  `applyDisplayTuning` builds the `--d3-display-*` vars; wearable defaults
  `brightness 1.7 / contrast 0.7 / saturate 1.15` (lifts ~9→~50). Cost: slightly
  milky blacks. **Live-tunable on-device (no redeploy) via `?dbright=` /
  `?dcontrast=` / `?dsat=`.**

(Note: the `frame-px` probe samples the canvas *backing store*, i.e. **before** the
CSS filter, so it keeps reporting the raw engine output ~9 even when the display is
correctly lifted — judge brightness by eye, not that number.)

**Live engine tuning (`d3cmd`).** Because CSS post-processing can't truly fix a dark
*engine* output (a multiply amplifies banding; `contrast()<1` adds gray fog), the
real fix is engine-side — but blind 6-min deploy cycles made that painful. The
engine patch now exports **`D3_ExecCommand`** (`neo/framework/d3_wearable.cpp`,
added to the `EXPORTED_FUNCTIONS` list in `neo/CMakeLists.txt`), surfaced as
**`window.d3cmd(cmd)`** once the runtime is up (`d3Runtime.js`). It runs any DOOM 3
console command next frame, so the renderer can be tuned **live on-device from the
Safari Web Inspector console** with no rebuild — e.g. `d3cmd("r_lightScale 20")`,
`d3cmd("r_gamma 3")`, `d3cmd("r_brightness 2")`, `d3cmd("r_skipInteractions 1")`,
`d3cmd("reloadARBprograms")`, `d3cmd("vid_restart")`. Use it to find which lever
actually brightens the lit pass on the A-series GPU, then bake the winners into the
profile / autoexec.

### iPhone-only dark lit world (under investigation, 2026-06)

Symptom: on a physical iPhone the **textured/lit world renders black** while
emissive surfaces (ceiling lights, sparks, the green hologram) still show. The
reference (real DOOM 3 "Mars City Hangar") is *dark but readable* — dim red walls,
crates, an NPC; the iPhone loses all of that dim lighting and keeps only the bright
point-lights.

What's been **ruled out** (so the next person doesn't re-chase them):

- **Not missing assets.** The reduced pak contains `glprogs/interaction.vfp` (the
  lit-pass ARB shader) + all 15 glprogs and the light projection/falloff textures
  (`lights/biground1`, `squarelight1`, `spot01`, …). The *same* pak renders the
  full lit hangar on desktop.
- **Not the engine binary.** The deployed `dhewm3.wasm` renders fully lit when run
  locally — only the iPhone is dark.
- **Not depth (`GL_EQUAL` vs `LEQUAL`), render passes, light scissor, framebuffer
  copy, or texture compression.** Verified by A/B on Playwright **WebKit** driving
  the **M1 Max** (same Apple TBDR GPU family + same WebKit engine as the iPhone):
  the scene renders ~97% lit in every configuration, *including with S3TC disabled*
  (GL4ES falls back to uncompressed cleanly). The desktop Apple GPU is simply far
  more capable than the iPhone's, so the on-device failure does not reproduce there.

**On-device probe results (2026-06) — memory and limits are ruled out.** The
iPhone reported `gpu-tex: 15974 uploads ~75MB … OOM 0 … err 6` (no context loss)
and `caps: maxTex 16384 texUnits 16 vtxTex 16 varying 31 fragU 1024`. So it is
**not** out of GPU memory and hits **no** limit the desktop doesn't — and all
75 MB of textures uploaded fine. The engine fully loads the map (`1969 entities`,
`GenerateAllInteractions`, `28926 interactions`); the only "Couldn't load image"
warnings are **props / particles / decals / env-cubemaps**, never the wall/floor/
ceiling architecture. Conclusion: **the lit-pass output is genuinely dimmer on
the A-series GPU** than on desktop with identical cvars — most likely the
in-shader gamma/brightness lift (`r_gammaInShader`) is weaker through GL4ES on
that GPU, so the dim base lighting never gets lifted (and dead hardware gamma
means nothing else lifts it).

Mitigation in flight: bumped `r_lightScale` (wearable) 3 → 6 — it runs in the
core interaction path, so it works through GL4ES regardless of the gamma shader.

**On-device WebGL probe (`src/main.js`).** Because the failure can't be
reproduced off-device, the app wraps `HTMLCanvasElement.prototype.getContext`
(instrumenting the engine's own context instead of stealing it — see the warning
comment; it also forces `preserveDrawingBuffer` so the frame is readable) and
surfaces three lines at the top of the `#diag` overlay:
- `caps:` — GPU limits (max texture, texture units, varyings, fragment uniforms).
- `gpu-tex:` — texture upload count + est. MB + max dim + **OOM count** + GL error
  count + context-lost flag. `OOM > 0` / `CTX-LOST` ⇒ memory (ruled out so far).
- `frame-px:` — `avg(r,g,b)` + `max` sampled from the **rendered frame** (canvas
  backing store, before the CSS filter). Near-black `avg` ⇒ the lit-shader output
  is the problem; dim-but-present `avg` ⇒ exposure/display. `max` shows whether the
  bright lights render at all.

A **"copy log"** button (next to "hide log") copies the whole overlay to the
clipboard. `?noprobe` disables the wrap (A/B). The probe never touches draw calls
and is try-guarded so it cannot break the engine.

### Mobile / iOS (hard-won)

- **Stale-404 cache** — `fetchBytes` defaulted to `cache:"force-cache"`; after a
  file 404'd (e.g. a chunked-vs-single-file deploy), Safari served the stale 404
  forever ("No PK4 available"). Now `cache:"no-store"`.
- **Lean pak** — `reduce-d3-map-pk4.py --max-texture 256` downsizes in-pak TGAs
  (the engine still caps GPU textures via `image_downSizeLimit`, set to 128 on the
  wearable/mobile profile). Keeps the pak < 100 MB (single file, no chunks).
- **High-DPI tiny render** — Emscripten high-DPI blew the canvas drawable up to
  css-size × dpr (402pt × 3 = 1206) while the engine rendered at `r_customWidth`
  (448), so the scene drew into a corner. `glimp.cpp` skips
  `SDL_WINDOW_ALLOW_HIGHDPI` on `__EMSCRIPTEN__` so the drawable matches the render
  res and fills the canvas.
- **On-device diagnostics** — `#diag` overlay (touch-scrollable; `?nodiag` to
  hide) prints the WebGL renderer, engine milestones/errors, PK4 download
  progress, and a `webglcontextlost` listener — turns a black phone into a
  readable boot log.
- The iOS Simulator (real WebKit, Mac GPU) is a useful proxy: `xcrun simctl boot`
  + `openurl`. Chrome mobile emulation (`Emulation.setDeviceMetricsOverride`,
  dpr 3) reproduced the high-DPI tiny render.

Getting in-level 3D on screen took three independent fixes:
1. **Present** — SDL3 canvas selector (see below); the engine drew to the wrong
   canvas. Fixed the black menu.
2. **Pak completeness** — `reduce-d3-map-pk4.py` under-included a level's deps.
   Now: fixpoint def-graph walk; accumulate same-named decl blocks (entityDef and
   model defs share names — overwrite dropped body meshes); seed player + default
   weapons/PDA/flashlight; always keep `glprogs/` (ARB shaders the lit path
   needs). Plus the engine drops a missing moveable/item/camera collision model
   instead of aborting the map. `mars_city1` now loads with **zero fatal errors**.

   2b. **Model-material scanning (the big one for "black walls").** The reducer
   resolved materials for `.md5mesh` models only — but a DOOM 3 map's *environment*
   (walls, doors, lights, props) is built from `.lwo` (binary) and `.ase` models,
   ~190 `.lwo` + ~30 `.ase` on `admin` alone. Their materials, and so every
   diffuse/normal/specular texture they reference, were dropped: **481 missing
   images** on `admin`, including the elevator's own wall texture
   (`textures/base_door/delelev1`) and the ceiling lights
   (`textures/base_light/gottubelight`). **A surface whose diffuse (`_d`) is missing
   renders pure black**, which read as "the level is unlit". Fix: step 5 of the
   reducer now scans *all* model formats (`.lwo`/`.ase`/`.ma`/`.md5mesh`) for the
   material-name strings DOOM 3 embeds in them (ASCII even in binary `.lwo`), and
   resolves each both explicitly (a `.mtr` block of that name) and **implicitly**
   (no `.mtr` → derive `<name>_d/_local/_s/_add` by engine convention, which is how
   `delelev1`/`gottubelight` work). Result: 481 → ~100 missing (the rest are
   cosmetic — env cubemaps, decals, particles, a few props), pak `78 MB → ~55 MB`
   (also dropped `--max-texture` to 128 to match the mobile GPU's
   `image_downSizeLimit`, so it's lossless on-device). **This was the actual cause
   of the dark walls, not lighting** — see "Brightness / gamma" above for why the
   *genuinely* dim transition rooms (airlocks/elevators) still look dark.
3. **ROQ cinematic crash** — the WASM RoQ decoder calls a **null function pointer**
   in `idCinematicLocal::ImageForTime` (reached from `RB_BindVariableStageImage`
   when a video surface is drawn), trapping the render loop → black screen. Config
   sets **`r_skipROQ 1`** so `ImageForTime` returns empty early and the renderer
   binds black for those surfaces. Found by relinking with `--profiling-funcs`
   for named WASM stack traces.

**Remaining:**
- **ROQ video disabled** (`r_skipROQ 1`): the menu's animated logo panel and
  in-game monitors show a black placeholder. Fixing the decoder's null function
  (so videos play) is future work.
- **Headless software-GL is too slow** for a full level's first frame (minutes);
  use a real GPU. The `mars_city1` opening is genuinely dark — bump `r_brightness`.
- Bundled pak must be regenerated per-map from owned data via
  `scripts/install-demo-data.sh` (`D3_DATA_DIR=<owned base/>`).

## Key learning — the present bug (black canvas)

The single hardest bug: engine ran at 60 fps but the canvas was black. **Root
cause: the WebGL context was created on the wrong canvas.**

- SDL3's Emscripten driver calls `emscripten_webgl_create_context(selector,…)`
  with `selector` defaulting to `#canvas` (`SDL_HINT_EMSCRIPTEN_CANVAS_SELECTOR`).
- Emscripten 6 resolves it via `document.querySelector(selector)` — no
  `#canvas`→`Module.canvas` alias exists anymore.
- This app uses `#gameCanvas` → selector resolved to `null` → context creation
  returned `0` → `GLctx` undefined (`getSupportedExtensions` crash) → frames
  rendered into a context never composited to the visible canvas.

**Fix (`sys/glimp.cpp`, in `GLimp_Init` before window creation):**

```c
SDL_SetHint(SDL_HINT_EMSCRIPTEN_CANVAS_SELECTOR, "#gameCanvas");
```

Then the standard path works: render → `gl4es_pre_swap()` → `SDL_GL_SwapWindow()`.
This matches the working Qwasm2 GL4ES path (SDL2 passes the canvas *element*
directly via `Browser.createContext`, so it never hit the selector mismatch). We
removed the earlier `GL_PREINITIALIZED_CONTEXT` + `Module.preinitializedWebGLContext`
+ manual `emscripten_webgl_make_context_current(1)` workaround — they fought the
framework and are unnecessary once the selector is right.

Debugging method that worked: headless Chrome (`--headless=new` +
`--enable-unsafe-swiftshader`) over CDP, screenshot `#gameCanvas`, analyze pixel
distribution (`/tmp/analyze_shot.py`: distinct colors / non-black% / verdict). A
standalone WebGL rAF clear composited fine while the engine's didn't — which
isolated the problem to *which context/canvas* the engine drew into, not the
present call itself.

## Other Emscripten blockers (all solved, `#ifdef __EMSCRIPTEN__`)

anti-root check; `getifaddrs` networking; SDL worker/condvar threads + async
sound tic; terminal/stdin `Sys_ConsoleInput` + mouse-grab pointer-lock deadlocks
in `Sys_GenerateEvents`; null legacy-GL proc table (route through GL4ES); C++
exceptions (`-fexceptions`); blocking `while(1)` loop → `emscripten_set_main_loop`;
vendored OpenAL-Soft EFX headers (`vendor/openal-efx`); pinned canvas size (SDL
reports 0×0). See "What the Emscripten patch does to dhewm3" in `README.md`.

## Conventions

- Engine-side changes are `#ifdef __EMSCRIPTEN__`-guarded and live in the patch,
  not committed into a dhewm3 checkout. Regenerate the patch after engine edits.
- Don't commit PK4 data or engine binaries (gitignored). Don't upload PK4
  contents to third-party services (proprietary).
- After code changes: commit + push, and update this file + `README.md`.
