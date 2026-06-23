# R-GLTF Completion Plan — CPU Vertex Skinning + Falsifiable Full-Animate Gate

**Status:** APPROVED 2026-06-22 — building. Locked: do R-GLTF completion next; definition of done = **Dawn-green + deferred device gate** (DD); DA/DB/DC = the recommended defaults (per-model `gltfBaseVerts`; scalar 4-influence loop; normalize weights + NaN guard). RENDER/PERF track (Session D), `render-track`.
**Produced by:** read-only recon (4) → design → 3-lens adversarial review → synthesis (workflow `wf_62d6c088`; 0 blocked, 6 critical holes, all resolved into the phases below).
**Prereq commit:** Spike-B green (`72ac716`).

## What this milestone is

Spike-B already bridges a skinned glTF's **skeleton + animation** into the shipped combat wire — the skeleton is exposed (`NumJoints`/`GetJoints`/`GetDefaultPose`), and `D3_RegisterGltfAnim` builds an in-memory `idMD5Anim` so `animNum → CycleAnim → idAnim → idMD5Anim` resolves. **But the model never visibly deforms:**

- `idRenderModelStatic::InstantiateDynamicModel` returns `NULL` for skinned glTF (`Model.cpp:1084`).
- `LoadGLTF` **discards** the per-vertex skin data needed to deform — the primitive loop reads only `POSITION/NORMAL/TEXCOORD_0` (`Model.cpp:711-713`); `JOINTS_0`/`WEIGHTS_0` are never read; `gltfSkin_t` holds only `joints[]`+`bindPose[]` (`Model.h:191`).

This milestone implements **CPU-side matrix-palette skinning** in `InstantiateDynamicModel`, mirroring the native MD5 path (`idMD5Mesh::UpdateSurface → SIMDProcessor::TransformVerts → R_DeriveTangents`), so an animated glTF entity's **rendered vertices move**. Every edit stays inside `neo/renderer` (`Model.cpp`/`Model.h`/`Model_local.h`/`tr_render.cpp`) + `webgpu-port` + `scripts`. **The WebGPU capture-replay backend needs ZERO change** — it consumes already-deformed `idDrawVert` from `srfTriangles_t::verts`, deterministically.

### Three verified facts that shaped the design (and killed reviewer red-herrings)

1. **Native `TransformVerts` skins ONLY `verts[i].xyz`, NOT normals.** Normals/tangents are re-derived by `R_DeriveTangents` from the deformed positions (`tr_trisurf.cpp:1695`). So we **do not hand-skin normals** — that removes a whole class of inverted/backlit-normal bugs and is native-parity by construction.
2. **The deform happens at capture time** (before `EndFrame` drains `g_capVertsAccum`), so the `__d3WgpuDet` self-test re-renders byte-identical records → **determinism holds**.
3. **The animate DRIVE needs NO SPINE edit.** The shipped `testmodel`/`testanim` console path drives `CycleAnim` on any dynamic model — the kill-criterion test stays 100% in-bounds (`neo/renderer` + `scripts`).

## Recommendation — do this next, before M4 soft-shadows

It is the **last step of in-flight, content-BLOCKING work**: content-forge is holding its MD5 writer until the rigged-glTF path passes a phone spike. The skeleton/anim bridge is already shipped and green, so only this CPU-skin increment + its gate stand between content-forge and shipping enemies/weapons. M4 soft-shadows is pure-rendering polish with **no cross-track dependency and no consumer waiting** — it waits one slot. The work is small/bounded (~250–350 lines, all in 4 renderer files I own), the reference (MD5) is proven and right next door, and the backend is untouched.

## ⚠ Hard prerequisite (a real finding)

**`scripts/make-rig.py` is MISSING from the repo** (verified: not in `scripts/`, not tracked). The rigged fixture `public/wasm/spike-rigged.glb` exists only as a gitignored local file with **no committed generator** — it was created in a prior session and lost when the worktree branched. **The kill-criterion is untestable until the rig generator is reconstructed and committed.** That is Phase 0.

## Phases

