# DOOM 3 → WebGPU port plan

## Why this exists

iOS Safari WebGL's chunky-tile artifact (whole-scene per-pixel intensity drift in the additive lit pass + visible tile corruption on specific surfaces) survived every shader-level / cvar / context-attribute / texture-cap fix we tried over a multi-hour session. The Web Inspector recording proved the engine's WebGL command stream is deterministic — the bug lives in Apple's WebGL→Metal translation layer, below WebGL. The Phase 3 WebGPU validation (commit `4df6580`, `wall.html`) rendered a clean lit brick wall via WebGPU on the same iPhone with NO chunky-tile artifact, confirming that going around the WebGL→Metal path via WebGPU is a real solution.

## Where we are right now

| Phase | Status | Output |
|---|---|---|
| 1 | ✅ done | `--use-port=emdawnwebgpu` Emscripten port building, Dawn snapshot cached |
| 2 | ✅ done | `webgpu-test/triangle.cpp` — colored triangle renders via WebGPU |
| 3 | ✅ done | `webgpu-test/wall.cpp` — DOOM-3-style lit brick wall renders, validated on iPhone |
| **4** | **in progress** | **Renderer abstraction layer + WebGPU backend stub (this commit)** |
| 5 | pending | Migrate dhewm3 call sites to `idRenderBackend` interface |
| 6 | pending | Implement WebGPU backend operations (replace stubs) |
| 7 | pending | Port DOOM 3 shaders RBDOOM-3-BFG HLSL → SPIR-V → WGSL |
| 8 | pending | Integration + iOS perf tuning + chunky-tile validation |

## Files committed in this Phase 4 starting commit

```
webgpu-port/
├── WEBGPU_PORT_PLAN.md            ← this file
└── engine/
    ├── RenderBackend.h            ← abstraction interface
    ├── RenderBackend_factory.cpp  ← runtime backend selection
    ├── RenderBackend_GL.cpp       ← current-behavior wrapper (pass-through)
    └── RenderBackend_WebGPU.cpp   ← skeleton; all methods fail-loud
```

These files are NOT yet wired into the engine build. They're committed as the framework that subsequent phases will integrate.

## Concrete refactor surface (measured)

- **94 distinct GL functions** across `.build/dhewm3/neo/renderer/`
- **809 GL call sites** total
- Top files by call density:
  - `draw_common.cpp` — 243 calls (the lit pass; highest priority)
  - `tr_rendertools.cpp` — 221 calls (debug renderer; lowest priority)
  - `tr_backend.cpp` — 97 calls (frame loop; second priority)
  - `Image_load.cpp` — 80 calls (texture upload; third priority)
  - `tr_render.cpp` — 67 calls
  - `draw_arb2.cpp` — 43 calls (ARB shader binding; replaced by WGSL)
  - `RenderSystem_init.cpp` — 22 calls
  - `VertexCache.cpp` — 15 calls

## Migration sequence (Phase 4 → 8)

### Phase 4a — wire the interface (~3 days)
1. Add `RenderBackend.h` + the three .cpp files to `neo/renderer/CMakeLists.txt`
2. Add cvar `r_backend` (default `"gl"`) in `RenderSystem_init.cpp`
3. Instantiate `renderBackend` after `GLimp_Init` succeeds
4. Build, verify zero behavior change (still uses qgl* everywhere)

### Phase 4b — migrate frame loop (~1 week)
- Target: `tr_backend.cpp` (97 sites)
- Replace `RB_*` frame-level functions with `renderBackend->BeginFrame()` / `EndFrame()` / `BeginRenderPass()` / `EndRenderPass()`
- Each migrated function: GL backend still calls qgl* under the hood, so behavior is bit-identical

### Phase 4c — migrate the lit (interaction) pass (~2 weeks)
- Target: `draw_common.cpp` (243 sites) — the heaviest file, the lit pass that contains our chunky-tile bug
- This is where bind groups + pipeline state become first-class
- After this phase, the lit pass is fully abstracted; flipping to WebGPU backend would render the lit pass via WebGPU exclusively

