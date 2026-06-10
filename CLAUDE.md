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

### WebGPU port (Phase 5+, in-progress, 2026-06)

Approach: side-by-side cutover. The `r_backend` cvar (`"gl"`/`"webgpu"`)
selects which `idRenderBackend` instance the engine drives, gated by the
`?backend=webgpu` URL flag. The WebGPU backend renders into a separate
`#webgpuCanvas` so the existing `#gameCanvas` GL path keeps working
unchanged — eventually `#gameCanvas` goes away. The whole port lives in
`patches/dhewm3-meta-rayban-display.patch` + `webgpu-port/shaders/*.wgsl`
(`scripts/embed_wgsl.py` bakes them into the wasm at build time).

JS bootstraps via `navigator.gpu.requestAdapter()` →
`requestDevice()` → `Module.preinitializedWebGPUDevice` in
`d3Runtime.js`; the C++ side picks it up synchronously via
`emscripten_webgpu_get_device()`. If acquisition fails (no
`navigator.gpu`, or adapter/device unavailable like in the iOS
Simulator), `d3Runtime.js` demotes `r_backend=webgpu` → `"gl"` in the
engine args before WASM runs — otherwise emdawnwebgpu's
`importJsDevice` crashes on the undefined device's `.queue`.

**Iteration log:**
- **Iter 1** — textured demo quad on `#webgpuCanvas` via `texture.wgsl`
  + 64×64 procedural green-checker. Confirmed end-to-end:
  pipeline-create + bindgroup + textured draw + present on iOS Safari.
- **Iter 2** — `RB_BeginDrawingView` captures `viewDef->{projection,
  worldSpace.modelView}Matrix` into file-scope `extern "C"` globals
  in `tr_render.cpp` (`g_lastViewMatrix`, `g_lastProjMatrix`). Demo
  quad still draws with identity MVP — plumbing only.
- **Iter 3** — `RB_T_RenderTriangleSurface` captures the first
  qualifying triangle surface each frame (~480KB verts + 64KB indexes,
  downcast to u16, capped at 8192/32768). WebGPU backend grows GPU
  buffers as needed (`uploadCapturedSurface`), draws with
  `MVP = proj * view * model`. Fired in depth-fill pass — superseded
  by iter 4.
- **Iter 4** — capture moved to `RB_ARB2_DrawInteraction` (lit pass)
  so we get a visible wall/floor/prop instead of depth-only geometry,
  AND the per-light/per-material uniforms (`localLightOrigin`,
  `localViewOrigin`, `lightProjection[0..3]`, `diffuse/specularColor`).
  WebGPU backend adds a second pipeline using `interaction.wgsl` with
  5 procedural textures + material/lighting samplers + a 192-byte
  uniform buffer. Lit-pass MATH runs through WebGPU end-to-end.
- **Iter 5** — depth attachment (Depth24Plus) on the WebGPU render
  pass + LessEqual depth-stencil state on both pipelines so the
  captured surface composites without z-fighting. Prereq for iter 6.
- **Iter 6** — capture ALL lit-pass surfaces per frame (up to 64),
  not just the first. CPU-side `g_capRecords[]` accumulates the 64
  best surfaces with verts/indexes appended to a 4MB / 1MB
  accumulator. WebGPU side: 64 pre-allocated per-record uniform
  buffers + 64 bind groups (textures shared). EndFrame loops:
  upload accumulators → recordVertexBuf/recordIndexBuf, write each
  record's MVP+light uniforms, loop `setBindGroup[i] +
  setVertexBuffer(vertOffset) + setIndexBuffer(indexOffset) +
  drawIndexed(indexCount)`. WebGPU canvas now shows the whole lit
  scene (first 64 surfaces).
- **detTest harness** — `window.detTest("#webgpuCanvas", 5, 250)`
  from Safari Web Inspector. Captures N frames `delayMs` apart,
  pairwise diffs RGB, reports mean % diff + max delta.
  **CAVEAT (discovered 2026-06-09): drawImage readback of a WebGPU
  canvas returns black** — the drawing buffer is cleared after present
  (like WebGL without preserveDrawingBuffer). Every numerical detTest
  result on `#webgpuCanvas` (including the earlier "0.000% verified"
  claims) was vacuously diffing cleared buffers. detTest remains valid
  for the GL canvas; for the WebGPU canvas only compositor-level
  observation (eyeballs, or headed-browser screenshots) is honest.
  Headless Chrome screenshots also fail to composite the WebGPU canvas
  (black) — use HEADED Chrome via Playwright for local visual checks.
