# DOOM 3 → WebGPU port — status

> **STATUS (2026-06): SHIPPED. WebGPU is the PRIMARY renderer.**
> The bare app URL renders the 3D world entirely through the hand-written WebGPU
> backend; GL4ES (WebGL2) is now only the fallback for browsers without WebGPU.
> The original chunky-tile problem this port set out to solve is **fixed and
> proven** on a physical iPhone. The phased "abstraction-migration" plan below
> (Phases 4–8, the ~6-month estimate) was **superseded** by a capture/replay
> approach that turned out far more tractable — see "What actually got built."

## Why this exists (still accurate)

iOS Safari WebGL's chunky-tile artifact (whole-scene per-pixel intensity drift in
the additive lit pass + tile corruption on specific surfaces) survived every
shader-level / cvar / context-attribute / texture-cap fix over a multi-hour
session. The bug lives in Apple's WebGL→Metal translation layer, below WebGL.
WebGPU goes around that layer. **This was confirmed conclusively** (see the
determinism self-test below): on a physical iPhone, the WebGPU path produces
byte-identical frames where the GL path flickers — so the chunky-tile bug is a
GL→GL4ES→WebGL→Metal stack defect, and the WebGPU port is the production fix.

## What actually got built (architecture)

The shipped port is **NOT** the planned `RenderBackend` abstraction that migrates
all 809 GL call sites one-by-one. Instead it is a **capture / replay ("echo")**
architecture, which let WebGPU be built and validated *alongside* the working GL
path without rewriting every draw call:

- **Capture (CPU side, `tr_render.cpp` + `draw_arb2.cpp` + `draw_common.cpp`):**
  the existing engine render loop runs, and a set of `D3_WebGPU_Capture*` hooks
  record each frame's draw data into CPU-side accumulators — lit-pass
  interactions (geometry + per-light/material uniforms + image pointers), stencil
  shadow volumes, emissive/shader-stage passes, fog, blend lights, sky cube dirs,
  subview links, heat-haze stages, 2D GUI records, and a per-`idImage` pixel cache.
- **Replay (GPU side, `RenderBackend_WebGPU.cpp`, ~4k lines):** at `EndFrame` the
  backend drains the accumulators, uploads geometry/uniforms/textures, and replays
  everything through WGSL pipelines (`webgpu-port/shaders/*.wgsl`, embedded into
  the wasm by `scripts/embed_wgsl.py`).
- **Cutover:** `?backend=webgpu` (now the **default** for the bare URL, iter 70)
  promotes the WebGPU canvas to the fullscreen game view and sets `r_skipGLDraw 1`
  so the GL `RB_DrawElements*` calls early-return (the capture hooks have already
  run). The engine still *computes* the GL path's vertex data (the capture reads
  it) but no longer *draws* it.
- **`?echo`** keeps both canvases side-by-side — the permanent A/B harness that
  was used to verify parity throughout, and **`?backend=gl`** forces the pure
  GL4ES path.

Shaders are **hand-written WGSL** matching the engine's ARB programs (not the
planned 60-shader RBDOOM-3-BFG HLSL→SPIR-V→WGSL port).

## Renderer feature coverage (current)

| Feature | Status | Notes |
|---|---|---|
| Z pre-pass + additive lit (interaction) pass | ✅ | shared-VS clip-z invariance; 512+ records/frame |
| Real game textures (per-`idImage` GPU cache) | ✅ | mip chains, aniso, clamp/repeat/zeroClamp modes |
| Point / projected / ambient lights | ✅ | exact specular LUT **and** BFG analytic `pow(N·H,10)` (`?bfg`) |
| Stencil shadow volumes | ✅ | single-pass mark→draw→unmark (iter 39); player-shadow + Quest-style darken (`r_shadowDarken`) |
| Fog lights / blend lights | ✅ | iter 12b / 13a — full light-type coverage |
| Sky / wobblesky cubemaps | ✅ | iter 13b (6-face CPU cube cache) |
| Subviews (mirrors / monitors) | ✅ | iter 14 render-to-texture |
| Heat-haze / `_currentRender` post-process | ✅ | iter 16 (WebGPU-native; GL had to skip it) |
| Cinematic (ROQ) dynamic textures | ✅ | iter 17 (4-slot ring; ROQ null-ptr crash also fixed) |
| Bloom | ✅ | iter 19 — WebGPU-native (vanilla/stock DOOM 3 has none); default OFF, `?bloom` |
| 2D HUD / GUI overlay | ✅ | iter 8d |
| Determinism self-test | ✅ | iter 6.8 — byte-compares two offscreen renders in-engine |
| Surface / swapchain | ✅ | `#webgpuCanvas` surface; Phase-5d "canvas conflict" was resolved by using a separate canvas |
| Reflect / screen texgens, heat-haze new-stages beyond the above | ⚠️ niche | unsupported; rare in the shipped level |
| Lightgem | ↪ GL4ES | still renders through the GL path by design (gameplay reads its pixels) |

## Verification

- **Determinism self-test (iter 6.8, the decisive instrument):** the backend
  periodically renders the identical record set twice into offscreen textures and
  byte-compares. On a **physical iPhone** it logged `IDENTICAL` while the GL view on
  the same device showed the chunky-tile flicker — the conclusive proof.
- **On-device:** real iPhone Safari WebGPU runs the game (iter 42 — first
  successful iOS WebGPU play session, after the memory/GPU-process fixes).
- **Local loop:** headed Chrome (Dawn) screenshots + the determinism self-test +
  real **Mac Safari** via `safaridriver` (the WebKit-WebGPU proxy for iOS). Note:
  WebGPU canvas readback / headless screenshots come back **black**, so honest
  verification is headed-browser screenshots, the in-engine byte-compare, or the
  device.

