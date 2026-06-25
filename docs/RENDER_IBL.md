# R-IBL (Full PBR look) — image-based lighting on the WebGPU backend

**Status: render-track half GREEN on Dawn (2026-06-25, `render-track`). P5 content-join + P6 phone deferred.**

Adds image-based lighting — cosine-convolved **diffuse-irradiance ambient** + Karis **split-sum
specular reflections** — on top of the shipped PBR-P0 direct-GGX operator, so isPBR surfaces read as
modern metallic/roughness materials instead of near-black-where-unlit. Scoped to isPBR records, so the
legacy DOOM 3 world stays byte-identical.

## What shipped (render-solo, Dawn-green, falsifiable)

- **P0 — N/V/R plumbing.** The lit pass was entirely tangent-space. The VS now also passes the
  **model-space TBN basis + model-space view vector** (`m_tangent`/`m_bitangent`/`m_normal`/`view_model`,
  `@location(8..11)`); `fs_main` rotates the tangent-space normal map into model space and derives the
  view + reflection vectors. **No captured matrix was needed** — `view_origin_tangent.xyz` is already the
  model-space view origin, and for static world geometry model space == world space (the synthetic probe
  is model-space-defined, so the solo gate is self-consistent). The per-record uniform grew `224 → 256`
  bytes (the `Uniforms` struct gained `ibl`/`ibl2` vec4s; the slot already strides `kUBStride=256` so no
  buffer realloc). The drain **explicitly zero-fills `ub[56..63]` for every record** (the OFF-identity +
  determinism guarantee) and sets the IBL params only for isPBR records when `r_ibl` is on.
  - ⚠ All four interaction-module `group(0)` bindings had to grow to 256 in lockstep — the record bind
    group, the record-depth + pass-depth bind groups (`depthPipeline` shares interaction `vs_main`, so
    `bglDepth`'s minBindingSize is the full 256-byte struct), and the PBR self-test buffer/binding.
- **P1 — diffuse irradiance.** `irr = synth_irradiance(N)`; roughness-aware Fresnel `F_rough`;
  `kd = (1-F_rough)(1-metallic)`; `diffuseIBL = irr·albedo·ao·kd·r_iblDiffuseScale`.
- **P2 — specular split-sum.** `pref = synth_radiance(R, roughness·(maxMip-1))`; the **analytic Karis
  mobile `EnvBRDFApprox`** (no LUT — saves a binding/sampler/residency on WebKit) folds F0 into the
  scale/bias; horizon fade; `specIBL = pref·(F0·sb.x+sb.y)·ao·horizon·r_iblSpecScale`.
- **Single-shader accumulation.** Both IBL terms are summed into the float `color` register **inside
  `fs_main`, before the gamma/clamp store** — direct + IBL share one 8-bit clamp point (no inter-pass
  re-quantize). This is the HDR-*accumulation* benefit without an HDR *framebuffer* (the owner's
  RGBA16F-framebuffer kill is untouched; honest ceiling: mirror-bright speculars still clamp at 8-bit).
- **P3 — synthetic probe.** The irradiance/radiance are **procedural + directionally varying** (a
  hemispherical gradient + a single radiance lobe) so the look is Dawn-provable with NO content cubes and
  the N-space/reflection mutations are non-vacuous. `ibl_ambient()` is format-agnostic — at P5, swap
  `synth_*` for `textureSampleLevel(cube,…)` and the math is unchanged.

## Cvars

`r_ibl` (0), `r_iblDiffuseScale` (0.4, keep LOW so a PBR surface integrates with the near-black world),
`r_iblSpecScale` (1.0), `r_iblMaxMip` (5), `r_iblMutate` (0, falsifiability A/B). Demo on Dawn:
`?args=+set r_pbrTest 1 +set r_ibl 1` (synthetic ORM gives every surface a chosen metal/roughness so the
IBL look is visible before content's ORM lands).

## Gate (`scripts/ibl-verify.mjs`, Dawn)

| arm | result |
|---|---|
| operator (maxErr≤2) | `__d3IblSelfErr` **0** — `fs_ibl_selftest` drives the REAL `ibl_ambient`+synth probe for 2 known configs (dielectric + metal), byte-compared to the C++ `ibl_cpu` mirror ✓ |
| determinism | `__d3WgpuDet` **IDENTICAL** (default + IBL-on) ✓ |
| PBR-P0 unregressed | `__d3PbrSelfErr` **0** after the 224→256 grow ✓ |
| falsifiable | `r_iblMutate 1` halves the term while the CPU mirror stays correct → `__d3IblSelfErr` **32** → RED ✓ |
| OFF-identity | default boot (no isPBR surfaces) det IDENTICAL — `ub[56]==0` for legacy by construction ✓ |

Visual A/B confirmed on Dawn: `r_ibl 0` = near-black metal where unlit; `r_ibl 1` = the corridor lights
up with ambient + metal reflections (`shaderErrs: 0`).

## Deferred

- **P5 — content-forge join (UNBUILT + R-GLTF-blocked).** Real per-area cube probes: CONTENT bakes a
  32px **R11G11B10F irradiance** cube (`_irr`) + a roughness-prefiltered radiance cube (`_rad`, LDR ok)
  per probe via `cameraCubeMap .mtr`, ≤32 probes, per-area centroid; plus an area→probe manifest. RENDER
  adds an area-centroid dump command, area-keyed probe selection (boot-preloaded into fixed cube slots —
  no per-frame churn; the cube cache has no eviction), a separate per-area IBL bind group (NOT the
  per-record material group), and the per-material `isPBR` ORM-name detector. Also gated on R-GLTF (no
  ORM GLB loads yet). The irradiance cube **must** be R11G11B10F (8-bit re-bands the near-black lift).
- **P6 — iPhone phone gate (owner decision DD).** Mobile invariants hold by construction (explicit-LOD
  only, single-cube-per-area, boot-preloaded slots, self-test `g_capDetTest`-gated off the player path).
  Deferred to the iPadOS-26.5 WebKit rig when free.

Build: emsdk-600; WGSL change → `embed_wgsl.py` regenerates `embedded_shaders.h` before the patch regen;
regen ONLY `patches/rayban-renderer.patch`. Plan: this milestone's workflow synthesis (`full-pbr-look-plan`).
