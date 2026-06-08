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

CSS `filter: brightness()` is a compositor *multiply*, so it lifts the whole
frame but cannot rescue dark surfaces (and `contrast()<1` adds gray fog). With
the engine fix below, CSS is back to near-unity (wearable `brightness:1.35`)
and serves only as a small display-size accommodation.

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

### iPhone tile-flicker — attempted immutable-texture fix REVERTED (2026-06)

Tried `patches/gl4es-immutable-textures.patch` (a GL4ES fast path routing
`glTexImage2D` through `glTexStorage2D` + `glTexSubImage2D`, per the
[bgfx#3352](https://github.com/bkaradzic/bgfx/issues/3352) iOS 18 workaround).
On Mac WebKit (Playwright) the A/B looked positive — stationary variance
26.6% → 21.6%, no visible regressions. iOS Simulator rendered cleanly.

**But on real iPhone Safari it caused large rectangular black artifacts during
motion** (mid-scene tile-sized blocks of stale/missing content). Root cause:
DOOM 3 makes render-target textures via `glCopyTexImage2D` from the framebuffer
(mirror/portal/post buffers). When my patch had previously frozen a texture
into immutable `GL_RGBA8` storage, a later `glCopyTexImage2D` from a
differently-formatted source FBO failed with `INVALID_OPERATION: Invalid copy
texture format combination` — which Mac WebKit silently absorbed (showing
acceptable stale contents) but mobile Metal manifested as the black-block
artifacts visible in IMG_2467. Patch deleted; engine rebuilt to original
behaviour. Residual iPhone flicker is back to its prior baseline (per-frame
intensity oscillation, deep-research file points at FP non-determinism in the
lit-pass accumulation — not the iOS 18 mutable-storage class).

A companion JS-side wrap lives in `src/main.js` (`fixIOS18TextureStorage`),
opt-in via `?immutable` URL flag. Kept as an A/B harness; same risks apply.

### WebKit-wide dark lit world — root cause + fix (2026-06)

For weeks the lit world rendered near-black on every WebKit browser (iPhone
Safari, Mac Safari, headless WebKit) while emissive surfaces (ceiling lights,
sparks) showed. The same pak + same engine binary rendered fully lit on Chrome
(ANGLE). Investigation ruled out: missing assets, the engine binary itself, GPU
OOM (`OOM 0`, generous caps), GL_EQUAL vs LEQUAL depth, render passes, light
scissor, framebuffer copy formats, S3TC vs uncompressed. Cvars (`r_lightScale`,
`r_gamma`, `r_brightness`, `r_skipBump/Specular/Diffuse`, `vid_restart`) moved
`frame-px` by basically zero. CSS post-processing (gamma `pow()` via SVG,
contrast pedestal, big brightness multiply) all either failed on real iOS or
washed the frame out.

**Method that cracked it.** Hot-patched the GL4ES-emitted GLSL of the
interaction shader via `WebGL2RenderingContext.prototype.shaderSource` and
replaced the final `gl_FragColor` with debug-visualization expressions, then
read `frame-px` for each. Each intermediate value in the lit math was rendered
as a color and screenshotted (`/tmp/d3-shader-probe.mjs`):

```
magenta    avg(135,5,128)  → shader IS running on walls
ndotl      avg( 99, 95, 92) → N·L positive (~0.4)
normal     avg( 97, 95,123) → tangent normals decode correctly
lightcube  avg( 98, 63,109) → normalization cubemap fine
diffuse    avg( 56, 41, 31) → wall diffuse texture fine
lightproj  avg(113,108,106) → light projection cookie fine
envcolor   avg(108,115,114) → diffuseColor uniform fine
falloff    avg( 13,  8,  6) ★ near-zero — bug ★
```

Then probed the falloff sampler at fixed coords and across the full screen —
**also** near-zero. So it wasn't the texCoord; the texture data itself was
broken. Final test, swapping the read to `.w`:

```
falloff_xyz     avg( 13,  8,  6)  → .xyz = 0
falloff_w       avg(134,129,127)  → .w = 0.5  ← data lives here
falloff_proj_w  avg(132,127,125)  → same via texture2DProj (smooth gradient)
```

**Root cause.** DOOM 3's per-light **falloff** ramp is a single-channel texture.
GL4ES emulates it through WebGL in a way that lands the data in the alpha
channel only on WebKit (`.xyz` reads as `(0,0,0)`). The interaction shader does
`light *= texture2DProj(falloff, …)` which collapses to `light *= 0` →
everything black. Chrome's WebGL (ANGLE) happens to swizzle this correctly,
which is why it never appeared there.

**Fix (`src/main.js`, `fixFalloffSampling`).** Wrap
`WebGL{,2}RenderingContext.prototype.shaderSource`; when we see the GL4ES
translation of `interaction.vfp` (identified by its DXT5-NM normal swizzle
`localNormal.x = localNormal.w`), rewrite
`texture2DProj(_gl4es_Sampler2D_2, _gl4es_TexCoord_2)` to
`vec4(texture2DProj(_gl4es_Sampler2D_2, _gl4es_TexCoord_2).w)`. Pure JS — no
engine or GL4ES rebuild. `?nofalloffix` disables it for A/B. Runs once per
shader compile, try-guarded so it can never break the engine.

Verified on Mac Safari: baseline `frame-px avg(10,5,3) nonblack 5.6%` → after
fix `frame-px avg(24,20,15) nonblack 50.9%`, scene matches the reference
exactly (warm walls, staircase, NPC, crates, floor, gun all clearly lit). With
this fix in place, the engine output is normal so CSS defaults are back to
near-unity (`brightness:1.35`, `contrast:1`, `saturate:1.05`).

The earlier WebGL probe (`caps:` + `gpu-tex:` + `frame-px:` in the diag), the
`window.d3cmd("…")` live console hook (engine `D3_ExecCommand` export), the
"copy log" button, and the URL overrides (`?dbright=` etc.) all stayed —
they're how the bug was bisected and remain useful for future on-device work.

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
