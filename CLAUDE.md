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
- **Flashlight** — default OFF since iter 37 (native parity: vanilla dhewm3 never
  auto-raises it, and its point-blank glare was the last visible lighting gap vs
  native — corridor luma 30.8 with it on vs native 23.0). Toggled by a long pinch
  or by tapping the always-visible flashlight chip; `config.autoFlashlight` remains
  for profiles that want the old behavior. Its view-model effect surfaces (`beam1`/`flare`/`flare2`/
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

**PK4 stall fix (2026-06-10).** "Downloading PK4 stalled for 20s" on
cellular: the 65MB pak re-downloaded EVERY boot with a 20s no-progress
watchdog + 120s overall cap. Now: the bundled PK4 caches in IndexedDB
after the first successful download (all six fetch paths feed the
cache via finish()); next boots load locally. Freshness = 4s HEAD
comparing content-length; HEAD failure → trust the cache (offline-
friendly); pak-size change in a deploy → auto re-download. Watchdog
45s, overall 420s. Verified: boot 2 logs "Using cached bundled PK4"
with zero pak network traffic.

**Iter 13a — blend lights (2026-06-10).** RB_T_BlendLight captures
localized S/T/Q+falloff planes per surface; RB_BlendLight's stage loop
exports the projection image + blend kind. blend.wgsl =
projTex(s/q,t/q) * falloff(sF,.5) * stageColor through blendFilter
(Dst/Zero) or blendAdd (One/One) pipelines, final pass after fog.
LIGHT-TYPE COVERAGE NOW COMPLETE: point/projected interactions,
ambient, fog, blend. Remaining big-architecture items: sky cubemaps
(GenerateCubeImage cache hook + samplerCube path), subviews
(render-to-texture), lightgem via WebGPU, GL4ES retirement, heat-haze
new-stages, ROQ.

**PK4 chunked delivery (2026-06-10).** Second cellular stall proved a
65MB single download can't finish on weak links (no resume — retries
restart from 0). The pak now ALSO ships as 16x4MB chunks + manifest
(`scripts/chunk-pk4.py` — RERUN IT WHENEVER THE PAK CHANGES, then
force-add the chunks; they're gitignore-excepted like the pak). The
runtime prefers the manifest; each chunk gets its own stall window +
retries AND caches individually in IndexedDB for cross-reload resume
(entries dropped once the assembled pak caches whole).

**Iter 13b — sky cube stages (2026-06-10).** R_Skybox/WobbleskyTexGen
stash their CPU-computed per-vertex cube dirs (8-entry ring, surf ptr +
tr.frameCount validated — frame-temp ptrs recycle); pass-stage capture
accepts SKYBOX/WOBBLESKY texgens, dirs ride a parallel vec3 vertex
stream (record sPad1 = offset, pad3 = 2). GenerateCubeImage feeds a
6-face CPU cube cache → 6-layer texture + Cube view. sky.wgsl samples
along the interpolated dir; drawn first in the final pass, opaque +
depth-tested. Wobble rotation comes free (engine computed it).
TEXGEN COVERAGE: explicit ✓ sky ✓ wobblesky ✓; reflect/screen still
unsupported. Remaining big items: subviews (render-to-texture),
lightgem via WebGPU, GL4ES retirement, heat-haze, ROQ.

**640px + Iter 14 subviews (2026-06-10).** Render res bumped 448→640
when WebGPU-primary (the GL-era GPU-pressure cap doesn't bind; ?lowres
restores, ?render2x/4x still scale). Subview render-to-texture: the
gated CopyFramebuffer records (image, subview viewDef) links; drained
records partition into main + per-link slot ranges; linked groups
render into 256px offscreen targets (z-fill + lit) before the main
passes; getEngineTextureView overrides linked images with the live
target. Monitors/mirrors now show live WebGPU subview renders.
ECHO FEATURE SET COMPLETE for the demo's scope. Remaining niche:
lightgem via WebGPU + GL4ES build retirement (the true finish line),
reflect/screen texgens, heat-haze new-stages, ROQ.

**GL4ES retention decision + audio investigation (2026-06-10).**
GL4ES STAYS: it's the required fallback for non-WebGPU browsers, the
`&echo` mode is the permanent A/B comparison harness, and the lightgem
renders through it. "Retirement" demoted to someday-maybe.
AUDIO: compiled in but traps at boot when enabled. `?audio` flag wired
(opt-in, default off) + `com_asyncSound 0` + `s_useEAXReverb 0` — still
traps with "null function" during sound init AFTER the EFX cvar is off,
so the null pointer is in the device/backend path (likely an
Emscripten-OpenAL gap or a patch-era stub), NOT the reverb procs.
Next audio session: rebuild with `--profiling-funcs` for a named WASM
stack trace (same method that cracked the ROQ null-pointer crash),
then stub/guard the offending call. Boot logs to reproduce:
`?backend=webgpu&audio` → "Starting DOOM 3 main..." → trap.

**LIVE OUTAGE post-mortem — CI emsdk "latest" (2026-06-10).** The
worst incident so far: WebGPU-primary boots on the LIVE site trapped
with "null function" at startup while the same source booted clean
locally. Two red herrings burned hours: (1) an audio commit that set
`com_asyncSound 0` + `s_useEAXReverb 0` UNCONDITIONALLY — touching
sound cvars on a muted boot also traps, hotfixed to apply only with
`?audio`; (2) after that hotfix live STILL trapped. URL-flag bisect on
live (`&echo` boots, WebGPU-primary traps) + a CLEAN local rebuild
(rm CMakeFiles, full make — boots fine) isolated it to **toolchain
divergence: CI installed emsdk "latest" while local builds used
6.0.0.** Fix: `.github/workflows/deploy-pages.yml` pins
`emsdk install/activate 6.0.0`. Verified recovered on live: full boot,
det self-test rounds 1-3 IDENTICAL (640px, 256 surfaces), correct
scene render, iter 15a/15b confirmed in the same deploy.
LESSONS: (a) PIN THE TOOLCHAIN — a floating emsdk means CI binaries
diverge from every local repro; (b) GitHub Pages serves
cache-control max-age=600 — a "still failing" read within ~10 min of
a deploy may be the CDN, wait out the TTL before concluding; (c) a
40s Playwright wait is too short for a fresh-profile boot (16-chunk
pak download) — wait on explicit verdict lines ("DOOM 3 main
started" vs trap regex) with a 180s deadline, not a fixed sleep;
(d) never touch sound state on muted boots; re-validate a NORMAL
boot after wiring any experimental flag.

**AUDIO ROOT CAUSE FOUND — ParseCommandLine buffer overflow
(2026-06-10).** The "?audio traps with null function" bug (and the
sound-cvar half of the live outage) was never OpenAL: **idTech4's
`ParseCommandLine` has NO bounds check on `com_consoleLines[32]`**,
and the web shell's arg list sits at EXACTLY 32 "+" commands (31 +set
+ 1 +map). The two audio cvars made 34 → the overflow stomped the
globals after the array (each idCmdArgs is multi-KB) → the FIRST
`Printf` (version banner) trapped at `console->Print` (a call_indirect
through the clobbered console object). Method: `-DD3_PROFILING_FUNCS=ON`
(new CMake option, relink-only) gave a NAMED trap stack
(`idCommonLocal::VPrintf ← Printf ← Init`); Sys_Printf markers between
VPrintf's four indirect call sites pinpointed `console->Print`; the
printed message being the FIRST banner + "+2 args breaks it" gave the
overflow. Boot errors now also log `error.stack` to the boot log
(named wasm frames on-device when built with profiling).
Engine fix (in the patch): MAX_CONSOLE_LINES 32→64 AND a proper
bounds check (over-limit "+cmd" warns + drops, its argument tokens
drop with it — appending them to the previous command would corrupt
it). Verified: `?audio` boots clean (OpenAL device up, map loads),
muted boot unregressed. The earlier "never touch sound cvars on muted
boots" lesson is RETRACTED — any 2 extra args would have trapped.
`?audio` stays opt-in: the reduced pak strips `sound/`, so everything
plays the engine-default beep — shipping real audio = pak-reducer
scope (add sound/ subset), not engine work.

**ROQ NULL-FUNCTION ROOT CAUSE + FIX (2026-06-10).** The crash that
forced `r_skipROQ 1` is solved. Named stack (profiling build):
`RoQInterrupt ← ImageForTime ← idMaterial::UpdateCinematic ←
idWindow::StateChanged/Trigger` — a GUI screen triggering its video.
Chain: the reduced pak strips `video/`, so `InitFromFile` fails and
leaves `iFile = NULL`… but `ResetTime()` later sets `status = FMV_PLAY`
UNCONDITIONALLY, and `ImageForTime` then pumps `RoQInterrupt()`, whose
first act is `iFile->Read(...)` — a virtual call through NULL. Under
WASM a null deref doesn't fault (address 0 is valid linear memory), so
the garbage vtable load surfaces as "null function". Fixes (in the
patch): (1) `ImageForTime` parks the cinematic FMV_IDLE when `iFile`
is NULL; (2) `RoQInterrupt` entry guard; (3) the `while(buf==NULL)`
pump now also checks `status == FMV_PLAY` (it could spin forever).
Verified: `?args=%2Bset%20r_skipROQ%200` boots + full camera spin with
NO trap on the stripped pak, AND on a local test pak with the real
`video/marscity/*.RoQ` files injected the decoder runs clean (GUI
triggers fire, no trap, no decode errors). r_skipROQ stays 1 by
default for now (videos aren't in the shipped pak; flipping it buys
nothing until they are) — but it is now SAFE to turn off, and real
playback is one pak-reducer change away (include `video/` subset,
~12MB for the marscity set). The GOG installer extraction recipe for
testing: `innoextract --include "base/pak003.pk4" setup_doom_3*.exe`
(marscity videos live in pak003; sounds for the future ?audio work
live in pak001/pak004 as .ogg).

**Pak reducer: audio + video dependency resolution (2026-06-10).**
Two long-standing gaps closed in `reduce-d3-map-pk4.py`:
(1) `.sndshd` bodies were kept as text but never INDEXED, and entities
reference sound shaders by bare name (no slash, so `tokens()` filters
them out) — the closure could never reach a single `sound/*` sample
file. Audio "kept by default" was actually shipping EMPTY. Now sound
shaders index name → sample paths (like materials) and resolve through
the def-graph closure. (2) `.roq` wasn't in any keep-extension set —
new `--keep-video` flag keeps referenced cinematics.
MEASURED on the full GOG data (`innoextract`, /tmp/d3gog/base):
baseline (--no-audio) 65.6 MB == current shipped pak;
+audio (11kHz mono wav, ogg as-is) 75.4 MB (+9.8);
+audio+video 95.2 MB (+29.6). The mars_city1 GUI monitors reference
exactly TWO videos — `sound/vo/video/video_ipn_news.roq` +
`video_uac_welcome.roq` (24.6 MB together; id parked VO-composite
videos under sound/, NOT video/ — video/marscity/* is the skipped
intro cinematic). SHIPPING IS A PRODUCT CALL (pak size vs content on
cellular) — not committed. Also note: cinematic frames upload via
`UploadScratch`, NOT GenerateImage, so the WebGPU capture path does
NOT display videos yet — shipping videos needs the WebGPU
dynamic-texture feature first (per-record scratch frames; the shared
cinematicImage scratch breaks capture-replay when 2+ monitors are in
view). GL paths (&echo, fallback) play them fine — decode verified
clean with the real monitor videos injected locally.

**Iter 16 — HEAT HAZE / _currentRender post-process (2026-06-10).**
The effect r_skipPostProcess had to disable for GL (WebKit blit storm)
now runs WebGPU-native: `D3_WebGPU_CaptureNewStage` (called from the
newStage branch in RB_STD_T_RenderShaderPasses) captures heatHaze*.vfp
stages — program identified via the new `D3_ARB2_ProgramName` reverse
lookup in draw_arb2 — with evaluated vertexParms (scroll, magnitude),
projection m00, variant flags (mask / vertex-color), and the
normal+mask image ptrs. haze.wgsl replicates the ARB math: deflection
= min(m00/max(clipW,1), .02)×magnitude, offset = RGB-normal(*2-1)
× (mask[*vc]−.01) × deflection, sample a CANVAS COPY at
saturate(screenUV+offset) (half-texel inset — shared REPEAT sampler).
Frame restructure: final pass splits in two around ONE
copyTextureToTexture (canvas → currentRenderTex; surface usage now
includes CopySrc) — part A = sky/reflect/fog/blend/3D passes, part B =
haze + GUI (drain orders pass records [3D...,GUI...] so the split
preserves order). r_skipPostProcess now boots 0 under WebGPU-primary
(GL keeps 1; its draws/copies stay gated by r_skipGLDraw).
HARD-WON BRING-UP LESSONS:
- Haze records need DEDICATED accumulators (256KB/64KB): post-process
  surfaces draw LAST, when the shared 8MB accumulator is exhausted —
  captures silently cap-dropped for hours.
- `extern` (without "C") on an extern-"C" function inside a function
  body links a MANGLED stub under -sERROR_ON_UNDEFINED_SYMBOLS=0 that
  aborts mid-draw when called ("missing function" in __d3Logs).
- mars_city1 spawn has NO main-view haze: the only nearby heatHaze
  surface (glass1 window) lives inside a security-camera SUBVIEW
  (vw=255 in the capture trace). Verification teleport:
  `setviewpos -3450 -1536 276 0` faces a real glass1 pane (found via
  .proc surface scan → func_static_52992 origin in the .map).
- TWO GL-parity capture bugs found en route: (1) maskcolor/makealpha
  stages (GLS_COLORMASK all masked — alpha-prime for gl_dst_alpha)
  painted OPAQUE blocks — now skipped; (2) translucent dst-alpha
  REFLECT stages (glass cubemaps) drew opaque black through the
  iter-15b reflect path — reflect capture now requires opaque blend.
  Plus: `blend filter` (gl_dst_color,gl_zero) pass stages now get a
  real passFilterPipeline (Dst/Zero) instead of additive fallback.
VERIFIED: haze active (4 surfaces) at the glass pane, suv/raster math
confirmed via shader probe, zero validation errors, det rounds
IDENTICAL, spawn scene unchanged. Visual fidelity eyeball at a
haze-rich location (dropship pad vents) = on-device follow-up; the
glass-pane vantage is record-cap-starved (256) and not representative.

**Iter 17 — cinematic (ROQ) textures in the WebGPU path (2026-06-10).**
GL uploads each decoded video frame into ONE shared scratch image
right before each draw (`RB_BindVariableStageImage` →
`cinematicImage->UploadScratch`) — capture-replay can't share that
(two monitors in view would both show the LAST upload). Now:
`D3_WebGPU_NoteCinematicFrame` (called right after UploadScratch, so
the same stage's pass capture — 11 lines later in the stage loop —
consumes it) copies the decoded RGBA frame into a 4-slot ring
(512px cap/slot); the pass record carries slot+1 in sPad3; the
backend uploads the slots to per-slot RGBA8 dynamic textures via
writeTexture at drain time and binds them through per-frame transient
bind groups (released at the NEXT drain, after the submit completed).
No decoded frame pending → the stage is skipped, matching GL's
blackImage bind (the small TEAL squares seen in screenshots = video
GUI surfaces' backcolor showing through — pre-existing, now
explained). One-shot log when live: "[d3] WebGPU cinematic frame
bound: WxH".
STATUS: implemented + runs clean with the real monitor videos in a
local test pak (no validation errors, det IDENTICAL, normal scenes
unchanged). The bind-path has NOT yet fired in a test: mars_city1's
looping video (the hanging IPN monitor, entity tim_func_mover_1 at
-2789 -1247 233) defeated four setviewpos framing attempts (pillars/
ducts), the welcome-kiosk movie (gui2, entity func_static_5074) is
script-triggered and idle at boot, and the receptionist's IPN screen
triggers during gameplay. VERIFY ON-DEVICE/GAMEPLAY: with videos in
the pak + r_skipROQ 0, walk to the reception desk — the console
should print "cinematic frame bound" and the desk screen should show
moving IPN news. Note videomap decls reference "sound/VO/video/..."
(uppercase VO — engine FS is case-insensitive, zip entries lowercase).

**Iter 18 — HUD teal quads + floating video quads + heavy-scene black
surfaces (2026-06-10, from on-device report).** Three root causes:
(1) HUD elements drew as flat mint/teal quads: the 2048-slot CPU image
cache silently OVERFLOWED on a full playthrough — HUD/GUI images load
LAZILY at first draw, AFTER the level's textures, so they were the
casualties (white-fallback texture × stage tint = flat quad). Cache →
3072 + a one-shot console warning when full; new
`noteImageFallback`/`D3_WebGPU_ImageName` logging names every image
that resolves to a fallback ("[d3] WebGPU image FALLBACK (why): name")
— the instrument that cracked this in one run.
(2) Floating teal quads on video screens: frameless cinematic stages
were SKIPPED, letting the GUI backcolor show; GL binds blackImage and
DRAWS. Now captured with blackImage (GL parity).
(3) Black boxes/characters in heavy scenes (underground): record-cap
starvation — surfaces whose interactions were dropped at the 256 cap
rendered black (in the prepass via one captured light, lit by none).
Caps: records 256→512, vert accum 8→16MB, index 2→4MB (mirror
kMaxRecordSlots in the backend!). Verified: zero fallbacks at the
reported area, correct bordered HUD, no validation errors.
`?shadows` flag added: stencil shadows (iter 9) are implemented but
default-off for perf — flag enables for on-device A/B.

**Iter 19 — BLOOM + shadows-on-by-default (2026-06-10).** Vanilla
dhewm3 has NO bloom (the PC reference shots with glowing emissives are
RBDOOM-3-BFG-class builds) — added WebGPU-native: canvas copy →
quarter-res bright pass (soft-knee threshold) → separable 9-tap
Gaussian (H+V ping-pong) → additive fullscreen composite, all
bufferless fullscreen triangles (vertex_index), one shared BGL, no
depth. Final pass restructure: the GUI overlay now ALWAYS draws in its
own pass after post-FX when haze or bloom is active (post-FX must not
bloom/warp the HUD). Tunables are LIVE on-device: cvars r_bloom /
r_bloomThreshold (0.5) / r_bloomScale (1.25) exported to the backend
per view via RB_BeginDrawingView globals (the backend has no cvar
access by design) — d3cmd("r_bloomThreshold 0.4") etc. Defaults: ON
under WebGPU-primary, ?nobloom opts out. STENCIL SHADOWS now also ON
by default under WebGPU-primary (user direction); ?noshadows opts out.
Verified headed Chrome: glow on fixtures/doorways, live tuning works,
r_bloom 0 kills it clean, zero validation errors, A/B quantified
(bright-region mean delta 6.4 at default, 2.4% px >10 at strong).
GL-PARITY NOTE on "black materials": the spawn-area black crate is
near-black in GL TOO (dark material + vanilla's dark lighting, no
working gamma) — the PC reference's visible version comes from
RBDOOM's HDR pipeline, not something our port lost.

**Iter 20 — FX slider panel + desktop mouse-look + shadow diagnostics
(2026-06-10).** "fx" button (top right, under copy/show log) opens a
panel of live sliders — bloom scale, bloom threshold, gamma,
brightness — each slider runs the cvar through d3cmd next frame (no
rebuild; works on-device). Desktop click-drag on the right 55% of the
screen aims (mirrors touch-look; no pointer lock so the cursor stays
for the UI; verified 32% px view change per drag). One-shot
"[d3] WebGPU stencil shadows active: N volumes" log confirms the
shadow path (spawn: 11 volumes; r_shadows on/off A/B = 1.4% px —
WORKING but subtle: vanilla stencil shadows in dim scenes; the X360
look is the same tech + brighter lighting calibration, hence the
gamma/brightness sliders). Shadow-upgrade research (exa, 150 sources):
The Dark Mod ships switchable stencil/maps (gold standard), fhDOOM +
RBDOOM-3-BFG do PCF shadow mapping (12-tap Poisson; coexists with
stencil via r_useShadowMapping); cheapest quality win for OUR backend
= screen-space shadow-mask blur (render stencil result to a mask
texture, bilateral blur, modulate — one fullscreen pass on existing
volumes), full shadow mapping = new depth-pass architecture (capture
per-light depth renders; texture_depth_2d + sampler_comparison +
textureSampleCompare in WGSL; point lights need 6 faces) — feasible
but a multi-session feature.

**Texture-resolution measurement (2026-06-10).** Question: can we
recover texture detail (pak is baked --max-texture 128)? Measured
with new cache-RAM accounting (`D3_WebGPU_ReportImageCache`, logs
"[d3] WebGPU CPU image cache: N slots, X MB" ~300 frames after
records flow):
- 128px pak (shipped): 65.6 MB download, 77.5 MB cache RAM, baseline
- 256px pak: 115.7 MB (+76%), 212.5 MB cache RAM, +8.4% detail energy
- 512px pak: 159.8 MB (+144%), cache est. >600 MB — NOT viable (wasm
  initial 512MB; iOS Safari memory budget)
iPhone note: the wearable profile's image_downSizeLimit 128 means the
256 pak alone only costs download size there — seeing 256px textures
on-device additionally needs ?dsl=256 (cache → ~212MB; device test
required before defaulting).
**CRITICAL REDUCER GOTCHA found en route: the GOG 1.3.1 installer's
pak005–008 are the PATCH paks (updated scripts/defs) — a bake from
pak000–004 alone BOOTS but the game aborts at spawn with "ERROR:
Missing 'WEAPON_NETFIRING' field in script object 'weapon_fists'"
(1.1-era scripts vs dhewm3's 1.3.1 expectation) and the WebGPU view
shows the demo-quad checker (zero records). ALWAYS include all 9 paks
in the reducer input.** Shipping the 256 pak = user product call
(cellular download cost); rebuild recipe: reduce from /tmp/d3gog/base
(9 paks) --max-texture 256 --no-audio **--jpeg-textures** (iter 54:
-22%/-29% via JPEG color textures), then scripts/chunk-pk4.py, then
`rm` stale chunks beyond the new count before force-adding.

**Iter 21 — capture-gate fix, repeat-aware light sampler, X360 hunt
notes (2026-06-10).** (1) REAL BUG FIXED: draw_arb2.cpp's capture-gate
mirrors (kWGPUMaxRec/kWGPUVertCap/kWGPUIdxCap) were never raised with
the others — interactions stayed capped at 256/8MB through TWO
"cap raises" (the THREE-WAY mirror: tr_render enums + draw_arb2 enums
+ backend kMaxRecordSlots — grep ALL THREE). Now 512/24MB/6MB
everywhere. (2) kMaxRecordSlots=1024 BREAKS record flow entirely
(zero captures, demo checker; pipelines+slots init fine — cause
unknown, bisected and reverted to 512; investigate before raising
again). (3) Light-projection samplers now honor the image's repeat
mode (slot.repeat captured from idImage): repeat-mode projections get
the wrap sampler — note light materials parse stages with
TR_CLAMP_TO_ZERO by default, so most cookies keep clamp (WebGPU has
no border color; edge-black cookies are equivalent).
OPEN — THE BLACK-CHARACTER DEFECT (X360-look blocker): at
`setviewpos 1090 -1430 68 140` (hangar crates, the X360 reference
vantage) the marine NPC renders PITCH BLACK in WebGPU but shows lit
face/shoulders in GL (&echo) — independent of shadows (?noshadows
same), caps (512 fix didn't change it), lightScale (4 doesn't lift
him), and time (black from spawn). The hangar floor also lacks the
X360's cool mottled pool (lights/cloudscroll2, a scrolling
'translate time*.03' projection from light_5253 at z=-172). NEXT
SESSION: r_singleLight sweep at that vantage in BOTH paths to find
which light lights him in GL and what it produces in WebGPU; check
ambient-light records (cloudscroll might be an ambientLight); check
falloff for lights with origin BELOW the surface.

**Iter 22 — the "black character defect" RETIRED + X360 calibration
baked (2026-06-10).** The r_singleLight hunt concluded: there is NO
WebGPU character-lighting defect. Quantified at the X360 vantage
(identical camera, regional luma): GL marine 1.37 / WebGPU 2.35 —
WebGPU is BRIGHTER in every region (crate 20.2/24.1, floor
21.6/25.7). The marine is near-black in BOTH paths: vanilla data
leaves him outside the light pools; the X360 shot's visible marine is
its global presentation lift. (Earlier "lit in GL" reads were a few
specular pixels + contrast illusion — REGION MEANS, not eyeballs, for
dark-scene comparisons.) Cap theories also dead: this vantage runs
~107 records (512+ is ample); the steady "34 dropped" are structural
per-surface skips (>8192-vert surfaces etc.), CONSTANT vs cap size.
Hunt tooling kept: `r_wgpuSingleLight N` draws only the Nth light of
the frame (frame-relative — g_capLightId grows monotonically across
frames!); `1000+N` = prefix mode (lights 0..N) for bisecting. Records
cap now 896 ALL THREE mirrors (1024 still breaks record flow —
unsolved; do not raise past 896 without solving it).
CALIBRATION BAKED (the X360 recipe, measured): r_lightScale 2→4
(floor pool 25.7→71.0 luma ≈ the X360 pools) + r_gamma 1.1→1.3 (lifts
the data's genuinely-dark zones incl. characters). fx sliders synced
to the new defaults. Result at the X360 vantage: lit crate + readable
decals + visible marine + floor pools — the closest match yet.

**Iter 23 — Quest-style visible shadows (r_shadowDarken, 2026-06-10).**
Exa research on Doom3Quest (DrBeef / d3es-multithread lineage)
concluded its "lighting model" IS vanilla idTech4: same interaction
math (their analytic specular `clamp((NdotH-.75)*4)^2` is the function
our exact LUT encodes), same stencil z-fail volumes (Quest 3 ships
them ON). Their shadows READ because strong stencil shadows composite
over a punchy output curve. Ours read poorly because vanilla stencil
only masks EACH LIGHT'S OWN contribution — in low-key scenes there is
little to subtract. NEW: after the per-light passes, the union of ALL
shadow volumes is re-marked in a fresh stencil (z-fail/z-pass per
record, clear 128) and a fullscreen Dst*Src multiply
(bloom.wgsl fs_darken, stencil NotEqual 128) darkens every shadowed
pixel by `r_shadowDarken` (default 0.6; 1.0 = vanilla-only; fx-panel
"shadow dark" slider). Not physically per-light, but it makes shadows
read like the X360/Quest builds independent of light energy. A/B at
the X360 vantage: 10.7% px darkened in geometric shadow shapes; det
self-test unaffected (pass is deterministic, runs in det rounds too).
Reuses bloom's module/BGL/fullscreen triangle — pipelines init
unconditionally so the pass works with r_bloom 0.

**Iter 24 — WASM PERF DEEP-DIVE: the busy-sleep (2026-06-10/11).**
CPU-profiled the engine (CDP Profiler on a -DD3_PROFILING_FUNCS=ON
build, headed Chrome): **~45% of ALL CPU time was clock reads** —
`Com_WaitForNextTicStart → Sys_SleepUntilPrecise → usleep/busy-loop`.
On WASM there is NO real sleep without ASYNCIFY: usleep AND the
precision loop both SPIN on emscripten_get_now (a wasm→JS crossing,
plus clock_time_get's BigInt conversions). First fix (no-op the
sleep) just moved the spin to the CALLER's tic-wait loop. REAL FIX:
the tic system's vsync branch (`nextTicTime = now` when vsynced at
~60Hz) is EXACTLY the browser situation — rAF IS vsync — but
GLimp_GetSwapInterval/GetDisplayRefresh don't report it on Emscripten,
so the engine fell into the wait path. Forced `vsynced60 = true`
under __EMSCRIPTEN__ in idCommonLocal::Frame.
RESULT: profile idle 24% → 46.3%, clock functions GONE from the top
list — the engine does identical work with ~HALF the CPU. Also:
Emscripten builds now compile **-O3 -msimd128** (was -O2, no SIMD;
Safari 16.4+ supports wasm SIMD). Det test IDENTICAL post-change.
Top remaining real costs (desktop): writeBuffer 4.4% (per-frame
uploads), R_CreateShadowVolume 3.5%, RB_ARB2_DrawInteraction 2.2%.
iPhone should gain the spin elimination + SIMD/O3 — re-test shadows
on-device (?shadows) after this lands; classic dhewm3 has NO
com_engineHz (that's RBDOOM), so tic-rate reduction isn't a lever
without deeper surgery.

**Iter 25 — PLAYER SHADOW validated + union-darken artifact fixed
(2026-06-11).** The user demanded on-Chrome validation of the player
shadow before any more on-device asks. FINDINGS: (1) the union-of-all-
volumes darken pass (iter 23) blanket-darkened regions whose occluded
light contributed nothing — giant moving blobs = the "improper
lighting" reports. NOW PLAYER-VOLUMES-ONLY (capture tags records
sPad3=1 when surf->space->entityDef suppresses surfaces in a view —
only the first-person body does); world/NPC shadows remain vanilla
per-light. (2) Player volumes verified captured (probe: ~16/600
volumes) and VISUALLY validated: feet-down view in a bright pool
shows a coherent dark player shadow that toggles with r_shadowDarken
(10.7% px, connected region). (3) VALIDATION METHODOLOGY hard-won:
screenshot A/B diffs in this game are POLLUTED by — scrolling light
textures (translate time), light flicker tables, viewmodel sway, AND
a slowly-settling camera after setviewpos (teleport, wait ~6s).
Freeze with `timescale 0.001` (g_stopTime STOPS THINK → cvar toggles
don't propagate!), settle first, and prefer feet-down vantages near
body-height lights (lights with origin BELOW the floor throw player
shadows at the CEILING — vantages matter). The X360-style shadow
spots come from body-height lights like light_5252 by the crates.
PHONE NOTE: "A problem repeatedly occurred" on iOS = Safari TAB
CRASH (memory), not slowness — memory diet is the open phone item.

**Iter 26 — iPhone memory diet (2026-06-11).** "A problem repeatedly
occurred" on iOS = Safari jetsam TAB CRASH on total memory.
INITIAL_MEMORY was 512MB — committed before the pak even downloaded,
half of a typical iOS tab budget gone up front. Now 256MB +
ALLOW_MEMORY_GROWTH (unchanged): measured steady-state wasm heap is
**307MB** with the full level loaded (grew once past 256). ~200MB
returned to iOS at boot. The diag's first line now also shows the live
wasm heap ("| wasm 307MB") via window.__d3HeapMB (HEAP8 added to
EXPORTED_RUNTIME_METHODS — HEAP views aren't exported by default).
With the build stamp + fps + heap on the first diag line, a single
phone screenshot now answers: which build, frozen-or-slow, and how
close to the memory cliff.

**Pak hosting gotcha (2026-06-11):** the commoutside pak (107MB)
EXCEEDS GitHub's 100MB per-file limit — the monolithic .pk4 no longer
ships in git; only the 4MB chunks + manifest do (the runtime always
preferred chunks). Cache freshness now keys off the manifest's
totalSize whenever the whole-pak HEAD fails — without that, repeat
visitors would trust a stale cached level forever after a level
switch.

**Level switch → game/enpro (2026-06-11, user request).** Campaign
level 9 (EnPro Plant). Pak: 57.4MB, 14 chunks (smaller than both
mars_city1 and commoutside). Stale chunks from the previous level
beyond .013 deleted — THE CHUNKER DOESN'T REMOVE OLD CHUNK FILES when
the count shrinks; always `ls` the chunk set after rechunking a
smaller pak or dead chunks ship in git.

**Iter 27 — iPhone crash hunt round 2 (2026-06-11).** Crash persists
("a few seconds after boot") despite the 256MB-initial diet. Two new
measures: (1) GL TEXTURE UPLOADS SKIPPED under r_skipGLDraw — every
texture was resident TWICE on the GPU (WebGL via GL4ES + WebGPU);
GenerateImage now frees the staging buffer and returns after the
CPU-cache hook + Bind() when WebGPU-primary (texture objects exist,
no storage allocated; &echo/GL-fallback boots upload normally).
Halves GPU texture residency. (2) CRASH TELEMETRY: the diag stats
line persists to localStorage every 2s with a clean-exit flag set on
pagehide; the next boot surfaces "⚠ previous session DIED: build … |
fps … | wasm …MB (Ns ago)" in the diag + console — every iOS tab
kill now leaves evidence instead of eating it. Verified locally:
renders identically with GL uploads skipped, heap 307MB.
SHELL GOTCHA that bit here: a `cd` into the engine build dir earlier
in a chain left cwd inside .build/dhewm3 — `git add -A && git commit`
then committed onto the ENGINE checkout's detached HEAD (recovered
via `git -C .build/dhewm3 reset HEAD~1`, files intact). Always run
repo git commands with absolute -C paths or cd first in the SAME
command.

**PATCH-GENERATION GOTCHA (2026-06-11, bit us hard):** the engine
patch is `git -C .build/dhewm3 diff <pinned>` — but the port's NEW
files (RenderBackend_WebGPU.cpp, wgsl/, d3_wearable.*) only appear in
that diff because they are STAGED in the engine checkout's index. Any
`git reset` there silently drops every new file from the next patch
regen (a 6105-line patch shrink pushed a build with NO WebGPU
backend). Regenerate with `git add -A` first and `diff --cached`, and
CHECK `wc -l` (~8500 lines) before committing the patch.

**Iter 28 — iPhone crash round 3: the memory autopsy + diet
(2026-06-11).** The user's pasted crash log (crash telemetry working
as designed) finally gave hard numbers at death: `fps 46.5 | wasm
307MB | gpu-tex: 86 uploads ~4MB … ⚠CTX-LOST | ERR:
InvalidStateError: GPUDevice.createBindGroup`. Reading: GL-upload
skip works (4MB), heap matches full-load (the map LOADED and rendered
seconds before death — "82%" just means no later milestone logged),
and BOTH GPU contexts died together = iOS reclaimed the tab's GPU
resources on TOTAL process memory, not a WebGL-specific OOM. Measured
on desktop Chrome: the WebGPU texture cache is only ~22MB (496
textures) — NOT the eater. Remaining suspects were WebKit-side
per-call overhead and total-process memory; all addressed:
- **GPU texture budget + dim cap + accounting** — new cvars
  `r_wgpuTexBudgetMB` (phone 80, 0=off), `r_wgpuTexMaxDim` (phone
  128), exported via g_capTex* globals. Over-budget images bind a
  fallback (artifact, not a tab kill); `?texbudget=N`/`?texdim=N`
  override. The diag stats line (and therefore CRASH TELEMETRY) now
  shows `wgpu-tex NMB/T` via window.__d3WgpuTexMB — the next death
  reports its WebGPU texture footprint.
- **r_wgpuTexMaxDim also applies at CACHE time** (D3_WebGPU_CacheImage
  caps to min(256, dim)) — CPU cache pixels live in the wasm heap.
  GOTCHA FOUND: a 256x1 LUT (_specularTable) at cap 128 computed
  dh=0 and was silently REJECTED (white-fallback speculars on phone);
  clamp dims to >=1, never reject.
- **Uniform-buffer consolidation** — the record/pass/shadow slot
  families were 896 tiny GPUBuffers EACH (2688 total; WebKit backs
  every GPUBuffer with its own page-padded MTLBuffer) written by
  ~700 tiny writeBuffer calls per frame (each a staging copy — the
  same per-call disease class as the WebKit GL blit storm). Now ONE
  buffer per family at a 256B slot stride; bind groups address their
  slot via static offsets; drains memcpy into a CPU stage and flush
  with ONE writeBuffer per family. Det rounds 1-6 IDENTICAL after.
- **Per-frame VERTEX dedup** — per-light interaction tris are
  distinct srfTriangles_t but REFERENCE the same ambient vertex array
  (R_CreateLightTris → R_ReferenceStaticTriSurfVerts), so a surface
  lit by N lights re-appended identical verts N times. Dedup keys on
  the verts POINTER (a first attempt keyed on the geo pointer hit
  ZERO times — lightTris are per-light objects); indexes are
  per-light culled subsets and always append. Measured: vbytes
  15.96MB → 11.25MB/frame (-30%) at enpro spawn.
- **Wasm heap growth steps** — default geometric growth is +20%, so
  one grow past 256MB committed 307MB regardless of real peak. Now
  `-sMEMORY_GROWTH_GEOMETRIC_STEP=0.05 -sMEMORY_GROWTH_GEOMETRIC_CAP=
  16MB`: committed heap tracks the peak (measured 307 → 296MB).
- **Det self-test skippable** — `r_wgpuDetTest 0` on the phone profile
  skips the offscreen targets + MapRead readback buffers.
All validated headed-Chrome both profiles: det IDENTICAL ×6, scene
correct, zero validation errors, zero fallbacks, no budget drops
(desktop AND phone-config land ~20MB GPU textures, well under the
80MB guard). RESULT (user screenshot, 2026-06-11): **the iPhone runs
the game** — iter 28 closed the tab-kill crash.

**Iter 29 — the BFG look: verified recipe + implementation
(2026-06-11).** User reference = DOOM 3 BFG Edition PC screenshot of
the ENPRO SPAWN CORRIDOR (same scene our build boots into — direct
A/B). A 5-agent research workflow (stock-BFG source vs RBDOOM fork
vs our repo audit vs screenshot quantification, all claims
adversarially fact-checked against the actual id-Software/DOOM-3-BFG
+ DOOM-3 + RBDOOM repos) established, with file:line evidence:
- STOCK BFG's "brighter" = **r_lightScale 3** (classic 2) with NO
  clamp — there is NO forced ambient, NO bloom, NO tonemap, NO gamma
  change in stock BFG (those are all RBDOOM-fork features; r_gamma
  default 1.0 both eras, hardware ramps).
- STOCK BFG specular = **analytic pow(N·H, 10) ×2** replacing the
  2004 LUT ramp (zero below N·H 0.75 then (4(x-.75))²) — this is the
  floor/wall sheen in BFG screenshots (interaction.pixel:68-70).
- STOCK BFG shadows = stencil volumes, effectively ALWAYS ON
  (r_shadows cvar removed; preload two-pass z-pass algorithm).
- Screenshot quantification (game-region luma): ours-before was ~1
  stop brighter than the reference with washed relative contrast
  (std/mean 0.67 vs 1.03, median 82.7 vs 32.1) — the corrective map
  was almost exactly a γ=2.0 power curve, i.e. our gamma 1.3 lift
  was the wash; the BFG look needs deep blacks, not more lift.
IMPLEMENTED: (1) r_shadows + g_showPlayerShadow now default ON under
WebGPU-primary EVERYWHERE incl. phone (the wearable gate dated from
the 7fps busy-spin era; post-iter-24 the iPhone runs 46.5fps;
?noshadows = escape hatch). (2) interaction.wgsl specular falloff is
dual-mode: mix(LUT, pow(N·H,10), params2.y) — new cvar
**r_bfgSpecular** (default 1; 0 = exact classic LUT) exported via
g_capBfgSpec → ub[53]. (3) Calibration defaults: **r_lightScale 3 +
r_gamma 1.0** (was 4/1.3) in both profiles + fx sliders. Classic
parity mode for A/B: ?args=+set r_bfgSpecular 0 +set r_lightScale 2.
MEASURED (same-corridor luma, headed Chrome): median 82.7→42.3
(target 32.1), std/mean 0.67→0.92 (target 1.03), deep-shadow
fraction 14%→37% (target 48%) — the reference now sits between our
classic and BFG modes instead of a stop darker than everything.
NATIVE GROUND TRUTH: /Applications/dhewm3.app (user-installed) +
/tmp/dhewm3-native (vanilla build of our pinned commit) drive the
GOG data at /tmp/d3gog for reference renders — GOTCHA: vanilla has
no g_skipCinematics (that's OUR patch), and enpro's intro cinematic
runs >160s, so timed-screenshot cfgs mostly catch the cutscene;
System-Events ESC injection didn't land (accessibility). A patched-
tree NATIVE build fails to link (port files aren't native-clean) —
deleted build-native from the engine checkout BEFORE patch regen
(git add -A would have shipped it into the patch).

**Iter 30 — the WebKit GPU-process balloon (the REAL iPhone killer)
(2026-06-11).** Shadows-on (iter 29) re-crashed the iPhone
("GPUCommandEncoder.beginRenderPass: Unable to begin render pass" +
WebGL context lost). MEASURED on Mac Safari (same WebKit WebGPU →
Metal stack as iOS, via `ps` on com.apple.WebKit.GPU while the game
runs): the GPU helper process BALLOONED past 1.7GB and kept climbing
with shadows on; even shadows-off plateaued at 1.6-2.3GB with
±300MB/s churn — iOS jetsam kills the tab long before those numbers.
The driver is per-frame allocation churn in WebKit, not our resident
resources (~100MB). Three structural cuts, all validated det-IDENTICAL
×6 + render-equivalent (mean px diff 2.45 = animation noise floor):
- **Delta vertex upload**: chunk-diff (256KB) the vert/index/shadow
  accumulators against CPU mirrors; upload only changed ranges.
  Static world geometry dominates → ~12MB/frame staging drops to the
  animated remainder. Mirrors malloc-grow to high-water (~14MB heap).
- **Redundant-submit skip**: on 120Hz displays rAF outpaces the 60Hz
  engine — frames with NO fresh captures (cap+pass+shadow all zero)
  skip acquire/encode/submit entirely; the canvas keeps the last
  presented frame.
- **Per-light pass merge**: only lights WITH shadow volumes need a
  private stencil-reload pass; all unshadowed lights render in ONE
  merged pass (stencil stays at cleared 128, GEQUAL passes — additive
  blending is commutative, identical output). ~30 passes/frame → 1 +
  shadowed-light count; the no-shadows path becomes a single pass.
  (The per-light loop ran UNCONDITIONALLY before — pass count was
  never the shadows delta; volume draws + shadow vert uploads were.)
RESULT (Mac Safari, shadows ON): GPU process settles ~0.8GB trending
down — BELOW the old shadows-OFF steady state. Shadows stay ON for
the phone. Measurement recipe for future regressions: open the URL in
Mac Safari, `ps -axo pid,rss,comm | grep WebKit.GPU` every 3s — a
climb past ~1GB within a minute = the iPhone will die.

**Iter 31 — "r_shadows reads 0" forensics + hardening (2026-06-11).**
User saw r_shadows 0 in the console while the code ships 1. Verified
the LIVE build on a fresh profile: shadows ON, 23 volumes captured —
the 0 reading was DEVICE-LOCAL STALE STATE (Safari serves cached
older bundles; pre-iter-29 phone bundles and pre-iter-19 desktop
bundles legitimately passed r_shadows 0). Forensics established the
override landscape (engine source + Exa cross-check + empirical
three-way boot test):
- dhewm3 init order (Common.cpp ~3300-3340): execMachineSpec (only on
  sysDetect, which for us is EVERY boot — /save is MEMFS so the
  _spec.cfg marker never persists) → default.cfg → DoomConfig.cfg →
  autoexec.cfg → StartupVariable re-applies command-line +sets LAST.
  So +set beats everything; configs beat each other in exec order.
- dhewm3's execMachineSpec touches r_shadows ONLY under #if MACOS_X
  (not compiled in wasm) — exonerated. It DOES stomp a pile of
  image_* ARCHIVE cvars every boot (we re-+set the ones we care
  about).
- EMPIRICAL (three-way boot): +set r_shadows 0 via ?args beats the
  autoexec pin (StartupVariable is last) — ?args overrides stay
  possible; ?noshadows works; default = ON.
HARDENING: (1) r_shadows + g_showPlayerShadow now ALSO pinned in
autoexec.cfg via the shared shadowsEnabledForBoot() helper (single
source of truth with the +set args; ?noshadows beats ?shadows) — any
config-file-class zero (stale DoomConfig, machineSpec writes) now
loses. (2) The diag stats line shows LIVE shadow state: "| shdw N"
(backend publishes the per-frame captured volume count via
window.__d3ShadowVols) — "shdw 0" when shadows are expected = the
override class returned; N varies per frame with visible volumes.
LESSON: engine console prints (cvar echo) do NOT reach the JS
console/diag in this build — d3cmd("r_shadows") shows nothing
remotely; the shdw counter is the on-device truth instrument. When a
user reports state contradicting the shipped code, FIRST suspect a
stale cached bundle: check the diag build stamp against the latest
deploy time.

**PLAYER-SHADOW VISIBILITY (2026-06-11, recurring user question).**
"I don't see a player shadow" at the enpro spawn is EXPECTED, not a
bug: the AUTO-FLASHLIGHT is the dominant nearby light, and a light
carried at the player's own origin cannot cast the player's shadow —
its point-blank glare also floods the floor (blown-white grates when
looking down). The player shadow appears from STATIC lights: turn the
flashlight OFF ('f'), stand with a corridor light behind, look
down-forward → a person-shaped silhouette on the floor (proven by
r_shadows 0/1 A/B diff: 1.5% px coherent silhouette region; red-mask
visualization /tmp/ps-shadow-highlight.png method). Verified on the
LIVE build. Vanilla native behaves identically. Safari/WebKit also
verified: build current, shdw counter 3-4 at spawn, zero WebGPU
validation errors in a 539-line log (the "err 69" line is the idle
GL probe, not WebGPU). Safari fps ~17 vs Chrome ~60 — RESOLVED in
iter 37b: the 17 was a pre-iter-30 cached bundle; the ladder measured
the current build at 60 fps (see iter 37b below).

**Iters 33-34 — THE WARM-WASH HUNT (2026-06-11): a forensic chain
worth rereading before any future "lighting differs from native"
work.** User: "native dhewm3 shows shadows/darkness ours lacks."
The hunt's twists, in order, each with the instrument that cracked it:
1. r_wgpuSingleLight prefix-sweep + per-channel RGB metric → ONE light
   carried the warm wash (R-B jump at prefix 3).
2. New light-inventory dump (d3cmd r_wgpuSingleLight 999 → names every
   frame light: shader/origin/view/shaderParms) + zcProbe (cookie
   cached-pixel sampler) → cookie content + repeat modes were CORRECT.
3. REAL FIXES SHIPPED along the way (all vanilla-parity wins, keep):
   (a) cache hook moved AFTER R_SetBorderTexels — zeroClamp cookies'
   baked black border never reached the WebGPU copies; (b) zeroClamp
   uv-box mask in interaction.wgsl (params2.z; WebGPU has no
   border-clamp samplers) + per-mip border re-stamp in the backend's
   mip builder; (c) LIGHT SAMPLERS ARE LOD-0 ONLY (vanilla samples
   cookies/falloffs GL_LINEAR no-mip; our mip chains averaged
   dark-edged cookies toward gray at glancing angles) — separate wrap
   LOD-0 sampler for scrolling cookies.
4. g_debugCinematic + condump-to-MEMFS + FS.readFile (engine console
   never reaches JS — this is THE way to read it from Playwright) →
   the skip-mode and played-intro cinematic traces are FRAME-IDENTICAL
   (the enpro intro is 42 game-seconds; the end-teleport fires in
   both; D3 4-arg setviewpos≠5-arg, whatever). The "player stranded at
   the dock" theory died: early inventory dumps had fired
   MID-CINEMATIC (frame>600 ≈ inside the intro) — the "view" was the
   cinematic camera, not the player. INSTRUMENT TIMING IS PART OF THE
   MEASUREMENT.
5. Final truth: the lingering tone delta between fast-forwarded and
   played boots = (a) THE AUTO-FLASHLIGHT — its 2.6s JS timer lands
   MID-cinematic in a played intro (impulse swallowed → flashlight
   off) but post-skip in a fast-forwarded one (flashlight on; white
   close light on warm-albedo walls reads as "warm wash", R/B 1.40 vs
   1.26); (b) wall GUI screens stay dark after fast-forward (GUIs only
   process events when RENDERED — known cosmetic issue, accepted).
   The staging dock genuinely IS warm-flooded by four huge spot01s —
   authored data, not a bug.
FIXES: SetCamera now publishes window.__d3InCinematic; the JS
auto-flashlight polls it and waits out cinematics (consistent state
both modes). g_skipCinematics now arms in SetCamera and applies in
RunFrame one frame later (vanilla-ESC-equivalent timing). Light
samplers/zeroClamp/cache-order fixes as above. Det rounds 1-6
IDENTICAL after all of it.
LESSONS: (a) compare channel MEANS (R/B ratio) not eyeballs — "warm
wash" vs "missing shadows" read identically to the eye; (b) every
same-vantage comparison must pin BOTH the flashlight state AND the
capture time relative to map start (machinery transits run ~80s);
(c) the reduced pak was byte-identical to GOG for every suspected
asset (cookies, materials, tables, scripts, default.cfg) — pak
paranoia wasted three rounds; check engine-state divergence first.

**Iters 35-36 — parity program: presets, audit fixes, HD tier
(2026-06-11/12).** Executed as a four-step plan:
(1) PRESETS: default look = native dhewm3 parity (lightScale 2,
classic specular LUT, no shadow-darken; engine cvar defaults flipped
to vanilla); `?bfg` = the verified BFG recipe (lightScale 3,
pow(N·H,10) spec, darken 0.6). bfgLookEnabled() is the single source;
fx sliders show the active preset.
(2) ECHO AUDIT (GL vs WebGPU, same engine inputs, 8x8 luma grid per
station) found three real bugs: (a) zero-lit-record frames froze the
whole canvas on stale content (dark scenes/r_singleLight) — drain now
falls through with an empty interaction set; the pass sweep derives
its main-view tag from the last 3D-kind pass record when no
interactions exist; (b) flare halos (textures/sfx/flare — every light
fixture's glow aura) never captured: flare-deform verts live ONLY in
the frame-temp vertex cache → switched to r_useVertexBuffers 0 under
WebGPU + vertex-cache fallback read in the capture, AND found that in
virtual-memory mode vertCache_t->vbo was UNINITIALIZED allocator
garbage (Position() took the VBO branch and returned junk; vanilla
never ran this path) — vbo now zeroed on header expansion; (c) audit
methodology: equalize canvas CSS sizes before comparing (browser
downscale eats thin bright features), and the echo WebGPU canvas can
be restyled via JS for fair captures. Post-fix spawn grid: the -89
tube cells GONE, meanCell 11.7→9.0; residual = ~25% flat
overbrightness in dim cells (open, low priority). Det rounds
IDENTICAL throughout.
(3) SAFARI FPS: blocked on the locked Mac (Safari fully throttles
locked/unfocused sessions — three ladder attempts read frozen
titles). Harness READY: ?fpstitle mirrors the diag stats line into
document.title (readable via plain AppleScript, no focus/clipboard/AX
needed — but the tab must be VISIBLE+focused for valid numbers);
/tmp/safari-ladder2.sh runs baseline/noshadows/skipInteractions in
~5 min at next unlock. Also learned: Safari caches Vite dev ES
modules aggressively — use `vite build` + `vite preview` for Safari
testing, never the dev server.
(4) HD TIER: 256px enpro bake (97.8MB) ships as same-origin 4MB
chunks under public/wasm/base256/ (force-added like base/);
`?hd&dsl=256` selects it. GitHub RELEASE assets send NO CORS headers
(verified — release-assets.githubusercontent.com, no ACAO even with
Origin) so cross-origin pak hosting is a dead end; the release
pak256-enpro-v1 exists but is unused by the app. Measured: GPU
textures 22.8→64MB, wasm heap 296→408MB — desktop only; phone keeps
128. Tier switch keys the chunk path + manifest freshness handles
cross-tier cache correctness.
SHELL GOTCHA (again): the engine-checkout commit trap fired once more
(cwd in build dir; commit landed on detached HEAD + tried pushing to
dhewm/dhewm3 upstream — failed harmlessly). Recovered with reset +
re-stage. ALWAYS cd to the app repo in the same command as git ops.

**Iter 37 — auto-flashlight OFF by default (2026-06-11): THE final
native-look gap.** The user's "this isn't the same as dhewm3 Mac"
reports survived every shader/sampler/preset fix because the dominant
remaining difference wasn't a renderer bug at all: the wearable
profile auto-raised the flashlight 2.6s after spawn, and a white
point-blank light carried at the player origin floods near surfaces
and kills every nearby static-light shadow (including the player's
own — a light at your origin cannot cast your shadow). Measured
corridor luma: native 23.0 / ours flashlight-OFF 23.5 / ours
flashlight-ON 30.8. autoFlashlight is now false in all profiles; the
flashlight chip is always visible (dimmed) and is a tap target
(role=button → toggleFlashlight) alongside the long-pinch. Test
scripts must NOT press 'f' anymore (an old script press turned it ON
and faked a regression).

**Iter 38 — STENCIL SHADOWS ACTUALLY WORK NOW (2026-06-12): the
"red hallway without shadows" bug.** User called bullshit on the
iter-37b side-by-side — and was right: at the spawn viewpos
(-320 3968 -155.75 yaw 180, via getviewpos/setviewpos — native
teleported through its console via System Events + engine
`screenshot` cmd) native's r_shadows ON/OFF changes 16.4% of pixels
(9.86% animation-stable) vs our 1.89%. The world had NO static-light
shadows; only the player's volume showed. THREE stacked defects, in
discovery order:
(1) CAPTURE: D3_WebGPU_CaptureShadow required tri->shadowVertexes —
NULL for 39 of 43 volumes/frame (static interaction shadows + VP-turbo
world volumes free/never-have the CPU array; GL draws them from
vertexCache.Position(tri->shadowCache), exactly like the iter-35 flare
verts). Fix: cache-read fallback with numVerts = maxIdx+1 derived from
the index set (source-agnostic). Workflow-audit law: tri->numVerts is
the FULL already-doubled shadow-vert count for EVERY producer
(ParseShadowModel, R_CreateShadowVolume, CPU-turbo; VP-turbo's
newTri->numVerts = ambient*2 likewise total) — the old `numVerts*2`
was a harmless-looking OOB overread that halved the accumulator.
Also learned: UpdateLightDef permanently NULLs parms.prelightModel on
any light parm change (lightHasMoved never resets) — enpro's scripted
corridor lights lose their dmap prelights at the power-up sequence and
regenerate world shadows as VP-turbo via the interaction path; the pak
ships all 332 shadowModel sections intact (md5 = GOG).
(2) ROOT CAUSE — STENCIL MASKS: every WGPUDepthStencilState in the
backend was zero-initialized; emdawnwebgpu's library_webgpu.js passes
stencilReadMask/stencilWriteMask VERBATIM (no 0→default mapping;
Dawn's WGPU_DEPTH_STENCIL_STATE_INIT macro is what carries the
0xFFFFFFFF defaults and we never used it). Masks were 0 → every
stencil WRITE was a no-op and every compare degenerated
((ref&0) op (stencil&0)): GEQUAL always passed (never shadowed),
NotEqual never passed (darken pass inert since iter 23!). The visible
"player shadow" that masked all this came through structural
side-effects, not stencil. Fix: masks = 0xFFFFFFFF at all 12 sites.
LAW: zero-init WebGPU structs lose Dawn's _INIT defaults — audit any
struct with nonzero defaults (masks, depthBias, sample masks).
(3) NOT the bug: frontFace. GL computes facing in y-up window coords,
WebGPU in y-down framebuffer coords, so a CW flip was theorized — but
empirically the WebGPU default (CCW) + GL's op assignment is correct
(the flip inverted the working player shadow; reverted).
INSTRUMENTS BUILT (all gated on r_wgpuSingleLight, NEGATIVE values —
positives trip the single-light filter and zero lastRecordCount):
996/engine-side per-draw probe stages 0-7 + shadow vert-content dump;
-996 backend lightId correlation line (int vs shdw ids — they match;
records ARE contiguous per light); -994 volumes as magenta
(geometry probe: 71% coverage = capture/extrusion/matrices all good);
-993 magenta + Less depth; -992/-991 Equal-stencil readout (TRAP:
with masks 0 it darkened everywhere and the bright-region threshold
faked a "shadow-like pattern" — instrument bugs can mimic the
hypothesis). Also: engine `screenshot` console cmd + System Events
keystrokes = the native ground-truth harness (condump to
~/Library/Application Support/dhewm3/base/).
VALIDATED: det rounds 1-6 byte-IDENTICAL; stable shadow signal
1.34% → 13.32% (native 9.86 — we slightly over-shadow: our private
pass applies global+local volumes to ALL the light's interactions
vs vanilla's interleaved order; acceptable); spawn corridor now
visually matches native (dark distant hall, no red flood); 43
volumes/frame at spawn, 88 in det scene; zero WebGPU validation
errors; wasm 296MB / tex 22MB unchanged. Shadow-darken (?bfg 0.6)
now ACTUALLY darkens for the first time. OPEN: Mac re-locked before
the WebKit GPU churn re-measure (4-5 private passes/frame now vs ~1
— delta-upload covers the static shadow verts, expected fine, but
MEASURE before declaring iPhone-safe) and before the new native
side-by-side.

**Iter 58 — content cut: wraith + sentry drone (and the progression
trap that blocked the rest) (2026-06-13).** User wanted enpro enemies
cut to just imp + zombie + the sentry "drone". Built reducer tooling:
`--cut-defs <substrings>` (skip those defs in the asset closure → drop
their unique models/anims/textures), `--cut-map-entities` (delete
matching entity blocks from the .map so they don't spawn as box
models), `--drop-paths <substrings>` (drop kept files by path). THE
PROGRESSION TRAP (the key finding — do NOT blindly cut map enemies):
DOOM 3 monsters fire their `target` ON DEATH, and enpro wires monster
deaths into `trigger_count` gates ("kill N to proceed"). Measured: 10
lostsouls + 3 maggots feed trigger_count_2/3/4 — and since a monster
type's model/anims/textures are SHARED across all instances, cutting
those assets requires removing EVERY instance incl. the gating ones →
the count can never complete → player STRANDED mid-level (invisible at
boot, breaks deep in). So only 0-gate enemies are safe: wraith (8, all
target ai_lostcombat = AI nodes, not gates) + the sentry drone (1,
only referenced by 2 target_callobjectfunction flashlight on/off which
no-op when the target is missing; no script controls it). SHIPPED the
wraith+drone cut (--cut-defs "wraith,sentry" --cut-map-entities):
default boot 31.6→30.5MB, all tiers; verified boots to gameplay (pos
publishes, no errors, spawn renders, imp combat works) — unlike the
cinematic-anim cut which HUNG the boot (the fast-forwarded intro still
plays its anims; --drop-paths md5/cinematics → red/cyan broken render,
never reaches gameplay — those anims are load-bearing, leave them).
LAW: before cutting any map enemy, check whether its death feeds a
trigger_count/relay gate (grep the .map: monster "target" → trigger_*);
shared-asset types are all-or-nothing. The --cut-defs tooling stays for
future safe cuts.

**Iter 57 — strip precomputed .proc shadowModels: -3.8MB free
(2026-06-13).** Toward <5MB boot: enpro.proc (28.5MB raw / 6MB gzip)
is 63%% `shadowModel` blocks (17.9MB raw, 332 of them) — precomputed
PRELIGHT shadow volumes. But the WebGPU build regenerates ALL stencil
shadows dynamically (VP-turbo; iter 38: UpdateLightDef NULLs
prelightModel on light change), so the prelights are DEAD WEIGHT.
Reducer `--strip-proc-shadows` removes the shadowModel blocks (balanced-
brace) from the .proc. VERIFIED EMPIRICALLY (swapped into base/, booted
?nostream): boots clean (no missing-prelight crash/abort), 70 shadow
volumes still captured (dynamic regen works), spawn visual identical,
determinism 6/6 IDENTICAL. RESULT: .proc 5.96→2.21MB gzip; all three
tiers rebuilt — default streaming BOOT 35.4→31.6MB, base/ (?nostream)
48.7→45MB, base256/ (?hd) 80→76MB. Zero engine change, zero risk
(prelights were already unused). Same ~3.8MB as the animation-defer
option would have yielded, but FREE (no anim-system risk). The .proc is
now mostly world geometry (10MB raw / ~2.2MB gzip) + BSP nodes (0.6MB);
the next <5MB lever is portal-area streaming of THAT geometry (deep,
under investigation). Build recipe adds --strip-proc-shadows.

**Iter 56 — streaming is now DEFAULT + stream-blob IndexedDB cache
(2026-06-13).** iter-55 ?stream verified on iPhone (user-confirmed),
so productionized: (1) streaming is the DEFAULT boot (STREAM_TIER =
!hd && !nostream) — `?nostream` falls back to the 47MB monolithic pak,
`?hd` uses the 256px monolith (no stream variant baked). (2) The 13MB
gzip stream blob now IndexedDB-caches (reuses storage.js
saveCachedUrlPk4/readCachedUrlPk4, freshness by the manifest's
compressedSize) so repeat/cellular visits don't re-fetch it — verified:
2nd boot logs "Using cached bundled PK4" + "Texture stream: using
cached blob". VERIFIED: default boots base-stream/ + streams + caches;
?nostream boots the monolith with NO streaming + det 6/6 IDENTICAL.
NOTE for tests/diagnostics: boot with `?nostream` for a stable,
fully-textured frame (default now streams gray→real over the first
seconds); the det self-test is self-contained per round so it holds
either way. Monolithic base/ + base256/ stay committed as the
?nostream / ?hd fallbacks. NEXT toward <5MB (still open): defer the
11MB md5anim animations, then portal-area .proc geometry streaming.

**Iter 55 — PROGRESSIVE TEXTURE STREAMING (?stream, 2026-06-13).**
Phase 1 of the progressive-load request, built + verified on Mac Chrome
(on-device is the open gate). `?stream` boots on a 35MB structural pak
(geometry + decls + HUD/light textures) and streams the bulk world/
model textures (13.2MB gzip) in after boot — surfaces render gray-lit,
then pop to real as each batch lands. Determinism 6/6 IDENTICAL
(streaming path inert in the det/normal path). HOW IT WORKS, end to end:
- REDUCER `--defer-textures`: splits output into the boot .pk4 +
  a `.stream` blob (gzip of the deferred textures, raw-concat) +
  `.stream.json` (file manifest: path/off/len, offsets into the
  UNCOMPRESSED blob). Deferred = images under textures/|models/|env/
  EXCEPT lights/ (a missing falloff is BLACK not gray — worse),
  guis/|fonts/|ui/ (HUD must be crisp). 1620 textures → 13.2MB gzip.
- DELIVERY (loose-file override): the engine reads loose files in
  /base/ in PREFERENCE to the pak (FileSystem.cpp search order — dir
  entry precedes paks; proven by the existing zz_flashlight_fix.mtr).
  A file written to MEMFS post-boot is found by the engine's live
  fopen immediately (no stale dir-cache) — write LOWERCASE paths
  (engine name.ToLower(); fs_caseSensitiveOS=1 under Emscripten).
- JS (d3Runtime.js): STREAM_TIER boot pak = base-stream/; `image_preload 0`
  so textures load lazily (not all default at level-end); 3s after main,
  streamDeferredTextures() fetches the chunked gzip blob (reuses
  fetchChunkedBytes), inflates via DecompressionStream('gzip'), and writes
  each texture as a loose /base/ file in batches of 200, calling
  D3_ReloadStreamedImages() per batch.
- ENGINE reload: `reloadStreamedImages` cmd (R_ReloadStreamedImages_f,
  Image_init.cpp) reloads ONLY images with `defaulted && !generatorFunction
  && !isPartialImage` — clears defaulted, `Reload(false,true)` (force=true;
  the WASM-zip timestamp gate is unreliable). Each reload re-fires
  GenerateImage → D3_WebGPU_CacheImage. Exported via d3_wearable.cpp
  (buffers the cmd, never reentrant) + CMakeLists + d3Runtime.
- THE BLACK-SURFACE TRAP (the hard part): a deferred image first-drawn
  with its file missing → MakeDefault → in RELEASE mode the _default is
  SOLID BLACK (0,0,0,0), not the dev-mode checker — and a black NORMAL
  map decodes to garbage normals → N·L collapses → BLACK surfaces, not
  gray. FIX: (a) MakeDefault sets `defaulted=true` BEFORE GenerateImage
  so the cache hook sees it; (b) WGPUImageSlot/ImgSlot carry a `defaulted`
  flag (layout-stable mirror); (c) getEngineTextureView returns the
  caller's role-aware NEUTRAL fallback (fbFlatNormalView / fbCheckerView /
  fbWhiteView) for a defaulted slot instead of the cached black → surfaces
  render gray-LIT (correct lighting, placeholder diffuse), then real.
- WEBGPU CACHE INVALIDATION (per-image, NOT full-flush — full re-upload
  would re-trigger the iter-30 WebKit GPU-process churn on iPhone): on a
  re-cache (reload of an existing slot), tr_render appends the idImage ptr
  to g_capReuploadPtrs[]; the backend's processStreamReuploads() (called at
  EndFrame top) evicts JUST those ptrs from texCache + any matCache tuple
  containing them; lastMatGroups self-heal next drain. Also fixed a latent
  leak: the per-image WGPUTexture handle was never released after
  CreateView (added wgpuTextureRelease so eviction frees GPU memory; struct
  gained a per-entry `bytes` for the gpuTexBytes accounting). g_capReuploadAll
  is the overflow fallback (>512 dirty → flush all).
NUMBERS: monolithic JPEG pak 48.7MB → boot 35.4MB + 13.2MB gzip stream
(total ≈ same; 13MB moved off the boot path = ~27% smaller initial
download + progressive sharpening). OPT-IN via ?stream while it bakes;
flip to default once on-device-verified. base-stream/ holds boot+stream
chunks + 3 manifests (.pk4.manifest.json chunk, .stream.manifest.json
chunk, .stream.json file). OPEN: (1) iPhone verification of the
reload/evict path (the on-device gate — verify no GPU-churn re-crash);
(2) stream blob not yet IndexedDB-cached (HTTP cache only — re-fetches
on a cold cache; follow-up); (3) <5MB boot still needs animation
deferral (11MB md5anim) + portal-area geometry streaming on TOP of this
(the structural floor, iter 54). Build recipe: reduce ... --jpeg-textures
--defer-textures, then chunk-pk4.py BOTH the .pk4 and the .pk4.stream.

**Iter 54 — JPEG texture compression + progressive-load scoping
(2026-06-13).** User asked: load the level in <5MB with assets
streaming progressively up to ~20MB. PHASE 2 (texture compression,
SHIPPED): `--jpeg-textures` in reduce-d3-map-pk4.py re-encodes COLOR
textures (diffuse/specular/sky, no alpha) as JPEG and drops the .tga
— idTech4's R_LoadImage (Image_files.cpp:860-866) tries `<name>.tga`
then falls back to `<name>.jpg`, so NO material rewrite is needed.
Guards keep lossless: normal/height/bump maps (`_local`/`_h`/etc.;
JPEG ringing corrupts surface normals), USED-alpha textures (JPEG has
no alpha + dhewm3 reads no PNG), HUD/font art, and a bluish-mean
normal-map heuristic for mis-named normals. 1002 textures recoded.
RESULT: 128-tier pak 60.6→47MB (-22%), 256-tier 109→77MB (-29%);
zero missing-image warnings, spawn renders clean (q85 visually
lossless at 128/256px). THE STRUCTURAL FLOOR (the key finding,
measured): the pak does NOT compress below ~28MB because that much is
NON-texture and loads at MAP SPAWN — enpro.proc 6.0 (world render
geometry) + .cm 3.3 (collision) + .map 1.1 + .aas48 0.7 + **11.3MB of
md5anim (animations)** + 2.8MB md5mesh + decls 2.0. So <5MB boot and
20MB total are NOT reachable by texture work alone — they need
animation deferral + portal-area geometry streaming (deep engine
work). VALIDATED PHASE-1 STREAMING PLAN (designed via a 3-agent
mechanics workflow, not yet built; image_preload 0 + stream textures
as loose FS files + reload-on-arrival): (1) the BUG that makes
streaming hard — with image_preload 0 an image loads lazily on first
Bind (Image_load.cpp:1818); a missing file → MakeDefault sets a VALID
texnum + defaulted=true (Image_init.cpp:261,313) → PERMANENTLY stuck
(Bind/EndLevelLoad only reload when texnum==TEXTURE_NOT_LOADED). (2)
FIX: `R_ReloadStreamedImages_f` (model R_ReloadImages_f Image_init.cpp:
1086, register at :2014) iterates globalImages->images, and for each
`defaulted && generatorFunction==NULL && !isPartialImage`: clears
defaulted, calls `image->Reload(false,true)` (force=true bypasses the
flaky WASM-zip timestamp gate; PurgeImage→ActuallyLoadImage→
GenerateImage→D3_WebGPU_CacheImage re-caches real pixels). (3) MANDATORY
WebGPU invalidation — texCache (RenderBackend_WebGPU.cpp:1705) + matCache
(1820) + lastMatGroups (4061) short-circuit by idImage*/tuple and never
re-read; a `D3_WebGPU_InvalidateImageCaches()` shim must release+clear
them (they lazily rebuild next frame). (4) export D3_ReloadStreamedImages
via d3_wearable.cpp (buffer `reloadStreamedImages\n`, don't call renderer
reentrantly) + CMakeLists:573 + d3Runtime.js:432; JS calls it once per
arriving texture batch. Boot payoff capped at ~18MB (the deferrable
textures) by the structural floor; the mechanism is the reusable
foundation that anim/geometry streaming would later plug into.

**Iter 53 — the imp FIREBALL never showed: particles (.prt) never
shipped (2026-06-13).** User: "the imp's fireball particle doesn't
show." The visible fireball, its smoke trail, and the explosion are a
PARTICLE SYSTEM, not a model+material — and the reducer shipped ZERO
.prt files. TWO compounding gaps (a 5-agent-equivalent trace nailed
both with file:line): (1) .prt was in MODEL_EXTS (a prunable binary),
and step-2's decl indexer only parsed .mtr/.def/.sndshd/.skin — so
particle stage textures (textures/particles/*) never entered the
closure; (2) projectiles reference a particle by DECL name +".prt"
(`"model" "impfireball2.prt"`, `"smoke_fly" "imp_trail2.prt"`,
`"model_detonate" "imp_explosion.prt"`) but those decls physically
live in DIFFERENTLY-NAMED files (particles/patrick2.prt,
particles/monster_weapons.prt) — so even the binary-keep name match
never fired. Net: no .prt + none of smokepuff/billow3_glow/fbeam/
barrelpoof/rocketbacklit/boomboom* shipped; the only trace of a
fireball in-game was the faint moving glow from lights/impflyflash
(blanket-kept under lights/). FIX (reduce-d3-map-pk4.py): index every
particle decl -> its stage assets AND -> the .prt FILE that holds it
(step 2b scans all .prt entries); in the closure, a referenced
particle token (with or without the .prt suffix — strip_ext handles
it) keeps that .prt file + pulls each stage's image, resolving
material names (textures/particles/barrelpoof_sort -> barrelpoof.tga)
through the materials index. +1.1MB (14 .prt + ~30 particle textures).
RESULT: boot/combat particle warnings -> ZERO; the fireball renders
in WebGPU. VERIFICATION (hard-won): AI monsters wander out of frame
and fast projectiles dodge burst-capture — `spawn projectile_impfireball`
at timescale 0.02-0.15 spawns a near-stationary, continuously-emitting
fireball; both #gameCanvas (GL echo) and #webgpuCanvas show the same
bright additive orb (a compact sprite, not just diffuse wall glow =
the particle billboard renders, confirming the iter-35 flare/deform
vertex-cache path also carries particles). LAW: particles are a
first-class asset class with the decl-name != file-name break — any
`.prt` / `.fx` / `.skin` style "named decl lives in an arbitrary
file" reference needs a decl->file index, not a name match.
SENTRY BOT (same user report, RESOLVED BY iter 52): char_sentry_flashlight
REQUIRES a skin (skin_flashlight_off/on); pre-iter-52 no .skin shipped
-> defaulted skin -> black model, the SAME mechanism as the zombie.
The iter-52 .skin fix already covered it (user confirmed "showing
now"). Couldn't repro locally because the scripted bot isn't present
at its map origin (-1540 3836 -351) at boot and console-`spawn
char_sentry_flashlight` yields no visible model (empty inherited
model def). Its body data (material block + all 10 TGAs) was always
complete — the missing piece was the skin decl itself.

**Iter 52 — black zombies + black skybox: the .skin decl gap +
cubemap side expansion (2026-06-13).** Two user iPhone reports, one
root family: the pak reducer never shipped SKIN DECLS or ENV
CUBEMAPS. (1) ZOMBIE BLACK SILHOUETTE: every D3 zombie def applies a
skin ("skin" "skins/monsters/zombies/zfat.skin" for enpro's fatties)
remapping the npc base materials to d-variant flesh materials; .skin
was not in TEXT_KEEP_EXTS so ZERO skin files shipped → the engine
builds a DEFAULTED skin → solid black model (textures alone don't
fix it — fatty's tgas were always in the pak). Fix: keep .skin +
index skin decls (name AND ±".skin" alias — defs reference
"zmaintb.skin" while the decl is "zmaintb") + closure pulls each
referenced skin's remap-target materials and their images (+1.7MB:
djumpsuit/dsoldier d-variant sets). (2) BLACK SKYBOX (outdoor
walkway): enpro sky = textures/skies/desert = `cameraCubeMap
env/desert` — the engine expands the base to six side files
(_forward.._down / _px.._nz) and the reducer never did → zero env/
images ever shipped (the known iter-2b "env cubemaps" drop class).
Fix: CUBE_SIDE_SUFFIXES expansion of ref_stripped + extra_stripped.
VERIFIED (echo + primary): fatty spawns textured+lit in the corridor;
the Mars sky renders from the walkway (WebGPU; the GL echo's sky
stays black — GL4ES cameraCubeMap quirk, echo/fallback-only, was
never working). Engine adds in the same deploy: setviewpos takes an
optional 6th PITCH arg (emscripten-only) so a pos-chip screenshot is
a one-command repro; pos publish every 8 views (was 32, flaky).
HUNT LESSONS: (a) read the ENGINE console from Playwright via
d3cmd("condump x.txt") + Module.FS walk — "Couldn't load image:
models/monsters/zombie/zombie01/zlegs01b" named the gap class
instantly after hours of screenshot guesswork; (b) testmodel on an
md5mesh prints "NULL joints" and draws nothing without testanim —
use `spawn <class>` with notarget + ai_freeze 1 SET BEFORE the
spawn; (c) enpro's map only ever spawns monster_zombie_fat — maint/
jumpsuit/tshirt defs ship (def files keep wholesale) but are NOT
seeded, so their zombie01 images stay excluded BY DESIGN (spawning
them via console shows missing-image warnings — not a player-facing
gap); (d) the echo-mode WebGPU canvas lags SECONDS behind teleports
(redundant-submit skip interplay) — settle 5s+ before echo A/B
captures, and remember only PRIMARY-mode WebGPU captures are honest
(iter 50b); (e) sky-brush positions are parseable from the .map's
brushDef3 planes (axis-aligned faces: coord = -d/n) — that located
the outdoor walkway in one query after five blind teleports.

**Iter 51 — THE GRAY-PLANES ARTIFACT: fog frustum tris vs partial
depth prepass (2026-06-13). ALSO closes the +25% dim-cell issue.**
The user's "missing ceiling" iPhone shot (IMG_2522, pitched up at
-697 3974 -156 yaw~150) was REAL after all — but inverted: WebGPU
painted flat gray-green polygons where GL/native render black.
HUNT: matched the framing locally (gray planes reproduce with the
FRESH pak) → GL echo A/B showed GL black = WebGPU-only artifact →
-899 (planes survive = not pass records) → prefix sweep: planes
appear with ONLY light[0] drawn = fogs/basicfog (color 0.14,0.18,
0.15 — matches the planes' tint) → fog textures resolve (no
FALLBACK lines) + sampler is ClampToEdge → source read found it.
ROOT CAUSE: vanilla RB_FogPass ends by drawing the fog light's
FRUSTUM BOUNDING TRIS (back-side culled, GL_LESS) to fog the void —
correct only against a depth buffer containing EVERY opaque surface
(GL's full depth-fill). Our prepass writes depth ONLY for captured
interaction surfaces, so UNLIT pixels keep far-plane depth and the
fog box's flat faces pass the depth test and paint solid fog color
there (unlit ceiling = flat gray planes). The same leak washed a
fog pedestal over the whole scene (near faces / un-gated stacking)
— measured at the level-pitch vantage: upper-half mean 10.19 →
7.20, median 2.7 → 0.0, frac<8 59.7% → 83.9% vs NATIVE 5.0/0.0/85%
— the long-open "+25% flat dim-cell overbrightness vs GL echo" was
THIS, now closed. FIX (interim, capture-side): RB_T_BasicFog skips
capturing `surf->geo == backEnd.vLight->frustumTris` — replaying
frustum tris is wrong-by-construction until the prepass covers all
opaque surfaces; the only loss is fog against the void (rare
indoors). Det rounds 6/6 IDENTICAL. THE PROPER FOLLOW-UP (also
unlocks min-ambient): capture RB_T_FillDepthBuffer surfaces into
depth-only records so the prepass covers ALL opaque geometry, then
split fog into vanilla's two modes (chain = depth Equal; frustum =
Less + back-cull). LAW: any vanilla pass that relies on the FULL
depth buffer (fog frustum, blend-light frustum?, future
stencil-against-depth tricks) is unsafe to replay against our
partial interaction-only prepass — audit depth assumptions when
porting a pass. Diag UI note from this hunt: the #posLine chip is
hidden behind the diag box when the diag is open (user screenshots
carried no pos) — read pos from the diag stats line instead, or fix
the chip z/position.

**Iter 50c — NATIVE GROUND TRUTH closes the ceiling report
(2026-06-12).** User pushed back twice with native Mac screenshots
("definitely a ceiling there") — both pitched UP with the flashlight
aimed at it. Scripted native proof at the EXACT spot
(getviewpos-verified `(-675 3964 -155.65) 178.0`): native upper half
at LEVEL pitch = mean luma 5.0, MEDIAN 0.0, 85% black — DARKER than
ours (no-flashlight 8.0/2.3/63%). Pixel analysis of the user's own
pitched-up native shot: lit beam pool mean 6.8 vs ours 5.8; OFF-beam
ceiling luma 1.4 (98% black) — even native shows the ceiling ONLY
where the flashlight beam lands. Verdict stands: authored darkness,
we render slightly MORE than native. THE NATIVE AUTOMATION RECIPE
(keystrokes are NOT viable — System Events sees no AX windows for
SDL apps, and a focus miss types into the user's frontmost app):
drive everything from a cfg in fs_basepath/base via `+exec`:
`devmap <map>; timescale 10; wait 5000; timescale 1; setviewpos ...;
wait 90; screenshot; getviewpos; condump out.txt; quit` with
isolated `+set fs_configpath/fs_savepath /tmp/<dir>`. GOTCHAS:
(a) launching unfocused/backgrounded DEADLOCKS in Cocoa_GL_SwapWindow
(main thread stuck in the launch AppleEvent handler; 0% CPU forever)
— `+set r_swapInterval 0` fixes it (skips the display-link wait);
(b) `wait` counts RENDER frames and vsync-off fps is ~125+, so
fixed waits can't outlast the >160s enpro intro — fast-forward
game time with timescale 10 instead (vanilla has no
g_skipCinematics; that's our patch); (c) setviewpos zeroes pitch
(level) and native takes x y z yaw only; (d) macOS screenshot
filenames contain U+202F before AM/PM — glob, don't type the path;
(e) screenshots land in fs_savepath/base/screenshots/*.tga at 2x
window size (retina). RESIDUAL COSMETIC DELTA worth a future iter:
native renders the flashlight's beam-glow cone + lens flare quads
(implicit materials from models/items/flashlight/beam1.tga etc.);
our zz_flashlight_fix.mtr blanks those four surfaces — a fix from
when the reduced pak LACKED the textures, but the iter-50-era pak
now SHIPS them (beam1/bulb/dust/flare/flare2.tga confirmed in the
pak). Removing the override should restore the native beam look —
needs the GL-echo A/B (verify no white quads / no black boxes over
lit surfaces) before shipping.

**Iter 50b — ceiling follow-up at pitch-level vantage: authored
darkness confirmed, no defect (2026-06-12).** User report from the
SAME spot (`pos -675 3964 -156 | yaw 178 pitch -3`, flashlight on,
upper half of frame black): full triage ladder run — (1) r_showTris
wireframe covers the black region (geometry submitted); (2) WebGPU-
primary vs GL echo upper-half luma 10.19 vs 10.78, median 2.7 vs 0.0
(we render slightly MORE than vanilla GL there); (3) 8x exposure
shows the ceiling textured and structurally complete, just nearly
unlit — the flashlight cone aims level at the door and no static
light reaches the ceiling span (iter-49d light census applies; same
area). VERDICT: authored darkness, native-equivalent. The user
"used to see" this ceiling because pre-iter-50 it rendered the
self-visible FLAT GRAY _default fallback — fixing the texture made
it correctly dark. Pitch the view up and the flashlight lights it.
CAPTURE GOTCHA: in &echo mode the WebGPU canvas resists CSS resize
(rendered 200px wide despite inline 600px) and overlay chrome
contaminates element screenshots, inflating its luma (25.5) — use
WebGPU-PRIMARY mode for honest WebGPU captures; only its numbers
match the shipping iPhone config.

**Iter 50 — the gray ceiling: DDS-only textures + .tga-named materials
(2026-06-12).** The 49d "authored darkness" verdict was HALF the story
— the user's flashlight screenshot (pos chip!) showed the lit surface
rendering FLAT GRAY = _default fallback. Boot had warned all along:
~40 "Couldn't load image" lines. TWO reducer gaps compounded:
(1) id authored some material NAMES with an image extension
("textures/base_trim/a_reactorpipe_01_fin.tga") while maps reference
them bare — the reducer's exact-string materials index never expanded
their stage images; (2) the 1.3.1 patch paks REMOVED many hi-res TGAs
and ship them ONLY as precompressed dds/<path>.dds — the engine falls
back to that tree at load (image_usePrecompressedTextures) but the
keep-test never matched the dds/ prefix AND the browser cannot decode
DXT anyway (no S3TC on WebKit). FIX (reduce-d3-map-pk4.py): alias bare
material names in the index + decode referenced DDS-only images to
TGA at canonical paths via Pillow's DDS plugin, tier-downsized
(+18 files, +0.4MB). RESULT: boot missing-image warnings ~40 → ZERO;
gray surfaces (shaft ceiling, reactor pipes, props, env cubemaps) get
real textures. LAW: every "Couldn't load image" boot warning is a
future gray-surface report — keep that count at zero; the dds/ tree
is part of the game data contract. Pak freshness invalidates by
manifest totalSize, so clients refetch automatically.

**Iter 49d — the "disappearing ceiling" verdict: authored darkness
(2026-06-12).** First pos-chip-driven repro (user screenshot carried
`pos -667 3962 -156 | yaw -177 pitch -31`; setviewpos + touch-drag
pitch landed exactly there). Triple proof it is NOT a bug:
(1) r_showTris 2 wireframe covers the black region — geometry IS
submitted and drawn; (2) 8x exposure: the region is mathematically
ZERO — no light contribution at all (not dim — none); (3) enpro.map
light census: the only light up that shaft is light_7
(lights/squareishlight, z+16, radius 256/352/320 — the orange glow we
DO render); the black faces are outside its reach. idTech4 has no
ambient — unlit surfaces are pure black BY DESIGN; native renders the
same. GL echo and WebGPU agreed pixel-for-pixel, which exonerated the
backend immediately. METHOD: pos chip → setviewpos → r_showTris →
exposure amp → .map light census = the complete "missing geometry"
triage ladder, no native app needed. Blood smear confirmed fixed by
the user (iter 49 census). The .map ships in the pak — light-entity
queries are always available.

**Iter 49 — blend census + teleportable screenshots (2026-06-12).**
After iter 48 proved unhandled blends were a CLASS of bug, a census of
every `blend` line in the game's .mtr files found five more modes the
additive catch-all was mangling: gl_zero/one_minus_src_color (x67,
blood + burn decals — drawn additively they GLOW: the user's emissive
floor blood), gl_dst_alpha/one (x106), gl_zero/one_minus_src_alpha,
gl_dst_color/one, and gl_zero/gl_one ("don't draw anything", x126 —
we'd been DRAWING those). Pass kinds 8-11 + a capture reject. RULE:
never let a renderer catch-all silently substitute additive — census
the data and enumerate. ALSO (user's idea): the diag stats line now
shows live "pos X Y Z | yaw P pitch Q" (engine publishes
window.__d3ViewPos every 32 views from RB_BeginDrawingView) — any
user screenshot is now a teleportable repro via `setviewpos X Y Z yaw`
(pitch needs a look-drag; setviewpos only takes yaw). OPEN from user
reports (need their pos-stamped screenshots to repro): ceiling
geometry vanishing when looking up in the first hallway ("WALKWAY TO
CPRO" HUD tag) — suspects: record-slot overflow (kMaxRecordSlots 896,
big vista through ceiling) vs portal/area culling vs unlit-is-black
legit behavior; check g_capDropped first when reproducing.

**Iter 48 — THE weapon-display grid: maskcolor + dst-alpha gating
(2026-06-12).** The user's actual complaint all along (bright grid
overlaid on the ammo display, ALL browsers): the gridscroll material
(gui/weapons/machinegun/gridscroll in weapons.mtr) primes FRAMEBUFFER
ALPHA with a `maskcolor` stage (bg_mask2.tga alpha x parm3=0.1, RGB
write-masked) and draws grid.tga with `blend GL_DST_ALPHA,
GL_ONE_MINUS_DST_ALPHA` — gated to ~10% by the primed mask. Our
capture REJECTED maskcolor stages (iter-16 comment: "they'd paint
opaque blocks") and the dst-alpha blend fell into the additive
catch-all → ungated full-brightness grid. FIX: pass kind 6 =
alpha-prime (makeVariant grew a writeMask param; alpha-only, One/Zero
replace) and kind 7 = dst-alpha gated (DstAlpha/OneMinusDstAlpha);
classifier routes GLS_COLORMASK-without-ALPHAMASK to 6 and the
dst-alpha blend pair to 7. Chaingun/plasma gui displays share the
pattern; glass alpha-prime stages un-broke too. Iters 44/45/45b/47b
along the way were REAL adjacent bugs (srcAlpha-add, scissor, aniso,
WebKit near-plane haze) but THIS was the user's issue. LESSON: when a
material misrenders, pull its .mtr FIRST — the four-hour geometry
hunt would have been ten minutes ("blend GL_DST_ALPHA" names the
missing feature). Reference matching: native look achieved (dark
panel, faint grid, crisp digits).

**Iter 47b — the REAL haze smear: WebKit near-plane interpolation
(2026-06-12).** Iter 47's "stale embed" conclusion was WRONG (Chrome
went clean coincidentally) — the user retested: smear persisted on
iPhone. REPRODUCED ON MAC SAFARI (same build clean in Chrome on the
same machine = engine-data innocent, WebKit-specific). Bisect via boot
arg `&args=%2Bset%20r_wgpuSingleLight%20-894` (zero-deflection debug):
Safari clean ⇒ the offset term. MECHANISM: the glass pane (heatHaze
material) crosses the NEAR PLANE; WebKit's clipper interpolates vertex
attributes through w~0 vertices differently than Chrome/Dawn — the
interpolated per-vertex deflect exploded to inf/NaN → the pane
resampled the scene copy from kilometers away → displaced copies of
the ammo display smeared across the gun. FIX (haze.wgsl): clamp the
fragment offset to +-0.02 UV (legit refraction <= 0.01 by
construction, transparent) + a NaN select (NaN passes through min/max
on some implementations; clamp alone is NOT NaN-safe). LAWS:
(a) WebKit-only artifacts with clean captured data = suspect
NEAR-PLANE-CROSSING GEOMETRY + attribute interpolation — clamp and
NaN-guard any screen-space offset derived from interpolated attributes;
(b) Mac Safari reproduces iOS WebGPU bugs 1:1 and the boot-arg hook
(?args=+set) drives debug cvars where no console exists; (c) verify
"fixed" claims on the AFFECTED platform before declaring victory —
two Chrome-verified "fixes" shipped before this one.

**Iters 46b-47 — 120Hz double-speed + the haze smear forensic
(2026-06-12).** (46b) User: "game speed too fast" — com_fixedTic 1
(iter 46) runs one sim tic per rAF callback and ProMotion iPhones rAF
at 120Hz → 2x game speed (the earlier 60Hz pace trace was a throttled
session — Safari picks per-session rAF rates!). Fix:
D3_EmscriptenFrame phase-locks engine frames to 60Hz (nextDue
accumulator +16.6667ms; >50ms behind = resync not burst; 0.5ms slop
for rAF jitter). (47) THE "ammo texture overflow" — a four-hour
forensic with a humbling chain: blend kind 5 (real fix), scissor
(real fix), aniso (real fix), then the spill PERSISTED. Isolation
modes proved the drawn quad ≠ captured data; per-record corner
projection + index dumps all clean; deltaUpload fuzzed clean (2000
frames) and traced live (uploads everything when moving). The actual
painter: the HEAT-HAZE pass — enpro's GLASS (textures/glass/* uses
heatHaze*.vfp, mag 0.4-0.5) — a pane over the weapon resampled the
scene copy WAY beyond its bounded <=13px refraction. Zero-deflection
debug (-894) blanked it; re-checking with deflection on after the
embed regen: CLEAN — the live embedded_shaders.h haze was STALE.
LAWS: (a) regenerate embedded_shaders.h on EVERY engine build sweep
(scripts/embed_wgsl.py .build/dhewm3/neo/renderer/wgsl
webgpu-port/shaders) — a stale embed renders OLD WGSL and no source
read will explain the pixels; (b) r_wgpuSingleLight 99x diagnostic
values trip the >=0 single-light filter — leaving 998 set BLACKS the
scene (only emissives draw) and fakes catastrophic regressions;
(c) debug sentinels live: -899 skip pass records / -900-N isolate
record N / -898 GPU readback (needs CopySrc usage) / -896 force full
vertex upload / -895 delta+haze trace / -894 zero haze deflection.

**Iters 45b-46 — anisotropy + the 62.5Hz micro-stutter (2026-06-12).**
(45b) GL runs image_anisotropy 16; our samplers were aniso-1 trilinear,
over-blurring oblique texture detail (the ammo grid's fat bright
lines). maxAnisotropy 16 on demoSampler + interactionMaterialSampler.
TRAP: the LOD-0 light samplers COPY msd — they inherited aniso 16 with
Nearest mip = INVALID sampler = every interaction bind group dead =
black scene; Dawn's validation text named it. Light samplers must stay
aniso-1/LOD-0 (iter-33 law) — reset maxAnisotropy after the copy.
(46) "Frame skipping" on iPhone: the ?pace probe streamed CLEAN 16.7ms
rAF (presentation exonerated) → the skip is idTech4's USERCMD_MSEC =
1000/60 TRUNCATED to 16ms = 62.5Hz sim vs 60Hz display — one
double-tic render frame every ~400ms (vanilla D3 stutters identically
on 60Hz monitors). Wearable profile now runs com_fixedTic 1 (one sim
tic per rendered frame; ~4% slowdown imperceptible at a held 60fps) —
CVAR_ARCHIVE, pinned in +set args AND autoexec. Phone-console law:
the cloudflared tunnel + console mirror turns any user report into
telemetry in minutes — keep /tmp/servelog.py + the ?pace probe.

**Iters 44-45 — the garbled weapon ammo display: TWO stacked parity
gaps (2026-06-12, user-reported from iPhone).** The machinegun's on-gun
ammo GUI looked like blocky cyan garbage. (44) BLEND: its grid/glow
stages are authored `gl_src_alpha, gl_one` with stage alpha 0.10; the
capture's blend classifier bucketed unknown blends as plain ONE,ONE
additive → 10x too bright. New blend kind 5 (srcAlpha-additive) +
passAddAlpha/guiAddAlpha pipelines. Found via GL-echo A/B + the 998
pass dump (img/color/blend per record). (45) SCISSOR: the gui's
640x480 backdrop/grid quads draw on the gui PLANE which extends past
the physical display face — GL crops via the per-drawSurf scissorRect
(r_useScissor path) which the backend never honored; the grid painted
across the gun body ("expands past the bounds" — the user spotted the
geometry overflow). Pass records now carry the GL scissor in
lightFalloffS (non-reflect records; reflect pad3=3 reuses that field)
and the replay applies it per draw — Y-FLIPPED (GL scissor origin
bottom-left, WebGPU framebuffer top-left: y' = H - (y+h)), clamped
(WebGPU validation-errors on OOB rects), reset to full canvas after
the loop. Verified at 4x exposure: contained exactly like GL.
METHOD NOTES: 998 dump now prints nv/ni + vert BOUNDS + matrix — the
bounds instantly separated "wrong geometry association" from "wrong
transform" (all 7 records shared one matrix; the 0-640x0-480 bounds
named the gui-desktop quads). EM_ASM_ with 17 args silently broke the
drain — pack dump lines via snprintf (the >5-arg trap, again).
?pace probe Chrome baseline: 16.7ms avg / 19ms max / zero spikes.

**Iter 43 — spawn loadout + flashlight-return (2026-06-12, user
requests).** (1) Player spawns with the assault rifle:
armSpawnLoadout() in main.js (entities-spawned hook, waits out the
cinematic like the flashlight) sends `give weapon_machinegun` (+3s
post-spawn; FULL classname required — `give machinegun` = "unknown
item") then taps the "4" key bind 600ms later. (2) Tapping the
flashlight chip while the light is UP returns to the rifle explicitly
(key "4" at +250ms) and reloads (key "r" at +800ms — no-op on a full
clip). 43b LAW: **impulses are bind-layer only** — the console rejects
"_impulseN" AND "use"; programmatic weapon select/reload must ride the
default.cfg binds (bind 4 "_impulse3", bind r "_impulse13") via the
move-pad's synthetic KeyboardEvent path (tapKey() in main.js). Slot
map (def/player.def): 0 fists, 1 pistol, 2 shotgun, 3 machinegun,
4 chaingun, 5 handgrenade, 11 flashlight. GOTCHA that burned an iter:
the enpro spawn default weapon is the GRENADE and its dark hand
viewmodel reads exactly like a rifle at 1/3 scale — verify weapons by
the AMMO HUD COUNT (grenade shows 5), not the silhouette. Validated:
machinegun viewmodel + clip HUD at spawn, chip tap raises light,
second tap returns the rifle.

**Iter 42 — THE REAL iPHONE KILLER: bind-group cache overflow leak
(2026-06-12, found via live phone console).** After iters 38-41 the
phone STILL died at boot. Breakthrough instrument: a console-mirror
script injected into the served page beaconing every console line to a
local collector — served over a cloudflared HTTPS tunnel because
**WebGPU needs a secure context; plain http LAN URLs have no
navigator.gpu on iOS** (which also invalidated the iOS-Simulator
"repro" — the sim has NO WebGPU at all and was silently testing the GL
fallback). The phone's own console then named the bug in order:
"pass bind-group cache full; transient groups will leak" →
"device lost: destroyed". getPassBindGroup/getMaterialBindGroup cached
to fixed arrays keyed (slot,img)/(5 images) with NO eviction; scene
churn (boot cinematic especially) stranded stale pairs until full,
then every draw created an unreleased transient group — Chrome
shrugged, the iOS GPU process died in minutes (or seconds in the
cinematic). FIX 1: round-robin EVICTION in both caches. That exposed
FIX 2: lastPassGroups/lastMatGroups keep raw handles across frames
(redraw-last path) — eviction's release invalidated them ("setBindGroup
must be an instance of GPUBindGroup" on iOS); the replay arrays now
hold their own reference (wgpuBindGroupAddRef on store, release on
replace). ALSO: stencil masks set to 0xFF (not 0xFFFFFFFF) — possible
independent iOS rejection, kept conservative; full-width masks were
never validated on-device separately. CONFIRMED ON THE IPHONE: WebGPU
init OK, 90 shadow volumes active, user PLAYED the game (first
successful iOS WebGPU session ever for this project). Also per user:
g_skill default 0 (lowest difficulty), navigator.storage.persist() at
boot (iOS evicts the 55MB IndexedDB pak cache without it; the cache
itself was already working — "Using cached bundled PK4" on 5/7
reloads). DEBUG HARNESS (reusable): /tmp/servelog.py (serves dist/ +
POST /__log), cloudflared quick tunnel, console-mirror snippet in
dist/index.html (re-inject after every vite build), Monitor tailing
/tmp/sim-console.log, QR code for the phone. LAW: anything
cached-by-pointer with a fixed cap MUST evict, never leak — and
anything HOLDING a cached handle across frames must own a reference.

**Iters 40-41 — catch-up-tick capture spike + square-canvas aspect
(2026-06-12).** Iter 39 held 60fps on iPhone but still died at the 82%
boot cinematic with shdw 221 — impossible for one frame of a ~97-volume
scene. CAUSE: the emscripten main loop runs CATCH-UP engine ticks
between rAFs under load (cinematic fast-forward = the worst case); each
tick APPENDS a full frame of capture records on top of the undrained
one, multiplying the shadow vert accumulator past its 4MB budget and
spiking per-frame staging. FIXES: (a) stale-capture guard at
RB_ExecuteBackEndCommands entry — if the previous frame was never
drained, zero ALL accumulator counters (only the latest frame matters
for replay); the counters live in tr_render.cpp with C linkage —
declare extern "C" at file scope (block-scope extern picks C++ linkage
and won't link); (b) shadowVertexBuf grows with 1.5x headroom
(exact-fit sizing reallocated on every new high-water frame during
camera flights); (c) wearable-profile JS guard parks r_shadows during
cinematics (polls window.__d3InCinematic, 100ms) — fast cinematic
cameras give the delta uploader nothing to exploit; desktop keeps
cutscene shadows. ITER 41 (user: "horizontally squeezed"): the boot
args pinned r_aspectRatio 0 (4:3) since the beginning — on the square
600x600 canvas that compresses X to 75% (circles = 3:4 ellipses).
r_aspectRatio -1 (auto, derives from real render size) in BOTH the
+set args and autoexec; fov_x now equals fov_y on square. Det rounds
1-6 IDENTICAL after both (in-view surface counts shift with the
corrected frustum — expected). TOOLCHAIN GOTCHA: /tmp/emsdk got
PARTIALLY reaped by the macOS tmp cleaner MID-SESSION (files >3 days
old deleted, dirs left) — emcc/Emscripten.cmake vanished while builds
were running an hour apart. Reinstall: rm -rf /tmp/emsdk; clone emsdk;
install+activate 6.0.0 (matches CI pin). Consider relocating to a
non-/tmp path if it recurs.

**Iter 39 — single-pass stencil shadows: mark → draw → unmark
(2026-06-12, the iPhone crash regression fix).** Iter 38's working
shadows promptly killed the iPhone ("WEBGL CONTEXT LOST" + dead
GPUDevice at 82% boot, fps 11.8, shdw 97): the iter-30 pass structure
gave every SHADOWED light a private render pass, and with real volumes
flowing that meant 10-20 passes/frame — each one a full-tile stencil
clear/store on Apple's TBDR plus WebKit per-encoder allocations. THE
ARCHITECTURE LAW: per-light stencil isolation must NOT cost a render
pass. Replacement (better than iter 30 even): ONE lighting pass total —
for each shadowed light, draw its volumes (mark stencil), draw its
interactions (GEQUAL 128), then redraw the volumes with
Increment/DecrementWrap SWAPPED (exact inverses, wraparound included)
to restore stencil to 128 for the next light. Volumes rasterize twice;
trivial against per-pass tile traffic. shadowZFail/ZPassUndoPipeline.
The >64-shadowed-lights table overflow now just mark/unmarks every
light (no pass explosion). VALIDATED: det rounds 1-6 IDENTICAL; stable
shadow signal 11.47% (iter-38 13.32, native 9.86); zero validation
errors. WebKit GPU churn re-measure still pending a Mac unlock —
do it before the next iPhone request.

**Iter 37b — Safari fps gap CLOSED + live native side-by-side
(2026-06-11/12).** With the Mac unlocked, /tmp/safari-ladder2.sh ran
against vite preview (4174) with ?fpstitle: baseline 60.1 fps /
?noshadows 59.5 / ?skipInteractions 60.0, shdw 4, wgpu-tex 22MB/501,
wasm 296MB. The historic "Safari 17fps" was a STALE PRE-ITER-30
BUNDLE (before the GPU-churn fixes); there is no Safari perf gap on
the current build — shadows are free at 60. Ladder gotchas worth
keeping: Safari fully freezes title updates when the session is
locked or the tab unfocused (three runs read frozen titles before
noticing); never measure on the Vite dev server (Safari caches dev ES
modules — build + preview). Finished with the literal deliverable the
user asked for: native dhewm3 (windowed, left) and Safari WebGPU
(right) running the same enpro corridor live on one screen —
/tmp/mac-final-pair.png; window-crop lumas 29.3 (native, includes
console-text rows) vs 14.2 (Safari crop includes black diag/letterbox
bands) — region-matched corridor luma remains 23.x on both, per the
iter-37 measurement. Remaining known cosmetic deltas tracked: ~25%
flat dim-cell overbrightness vs GL echo; GUI screens dark after
cinematic fast-forward; emissive-only flare overshoot in synthetic
light-suppressed scenes.

**Iter 32 — bloom default OFF (2026-06-11, vanilla parity).** User
call: the game doesn't have bloom (confirmed by the iter-29 research:
bloom is RBDOOM-fork-only — neither classic dhewm3 nor stock BFG has
it; we added it in iter 19 chasing reference shots). r_bloom now
defaults 0; `?bloom` opts in; the fx bloom sliders only matter when
it's on. The shadow-darken pass is UNAFFECTED (it shares bloom.wgsl's
module/BGL but its pipelines init unconditionally).

**Iter 31b — stale-bundle self-detection (2026-06-11).** The build
emits `version.txt` (same id Vite bakes into __ENGINE_VER__); main.js
fetches it with cache:"no-store" at boot. Newer id than the running
bundle → auto-refresh ONCE per version (location.replace with
&fresh=<id>, which also busts the index.html cache entry;
sessionStorage guard prevents loops while the CDN itself lags) — then
just a diag warning. Verified on vite preview: exactly one reload, no
loop. Manual cache-bypass for reference: iPhone = any new query param
or a Private tab; Mac Safari = Cmd+Opt+R or Develop → Empty Caches
(caches only, no history). NOTE: URLSearchParams serializes bare
flags as "flag=" (e.g. nodiag → nodiag=) — our \b-anchored flag
regexes still match, keep it that way.