### Phase 4d — migrate texture upload (~1 week)
- Target: `Image_load.cpp` (80 sites)
- DDS / S3TC / BPTC decompression maps to WebGPU's CompressedTexture sub-image upload

### Phase 4e — everything else (~1 week)
- `tr_render.cpp`, `VertexCache.cpp`, `RenderSystem_init.cpp`, smaller files
- Leave `tr_rendertools.cpp` last (debug code; not user-facing)

### Phase 5 — WebGPU backend implementation (~6 weeks)
- Fill in `RenderBackend_WebGPU.cpp` stubs
- Each abstraction method gets a real implementation
- Async init (adapter/device request) integrated into engine boot
- Surface creation tied to existing `#gameCanvas`

### Phase 6 — shader port (~4 weeks, parallelizable with Phase 5)
- Set up DXC for RBDOOM-3-BFG HLSL → SPIR-V → WGSL pipeline (tooling work, ~3 days)
- Port shaders one at a time in priority order:
  1. `interaction.ps.hlsl` (we already validated WGSL feasibility in Phase 3)
  2. `interactionAmbient.ps.hlsl`
  3. `texture.ps.hlsl` (GUI)
  4. `depth.ps.hlsl` (zfill)
  5. shadow / blendlight / fog / postprocess

### Phase 7 — integration + perf tuning (~3 weeks)
- Wire the WebGPU backend up; runtime-switchable via `r_backend "webgpu"`
- Bug-bash on iPhone Safari WebGPU; address the iOS-specific gotchas surfaced in research (64-cmdbuf jetsam limit, mesh-shader translation bugs, surface format quirks)
- Benchmark against GL backend; tune for the 3-shader-bind-group iOS limit

### Phase 8 — cutover + cleanup (~2 weeks)
- Flip `r_backend` default from `"gl"` to `"webgpu"` once stable
- Remove the GL backend code path (or leave behind a `?backend=gl` URL flag as a fallback)
- Remove GL4ES from the dependency tree
- Strip our extensive `src/main.js` JS-side WebGL workarounds (pow strip, falloff fix, etc.) — they all become moot

## Realistic total: 6 months at 2 FTE, 7–9 months solo

(per the Exa-validated case studies: Bevy 4–8 person-months, Godot 6–9 months solo, NAP framework 7 person-months for OpenGL→Vulkan)

## Kill criteria along the way

- **End of Phase 4a**: build doesn't regress. If GL behavior changes, the wrapper has a bug.
- **End of Phase 5**: triangle renders via WebGPU backend through the abstraction layer (not just standalone like Phase 2 already does).
- **End of Phase 6**: at least the interaction shader renders one DOOM 3 surface correctly via the new WGSL.
- **End of Phase 7**: full DOOM 3 scene boots and renders via WebGPU on iPhone, with NO chunky-tile artifact. ← The Real Test.

If any of these fail, we re-evaluate whether to continue.

## Open design questions

- **Vertex layout**: DOOM 3's `idDrawVert` is fixed (position + normal + tangent + bitangent + texcoord + color). Should the abstraction assume this layout (simpler), or be generic (more flexible, more overhead)?
  - Lean: assume idDrawVert. The engine never deviates.
- **Render bundles**: WebGPU supports replayable command bundles. The engine's draws within one render pass are highly repetitive — should we generate bundles to reduce per-cmdbuf overhead?
  - Lean: yes, in Phase 7 perf-tuning. Skip during initial port.
- **Threading**: emdawnwebgpu objects can't cross threads. dhewm3 is mostly single-threaded but does `com_smp` multithreading. Disable `com_smp` for WebGPU backend, or solve threading?
  - Lean: disable `com_smp` for WebGPU (matches our current mobile profile anyway).

## Update log

| Date | Phase | Note |
|---|---|---|
| 2026-06-08 | 4 | Framework files committed; not yet wired into engine build |