- **fullDetTest** — `window.fullDetTest(5, 300)` pauses the engine and
  A/Bs both canvases. On iPhone the pause makes iOS Safari throttle
  canvas updates so both sides trivially report 0% — also not load-
  bearing. The decisive instrument is the eyeball test: watch both
  canvases side-by-side while the engine renders.
- **Iter 7a** — engine-side CPU image cache: Image_load.cpp's
  GenerateImage stashes the RGBA8 source buffer for every loaded
  image keyed by idImage pointer (512-slot table in tr_render.cpp).
  draw_arb2.cpp captures the 5 image pointers per record alongside
  the geometric data. WebGPU backend doesn't yet upload these
  (procedural fallback stays); iter 7b is the GPU upload + per-record
  bind-group rebuild.

**Mac Safari / iOS Sim caveats:** iOS Simulator's WebKit reports
`navigator.gpu` but the actual adapter request fails; the fallback
takes over and the engine boots to GL. Mac Safari 26+ has working
WebGPU. Real iPhone Safari has working WebGPU (verified iter 1).

**Iter 6.5/6.6/6.7 — the "black echo canvas" debug saga (2026-06-09).**
The first iPhone eyeball test showed the echo canvas not flickering —
but it was BLACK (nothing rendered), so that was no proof at all.
Diagnostic ladder that cracked it (each step a deploy + iPhone look,
then a local headed-Chrome loop once we discovered headless Chrome
can't composite WebGPU canvases):
1. Bright teal clear → user saw teal → render pass executes.
2. Forced demo quad → user saw checker → base pipeline fine; bug
   isolated to the captured-geometry path.
3. Root causes found and fixed (iter 6.6):
   - **Per-view reset wiped records**: `RB_BeginDrawingView` runs once
     per VIEW (main view, lightgem, subviews), so resetting the record
     accumulator there erased the main view's captures before
     EndFrame read them — the multi path silently drew 0 records all
     along (the "multi-surface upload" log never fired). Fix: EndFrame
     CONSUMES (drains) the accumulator; no reset at view start.
   - **MVP convention risk**: now the FULL MVP (projection *
     modelViewMatrix) is baked per record at capture time in
     draw_arb2.cpp where both matrices are in scope for the correct
     view. WebGPU side uses it verbatim. Also skips views narrower
     than 128px (lightgem).
   - **GL→WebGPU clip-z**: GL clip-z is [-w,w], WebGPU is [0,w];
     vertex shaders now remap `z' = (z+w)/2`. Without it geometry
     near-plane-clips away.
4. Magenta-forced fragment output → headed Chrome showed magenta
   silhouettes → raster fine, lit math = 0. Two zero-makers fixed
   (iter 6.7):
   - **DXT5-NM neutral normal was wrong**: the procedural "flat"
     normal must be A=0x80 G=0x80 (X=alpha in DXT5-NM); it was
     A=0xFF → decoded normal (1,0,0) ⊥ light → NdotL≈0 → black.
   - **Vertex-color multiply removed**: DOOM 3 interactions default
     SVC_IGNORE (vertex color unused); world verts often carry black,
     so the unconditional multiply zeroed the output.
After iter 6.7 headed Chrome shows lit green-checker DOOM 3 geometry
with real per-light shading in the echo canvas — 43 records/frame on
mars_city1. **The chunky-tile A/B on iPhone is NOT yet concluded** —
the earlier "confirmed fixed" claim was premature (black canvas can't
flicker). Re-run the eyeball test now that content renders.

**Iter 6.8 — in-engine determinism self-test (2026-06-09).** Because
WebGPU canvases read back as cleared and the iOS Simulator has neither
working WebGPU nor the chunky-tile bug, the only honest instruments
were eyeballs — until this. The backend now periodically (frame 90,
then every 240 frames, 6 rounds max) renders the IDENTICAL lastRecords
set twice into two offscreen BGRA8 textures (same pipeline + bind
groups as the on-screen echo), copies both to MapRead buffers
(bytesPerRow 256-aligned), maps them async
(WGPUCallbackMode_AllowSpontaneous), and byte-compares row-by-row
(skipping row padding). Verdict logs as
`[d3] WebGPU DETERMINISM round N: IDENTICAL [WxH, S surfaces]` (or
`X px differ (p%), maxDelta=D`) and accumulates in
`window.__d3WgpuDet`. If a GPU produces different bytes for identical
command buffers, that's exactly the chunky-tile class of
non-determinism. Chrome verified: rounds 1-2 IDENTICAL, 64 surfaces,
600x600.

**RESULT (2026-06-09, physical iPhone): rounds 1-2 IDENTICAL
[448x448, 64 surfaces]** while the GL view on the same device showed
the chunky-tile flicker (quantified in earlier sessions at 1-7% px
divergence on a stationary scene). Identical input → identical output
through WebGPU on the same Metal driver where GL diverges. The
chunky-tile bug is conclusively a GL→GL4ES→WebGL→Metal stack defect;
completing the WebGPU port is the production fix. (The multi-surface
echo also rendered on iPhone: `records=43` upload logged, lit
green-checker geometry tracking the camera.)

**Iter 7b/7c — REAL textures + the missing-falloff pak find
(2026-06-09).** The echo now renders the actual game scene:
- Engine image pipeline: `D3_WebGPU_CacheImage` (tr_render.cpp,
  called from `GenerateImage` pre-rxgb-swap, with image names,
  nearest-downsample >256) → per-idImage GPU texture cache → material
  bind groups cached per 5-image tuple. `interaction.wgsl` bindings
  split: @group(0) per-record uniforms, @group(1) material textures.
- Record cap 256 (drops counted+logged), accumulators 8MB/2MB.
  Subview records filtered out via viewDef tag (monitors/mirrors
  render first with alien projections — would ghost).
- z-fill pre-pass pipeline exists but is DISABLED (kUsePrePass=false):
  cross-pipeline clip-z invariance unverified; lit pass is additive
  One/One with depthWrite ON as interim (slight light bleed possible
  on unsorted overlaps).
- **THE BIG FIND: `makeintensity(lights/squarelight1a)` — the falloff
  for nearly every point light — was MISSING from the reduced pak.**
  The engine substituted a black default → falloff multiplied every
  interaction to ~0 → most point lights have been silently OFF in
  the GL build all along (flashlight + emissives did the lighting,
  which is part of why the game read so dark). Bisected with shader
  probes (R=falloff/G=NdotL/B=cookie, then fixed-coordinate content
  probe, then a named per-image cache inventory). Fixed by injecting
  all 53 missing `lights/*.tga` into the bundled pak and adding
  `lights/` to the reducer's ALWAYS_KEEP_PREFIXES. **GL is visibly
  better lit too.**
- `interaction.wgsl` falloff now multiplies the sample's RGB (vanilla
  interaction.vfp convention); `.a` was a GL4ES-on-WebKit artifact.
  Normal maps decode from RGB (cache is pre-rxgb-swap). depth.wgsl
  carries the same clip-z remap as interaction.wgsl (must stay
  bit-identical for the future pre-pass).