## Why it didn't take the estimated 6 months

The capture/replay approach sidestepped the plan's core cost (migrating 809 GL
call sites through a new abstraction while keeping GL bit-identical at every step).
By recording the existing GL path's draw data and replaying it, the WebGPU backend
could be grown feature-by-feature against a live A/B (`?echo`) with the GL path as
the reference, and cut over by simply skipping the GL draws. The bulk of the work
became renderer-feature parity + the **iOS memory/perf hardening** (the genuinely
hard part — see below), not a mechanical call-site rewrite.

## Hard-won iOS/WebKit work (the real difficulty)

- **Tab-kill / memory (iters 26–30, 42):** 256 MB initial heap + growth; skip
  redundant GL texture uploads under WebGPU-primary; per-image GPU texture budget;
  consolidated uniform buffers (one per family vs ~2,688 tiny `GPUBuffer`s — WebKit
  page-pads each); **delta vertex upload**, **redundant-submit skip**, **per-light
  pass merge** to stop the WebKit GPU-process from ballooning past ~1.7 GB; and
  round-robin **bind-group eviction** (it was leaking transient bind groups until
  the iOS GPU process died).
- **Perf (iter 24):** ~45% of CPU was busy-wait clock reads; forcing `vsynced60`
  under Emscripten removed it; `-O3 -msimd128`.
- **WebKit-only shader bugs (iters 47b, 71):** near-plane attribute interpolation
  produces inf/NaN on WebKit (not Dawn) → clamp + NaN-safe `select()` on every
  interpolated light cookie / falloff / haze offset.

## Known open / not-done (WebGPU-specific)

- **iPhone "orange panel" (iter 71/72b):** two spawn-area panels render bright
  orange on iPhone WebKit-WebGPU; correct on Chrome/Dawn **and Mac Safari** (does
  not reproduce on the Mac GPU). NaN-safe guards were added per the near-plane
  pathology, but the actual iPhone-GPU mechanism is likely a *finite* precision
  error the NaN guard can't catch — **unresolved on the real device**.
- **Reflect / screen texgens** and a few new-stage ARB effects beyond heat-haze
  are unsupported (rare in the shipped enpro level).
- **GL4ES is retained, by decision** — it's the non-WebGPU fallback, the `?echo`
  A/B harness, and renders the lightgem. "Remove the GL backend" (old Phase 8) is
  **not** going to happen.

(Separate, non-renderer threads tracked elsewhere: glasses texture-load *time*,
and the per-level-pak + iOS level-picker effort — these are content/delivery, not
WebGPU-backend, work.)

---

# Appendix — original plan (2026-06-08, SUPERSEDED)

> Kept for history. The phased abstraction-migration below was the initial plan;
> the actual port used capture/replay instead (above), so the call-site counts,
> phase breakdown, and 6-month/2-FTE estimate did not play out as written. The
> **kill criteria were all met** — notably "full DOOM 3 scene boots and renders via
> WebGPU on iPhone with NO chunky-tile artifact," which is the shipped state.

## Concrete refactor surface (measured, original)

- **94 distinct GL functions**, **809 GL call sites** across `neo/renderer/`.
- Top files: `draw_common.cpp` 243, `tr_rendertools.cpp` 221, `tr_backend.cpp` 97,
  `Image_load.cpp` 80, `tr_render.cpp` 67, `draw_arb2.cpp` 43,
  `RenderSystem_init.cpp` 22, `VertexCache.cpp` 15.

## Phased migration (original, not the path taken)

- **4a** wire `RenderBackend.h` + factory + GL/WebGPU .cpp (cvar `r_backend`).
- **4b** migrate the frame loop (`tr_backend.cpp`).
- **4c** migrate the lit pass (`draw_common.cpp`).
- **4d** texture upload (`Image_load.cpp`).
- **4e** everything else; `tr_rendertools.cpp` last.
- **5** fill in the WebGPU backend; async device init; surface on `#gameCanvas`.
- **6** port 60 RBDOOM-3-BFG HLSL shaders via DXC → SPIR-V → WGSL.
- **7** integration + iOS perf tuning + chunky-tile validation.
- **8** flip `r_backend` default to `webgpu`; remove GL backend + GL4ES.

Original estimate: 6 months at 2 FTE / 7–9 months solo. (Did not materialize as
stated — the capture/replay shortcut + the real cost being iOS hardening, not
call-site migration, changed the shape entirely.)

## Original kill criteria (all met)

- End of 4a: build doesn't regress. ✅
- End of 5: triangle renders via the backend. ✅ (the full scene does)
- End of 6: interaction shader renders one surface via new WGSL. ✅
- End of 7: full scene boots + renders via WebGPU on iPhone, no chunky-tile. ✅ **← the real test, passed**

## Update log

| Date | Note |
|---|---|
| 2026-06-08 | Original framework files committed; phased plan written (this doc's first version). |
| 2026-06-09 → 06 | Capture/replay backend built feature-by-feature (lit, textures, emissive, GUI, shadows, fog, blend, sky, subviews, haze, cinematics, bloom); determinism self-test proved IDENTICAL on iPhone where GL flickers. |
| 2026-06 | iOS memory/GPU-process hardening; WebGPU made the bare-URL default (iter 70); GL4ES retained as fallback + echo + lightgem. **Port shipped as the primary renderer.** |
| 2026-06-21 | This doc rewritten to reflect shipped status (was stale at the 2026-06-08 plan). |
