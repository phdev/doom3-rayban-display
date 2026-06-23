# RENDER attestation — R-GLTF Dawn-green (NOT yet phone-green)

**This is the DAWN attestation. It is deliberately named `RENDER_DAWN_GREEN.md`, not
`RENDER_PHONE_GREEN.md`.** Content-forge's converter-deletion step keys off
`RENDER_PHONE_GREEN.md`; that file is intentionally **NOT created yet** because the
phone gate is deferred (owner decision) and the full combat-drive needs a one-line
SPINE change (below). **DO NOT delete the MD5 or LWO writers on the basis of this
file.**

```
attestation: render-track
dawn_green: true
phone_green: false            # deferred per owner decision DD; iPhone is the final gate
combat_drive_green: false     # blocked on SPINE Anim_Blend.cpp:2622 (.md5mesh-only modelDef mesh)
delete_md5_writer: NO
delete_lwo_writer: NO
```

## What IS proven green (Dawn / Chrome WebGPU, headed)

Engine commit: **`dfb8115`** on `render-track` (builds on Spike-A `512e66a`, Spike-B `72ac716`).
Instrument: `scripts/gltf-spike.mjs` (+ `scripts/det-check.mjs`), emsdk-600, clean build.

| Criterion | Result |
|---|---|
| Static glTF/GLB loads + builds surfaces + renders through the WebGPU capture-replay backend | ✅ (Spike-A; surfaces=1, det IDENTICAL, zero backend change) |
| Skinned glTF parses skin+anim → in-memory `idMD5Anim` via SPINE's bridge; register fires | ✅ (Spike-B; animJoints=2, animFrames=25, `__d3GltfAnimRegistered=1`) |
| Per-vertex JOINTS_0/WEIGHTS_0 captured; weights normalized + NaN-guarded | ✅ (skinVerts=8) |
| **Skinning math correct** — rest-pose reconstruction `‖Σw·bindMat·localPos − base‖` | ✅ **maxErr = 0** |
| **CPU skinning DEFORMS rendered verts under an animated pose** | ✅ **probe MOVED 10.18 D3u** (threshold 0.1), measuredFrames=2 |
| Determinism self-test with the skinned path exercised | ✅ `__d3WgpuDet` IDENTICAL |
| **Gate is falsifiable** (not a vacuous pass) | ✅ `+set r_gltfSkinIdentity 1` → deform 0.000 D3u → **gate RED (exit 1)** |
| No regression | ✅ default boot det IDENTICAL; R0 tonemap LUT maxErr=0 + det IDENTICAL |

Reproduce:
```
# clean engine build (CI-equivalent): emsdk-600 + gl4es-600, build-dhewm3.sh
npm run build && npx vite preview --port 4185
node scripts/gltf-spike.mjs                                                   # GREEN, EXIT 0
GLTF_URL=".../?backend=webgpu&args=%2Bset%20r_gltfSkinIdentity%201" node scripts/gltf-spike.mjs   # RED, EXIT 1 (falsifiability)
```

## What is NOT green (the two gates content-forge cares about)

1. **PHONE (on-device iPhone WebGPU).** Deferred per owner decision DD — Dawn is the
   correctness oracle (headless reads WebGPU black; Playwright WebKit has no
   `navigator.gpu`). The physical-iPhone pass + the iter-30 GPU-process-RSS re-measure
   for a per-frame-deforming mesh are a scheduled follow-up. **No phone claim is made.**

2. **Full idAnimator / CycleAnim combat-drive of a `.glb`.** BLOCKED by one line of
   SPINE's code: `idDeclModelDef::Parse` rejects a modelDef whose mesh extension isn't
   `.md5mesh` (`neo/game/anim/Anim_Blend.cpp:2622`, "Invalid model for MD5 mesh").
   Everything *after* that check uses only the abstract `IsDefaultModel()`/`NumJoints()`/
   `GetJoints()` interface our skinned glTF model implements — so the precise fix is for
   SPINE to also accept `.glb`/`.gltf` at that check. Until then the deform is proven by
   the renderer's own self-test (it drives the real `InstantiateDynamicModel` with a
   synthesized animated pose); the `animNum→CycleAnim→idMD5Anim` *anim* path is already
   format-blind (Spike-B), only the *model/modelDef binding* is `.md5mesh`-locked.

## Path to `RENDER_PHONE_GREEN.md` (the deletion gate)

Will be created — with the engine SHA + the specific criterion — only when BOTH:
- the physical-iPhone WebGPU pass renders + animates the rigged fixture (load+skin+deform), and
- the combat-drive works end-to-end (after SPINE's `Anim_Blend.cpp` extension relax) OR
  the owner explicitly accepts the renderer-self-test drive as sufficient for deletion.

Until that file exists with `delete_md5_writer: YES` / `delete_lwo_writer: YES`, keep both writers.