### P0 — Rig fixture generator + falsifiable harness scaffolding (HARD PREREQUISITE) · ~½ day
Pure `scripts/`, no engine edit.
- **`scripts/make-rig.py` (NEW):** self-contained GLB writer (JSON + BIN chunks, no fragile external dep — or a pinned dep with a clear setup error) emitting `public/wasm/spike-rigged.glb`: a 2-joint skeleton, a rotation clip (≥2 keyframes spanning a clear arc), a mesh with `JOINTS_0` (ubyte vec4) + `WEIGHTS_0` (float vec4, Σ=1.0) + an `inverseBindMatrices` accessor. **At least one vertex weighted fully to the animated (non-root) joint and offset from the rotation axis** so its world position moves measurably (>0.1 D3 units) at the clip extreme — **print the expected frame-0 vs frame-N delta** so the gate threshold is *derived, not guessed*.
- **`--validate` mode:** re-read the emitted GLB and assert the accessor layout (component types, counts, weight-sum≈1.0) — this doubles as the **contract content-forge's rigs must match**.
- **`scripts/gltf-spike.mjs`:** add a full-animate sequence after `testmodel` — `testanim <clip>`, step time, collect `window.__d3SkinnedVertPos_W` at clip start vs extreme. Keep all existing mesh/skeleton/anim/register/det checks (don't weaken `regOk`).

**Gate:** `make-rig.py` emits a GLB that `--validate` accepts and prints a concrete expected delta > 0.1 units; existing `gltf-spike.mjs` still green on the regenerated fixture.

### P1 — Per-vertex skin data capture during glTF load · ~1 day
Data-gathering only, no deform math. All `neo/renderer`.
- **`Model.cpp`:** extend `gltfPrim_t` with joints/weights accessor indices; in the attr loop also read `JOINTS_0`/`WEIGHTS_0`. Assert a single JOINTS accessor (warn+ignore `JOINTS_1` → >4 influences truncated).
- **`Model.cpp`:** in the skins parser read `skins[0].inverseBindMatrices`; decode the float4×4 array and convert glTF column-major → `idJointMat` (idTech4 row-major 3×4), applying the **same Y-up→Z-up basis change already proven for joints** (`GLTF_BasisTrans`/`GLTF_BasisRot`). Add a load-time rest-pose round-trip assert.
- **`Model_local.h`:** add **private** storage on `idRenderModelStatic` (no new public getters to game/anim — keep the bridge contract clean): per-vertex `jointIndices[4]` + `weights[4]`, `idList<idJointMat> gltfInverseBind`, and a **per-model `idList<idDrawVert> gltfBaseVerts`** (immutable base frame, cloned at load, freed in the dtor) — owner-decision **DA**.
- **`Model.cpp`:** normalize weights to Σ=1.0 (owner-decision **DC**); guard Σ<0.001 → `weight[0]=1` (NaN guard); one-shot warn on >5% deviation. Clone each surface's verts into `gltfBaseVerts` after `AddSurface`.

**Gate:** rigged fixture parses N joint/weight tuples + the inverse-bind array (temp EM_ASM beacon asserts counts); default boot + Spike-A static path stay byte-identical (det IDENTICAL, no new warnings); rest-pose round-trip assert passes. Still renders undeformed (no deform yet).

### P2 — CPU-side vertex deformation in `InstantiateDynamicModel` · ~1–1.5 days (most risk here)
All `neo/renderer`.
- **`InstantiateDynamicModel`:** replicate `idRenderModelMD5::InstantiateDynamicModel` structure — guard `ent->joints != NULL` and `ent->numJoints == gltfJoints.Num()` (else `Printf`+`NULL`, native parity); reuse/alloc a cached `idRenderModelStatic` keyed on `r_useCachedDynamicModels`; loop surfaces, deform each, `AddPoint` bounds, return the deformed model.
- **New deform helper (modeled on `idMD5Mesh::UpdateSurface`):** alloc/reuse the output `srfTriangles_t` (`R_AllocStaticTriSurf`, `deformedSurface=true`, `tangentsCalculated=false`), copy base verts → output, then **deform xyz ONLY** via matrix-palette accumulation: `v = Σ weight[j] · (inverseBind[joint[j]] · entJoints[joint[j]]) · baseXyz`. Pre-multiply `inverseBind` into the joint at frame start (a per-frame palette) so the inner loop is one mat·vec per influence — exactly `TransformVerts` semantics. **Do NOT skin normals.**
- **After positions:** `R_BoundTriSurf` then `R_DeriveTangents` to re-derive normals/tangents from the deformed positions — the load-bearing native-parity point.
- **`tr_render.cpp`/`draw_arb2.cpp` (verify-only, expected NO change):** confirm the capture hooks read `surf->geometry->verts` as-is and the deformed surface is captured **before** `EndFrame` drains. Document the frame-order invariant in a comment.
- **Owner-decision DB:** scalar 4-influence loop (recommended) vs wrapping into MD5's SIMD `TransformVerts`.

**Gate:** rigged fixture under `testmodel`+`testanim` renders **deformed** (visible non-rest pose at the clip extreme) on Dawn; det IDENTICAL with the animated mesh present; rest pose (frame 0) renders sanely (no inverted/exploded geometry); zero validation errors. (Quantitative motion asserted in P3.)

### P3 — Falsifiable full-animate kill-criterion gate (Dawn) · ~½ day
One EM_ASM hook in `neo/renderer` + `scripts`.
- **`tr_render.cpp`:** in the surface-capture path, when the captured surface's source model `GetJoints() != NULL` AND it's the FIRST skinned surface this frame, publish `window.__d3SkinnedVertPos_W = [x,y,z]` (`verts[0].xyz` × the record's baked MVP) + increment `__d3SkinnedVertMeasuredFrames`. `;`-separated EM_ASM statements (the comma trap).
- **`gltf-spike.mjs`:** assert `‖pos[extreme]−pos[start]‖ > threshold` (from `make-rig.py`) **AND** `__d3SkinnedVertMeasuredFrames ≥ 2` (false-green guard: mesh drawn in both compared frames — culled/never-animated → 0/1 → vacuous → RED) **AND** det IDENTICAL with the animated mesh **AND** zero console errors. Compound verdict logged.
- **Mutation proof (kept out of the shipped patch):** a debug build whose deform loop ignores weights and writes `baseXyz` unchanged (identity pose) — the gate MUST go RED (delta ≈ 0). This is the single instrument that proves the gate measures *rendered-vertex motion*, not merely that joints moved.
- **Frozen-pose determinism check:** run det with `timescale 0`/`g_stopTime` so both det rounds see the identical pose → byte-identical deformed output (proves the skinning math itself is deterministic).

**Gate (GREEN requires ALL):** (1) delta > threshold; (2) measured frames ≥ 2; (3) `__d3WgpuDet` IDENTICAL (animated + frozen); (4) zero errors. **PROVEN-FALSIFIABLE:** the identity-pose mutation drives it RED. Regression: default boot + Spike-A det IDENTICAL; R0 tonemap LUT maxErr=0 unaffected.

## Kill-criterion (the milestone's definition of done, Dawn)

Drive an animation via the shipped `testmodel`/`testanim` (`CycleAnim`) path and **prove the rendered vertices physically move between two animated poses** (clip start vs extreme) — not merely that the joints moved. Measured on the synthetic rig where ≥1 vertex is weighted fully to the animated joint and offset from the rotation axis. **Falsifiable:** RED if delta < threshold, OR measured-frames < 2 (vacuous), OR det not IDENTICAL; **proven** by the identity-pose mutation going RED.

## Risks → mitigations

| Risk | Mitigation |
|---|---|
| **BLOCKER:** `make-rig.py` missing → kill-criterion untestable | P0 reconstructs + commits it; emits the content-forge contract; prints the gate threshold |
| Hand-skinning normals would diverge from native | Skin xyz only; `R_DeriveTangents` re-derives — native-parity by construction |
| Determinism break (uninit mem / FP order) | Deform at capture time (same verts frozen + re-rendered); clear output verts; fixed influence order; P3 frozen-pose det check |
| Inverse-bind conversion silent-wrong (col-major + Y→Z) | Reuse the joint basis helpers; load-time rest-pose round-trip assert; harness rest-pose sub-check |
| iPhone GPU-process churn (iter-30) — theory, not device-measured | Bound to ONE small mesh (delta-upload handles it); defer on-device RSS re-measure to the phone-gate follow-up; **don't claim phone-safe until measured** |
| Base-vert storage grows resident memory (~60B/vert) | Read-only after load, bounded by one-mesh assumption; add LRU only if measured pressure later |
| Patch-regen footguns | No shaders touched (`embedded_shaders.h` untouched); regen ONLY `rayban-renderer.patch`; emsdk-600; never touch base-patch/game/anim |

## Owner decisions to lock before code

- **DA — base-vert storage:** per-model `gltfBaseVerts` + per-surface offset *(recommended)* / reuse `ambientSurface` / inline base-xyz in `idDrawVert`. → **Recommend per-model list** (clean ownership, freed in dtor, never penalizes static models).
- **DB — skinning impl:** scalar 4-influence loop *(recommended)* / wrap into MD5 SIMD `TransformVerts` / both. → **Recommend scalar** (~20 lines, glTF layout differs from MD5's scaledWeights; sub-µs win on one mesh; easier to audit; SIMD is a clean later follow-up).
- **DC — non-normalized weights:** normalize + one-shot warn + NaN guard *(recommended)* / strict reject / clamp-and-pass. → **Recommend normalize** (glTF spec expects normalized; content-forge rigs validate clean).
- **DD — phone-gate scope (definition of done):** ship correctness green-on-Dawn + defer the device gate *(recommended, matches R0/Spike-A/Spike-B)* / block the milestone on a full iPhone pass + iter-30 RSS re-measure. → **Recommend Dawn-green + deferred device gate** (cross-track unblock only needs the Dawn-proven path; don't claim phone-safe until the on-device RSS re-measure).

## Out of scope
Any edit to `neo/game`/`neo/anim`/`rayban-base.patch` (SPINE); WGSL/backend changes (backend is skinning-agnostic); GPU-side skinning (breaks det + churn model); on-device iPhone validation (deferred follow-up); PBR/IBL/`.mtr` for glTF (content-forge + the modern-renderer program); M4 soft-shadows and the rest of the roadmap (sequenced after this); perf refinements (frame-skip, multi-instance sort, base-vert LRU) — only if future measured pressure justifies; real enemy/weapon glTF content (no rigged content GLB exists yet — the milestone proves the engine path on the synthetic fixture, which is what content-forge gates on).