- Verified headed Chrome: echo shows the real corridor (floor grate,
  walls, fixtures, real lighting); determinism self-test IDENTICAL
  with 256 surfaces + real textures.

**Device check #2 (2026-06-09 evening, real iPhone): the real-content
echo HOLDS STEADY exactly where GL flickers** — the eyeball A/B is
confirmed with actual content (the earlier black-canvas version was
vacuous). Chunky-tile conclusion final: visual + byte-level, same
device.

**Iter 8a — the green/untextured echo, root-caused (2026-06-09).**
User reported the echo green-tinted and seemingly untextured. Cause:
the CPU image cache capped at 512 slots; a full level loads far more
images, so most level textures never got cached and every miss fell
back to the GREEN CHECKER diffuse (the tint) or WHITE falloff (lights
reaching infinitely — the washes). A per-slot miss logger
(`matGroup MISS bump=..`) showed 123 affected tuples. Fix: CPU cache
512 → 2048, GPU texture cache → 2048, material groups → 1024. Misses
now 0; headed Chrome echo matches GL tones (dark rock, catwalk, warm
fixtures, viewmodel hands). Also added fidelity params (uniforms
192 → 224B): ambient-light flag (N·L=1, no spec), vertex-color
modulate/add (SVC modes), r_brightness + 1/r_gamma per pass (matches
r_gammaInShader), specular-map doubling. The probe methodology that
cracked it: paint suspected term as color channels → fixed-coordinate
content probe → named per-image cache inventory → per-slot miss
logger. "GL not better lit" from the same report is likely positional
(the catwalk-area lights use falloffs that were already in the pak);
the new pak is confirmed live (deployed pak central directory contains
all 53 lights/*.tga; boot line reads "62.8 MB" vs old "61.7 MB").
**Iter 8a confirmed on device: "Echo box looks good!"**

**Iter 8b — z pre-pass enabled via shared-VS invariance (2026-06-09).**
The earlier pre-pass black-screen was cross-pipeline clip-z
non-invariance: depth.wgsl's separately-compiled position math
differed from interaction.wgsl's by enough to fail LessEqual
everywhere. Fix: build the depth pipeline from interaction.wgsl's
vs_main — the SAME module and entry point as the lit pipeline
(fragment=nullptr, no color targets) — making clip positions
bit-identical by construction. kUsePrePass=true: the echo has proper
inter-surface occlusion (z-fill writes depth; additive lit pass tests
LessEqual with depth writes off). Headed Chrome: crisper, correctly
layered, matches GL depth structure; determinism IDENTICAL with both
passes. Lesson for the full port: any multi-pass depth-dependent
rendering must share the position-computing VS across pipelines (the
WebGPU equivalent of GL's ARB_position_invariant).

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

**Iter 8c — emissive/shader-pass surfaces in the echo (2026-06-09).**
`D3_WebGPU_CapturePassStage` (tr_render.cpp, called from
draw_common.cpp's old-stage path before each stage draw) captures plain
explicit-texcoord stages — emissive lamps, screens, decals — into
`g_passRecords` (Rec reused: diffuseColor = stage color, pad1 = blend
kind 1/2/3 = opaque/additive/alpha, pad2 = SVC). Backend draws them
after the lit records via three texture.wgsl pipeline variants on an
EXPLICIT shared pipeline layout. **Dawn gotcha: default (auto)
pipeline layouts are pipeline-unique — a bind group built from one
pipeline's getBindGroupLayout() is INVALID on another pipeline even
with identical WGSL bindings; sharing requires an explicit
BindGroupLayout + PipelineLayout** (first build black-screened on this
validation error; the error-capture Playwright script found it
instantly). texture.wgsl gained a params vec4 (SVC modulate/add);
demo-quad uniform grew 80→96B to match. Headed Chrome: doorway glow,
screens, fixture emissives visible; validation clean; determinism
IDENTICAL.

**Iter 8d — 2D HUD/GUI overlay in the echo (2026-06-09).** 2D GUI
views are recognized by `viewEntitys == NULL` in the capture hook
(bypassing the lightgem viewport filter), tagged pad3=1, drained in a
second sweep after the main view's 3D pass records, and drawn last
through texture.wgsl variants with depth compare Always (guiAlpha /
guiAdditive). HUD health counter visible in the echo, matching GL.

**WebGPU port status snapshot (end of 2026-06-09):** echo = z pre-pass
(shared-VS invariant) + additive lit pass (256 interactions, real
textures, ambient/SVC/gamma params) + emissive shader passes
(opaque/additive/alpha) + 2D HUD overlay, all determinism-self-tested
IDENTICAL on-device. Remaining for full cutover (iter 9+): stencil
shadow volumes (per-light passes over Depth24PlusStencil8, capture
RB_T_Shadow shadow-cache vec4 geometry, two-sided stencil ops, light
grouping/ordering), specular LUT fidelity, translucency ordering,
post-process/2D effects, then default r_backend=webgpu and retire
GL4ES. The echo's capture+replay architecture and the headed-Chrome +
det-self-test verification loop carry over directly.

**Iter 9 — stencil shadow volumes (2026-06-09).** Full echo of idTech4
stencil shadows: `D3_WebGPU_CaptureShadow` (from RB_T_Shadow) captures
vec4 shadow-cache verts + per-light grouping (g_capLightId bumps per
vLight; Rec gained lightId — three struct mirrors). shadow.wgsl
replicates the stencil-shadow VP (w==0 verts project to infinity away
from the light). Backend: Depth24PlusStencil8 everywhere; frame =
pre-pass → ONE PASS PER LIGHT (stencilLoadOp Clear 128 → volumes
incr/decr via z-fail or depth-pass pipelines → interactions with
stencil GreaterEqual ref 128) → final emissive/HUD pass. Verified with
+set r_shadows 1 in headed Chrome: echo mirrors GL's shadowed regions,
zero validation errors, det IDENTICAL. App profile keeps r_shadows 0
(perf) so behavior matches GL either way. SECOND DAWN LESSON: pipelines
must declare pass-compatible COLOR targets even when writing only
stencil (fragment stage with writeMask=none, empty fs).

**Iter 10/10b — fidelity batch (2026-06-10).** Weapon/model depth hacks
baked into captured MVPs (viewmodel no longer clips); scrolling stage
textures (2x3 texture matrix from shader regs → texture.wgsl, pass
uniforms 96→128B); full box-filtered mip chains per cached texture
(kills minification shimmer); exact specular falloff via the engine's
baked specular table (captured globalImages->specularTableImage ptr →
group(1) binding 7, dependent read by NdotH). All validated: clean,
det IDENTICAL.

**CUTOVER PLAN (iter 11+, the remaining big chunk).** Today the engine
renders everything TWICE (GL fullscreen + WebGPU echo). To make WebGPU
primary: (1) promote #webgpuCanvas to fullscreen main canvas, retire
#gameCanvas + the WebGL context (keep GL fallback for non-WebGPU
browsers via r_backend); (2) stop GL draw execution — either stub
GL4ES (pragmatic; keep engine CPU-side vertex data the capture reads)
or route draw_arb2/draw_common through the RenderBackend abstraction
(clean); (3) persistent GPU vertex/index buffers keyed by
vertexCache handles instead of per-frame 8MB re-upload; (4) Resize()
+ device-lost handling; (5) flip r_backend default, drop the
fixFalloffSampling JS hot-patch (GL-only band-aid), eventually drop
GL4ES from the build. Still-missing renderer features: fog/blend
lights, skybox/reflection texgens, ARB new-stage effects (heat haze),
mirrors/monitors (subview filter), ROQ surfaces (also broken in GL).
Verification loop for all of it: headed Chrome (scripts in /tmp/d3-pw-*.mjs,
recreate from CLAUDE.md if gone) + the iter 6.8 determinism self-test +
iPhone as final gate.

**Iter 11a — `?wgpufull` cutover preview (2026-06-10).** With
`?backend=webgpu&wgpufull` the WebGPU canvas IS the fullscreen game
view (`.is-primary` takes the game-canvas CSS role; `#gameCanvas` goes
`.is-ghost` opacity-0 — NOT display:none, SDL keeps its context). The
engine still computes both paths; the player sees only WebGPU. This is
the flicker-free-on-iPhone experience ahead of the engine-side cutover
(stopping GL execution) described in the iter 11+ plan above.

**Iter 11b — r_skipGLDraw (2026-06-10).** `?wgpufull` now also sets
`r_skipGLDraw 1`: the GL draw calls (RB_DrawElements*,
RB_DrawShadowElements*, CopyFramebuffer) early-return — captures run in
the callers first, so the WebGPU echo is unaffected. Lightgem exception
(<128px views keep drawing — gameplay reads its pixels for the player
light level). Verified: GL canvas 0.0% non-black with skip forced,
runtime cvar "1" under wgpufull, det IDENTICAL. The "Invalid copy
texture format combination" console spam is pre-existing GL4ES-internal
swap noise, NOT engine copies. Remaining GL-side per-frame cost: state
calls + vertexCache uploads + lightgem. Next cutover steps: persistent
WebGPU vertex buffers, resize/device-lost, r_backend default flip,
GL4ES retirement; missing features per the iter 11+ plan above.

**Touch-look (2026-06-10).** Dragging the right ~55% of the screen aims
via `engine.callAddViewAngles` (same hook as head tracking; deltas
add). dyaw = -dx*sens, dpitch = dy*sens (idTech: yaw+ = left, pitch+ =
down, engine clamps ±89). Button/diag/left-side touches ignored;
preventDefault during the drag kills Safari scroll-bounce.
`?looksens=<deg/px>` tunes (default 0.25).

**Iter 12a/12b (2026-06-10).** (a) WebGPU-primary is the DEFAULT for
`?backend=webgpu` — fullscreen WebGPU view + r_skipGLDraw 1; `&echo`
restores the side-by-side debug layout. WebGPU device.lost surfaces to
diag/console with a reload instruction. Persistent-vertex-buffer perf
item DEPRIORITIZED: uploads are ~0.6MB/frame at ~7fps (trivial); the
WASM game loop is the bottleneck. (b) Fog lights: RB_T_BasicFog
captures per-record localized fog planes + the two global fog images;
fog.wgsl blends fogColor with alpha = fogRamp(s0).a * enterRamp(s1,t1).a
at the start of the final pass. Touch-look also landed today (drag the
right side to aim; ?looksens= tunes).

**Honest remaining list (iter 13+):** blend lights (RB_T_BlendLight —
rarer cousin of fog), skybox/reflection texgens (needs cubemap capture:
GenerateCubeImage is NOT hooked into the CPU image cache), ARB
new-stage effects (heat haze), subviews/mirrors/monitors (needs
render-to-texture echo architecture), lightgem via WebGPU (so GL can
fully retire), GL4ES build retirement, ROQ video (broken in GL too).
