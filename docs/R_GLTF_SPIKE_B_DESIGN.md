# R-GLTF Spike-B — skinned glTF anim → idMD5Anim bridge (render↔SPINE design)

Spike-A (static glTF) is DONE + proven on Dawn. Spike-B animates a **rigged** glTF driven by the
**existing combat wire** (SPINE-verified format-blind: animNum → `CycleAnim` → idAnim → idMD5Anim).
The hard gap: dhewm3's `idMD5Anim` is text-`.md5anim`-only → build it **in-memory** from the glTF clip.
This SPANS the patch boundary (glTF parse = `neo/renderer`/RENDER; `idMD5Anim` build + registration =
`neo/anim`/SPINE), so this doc defines a CLEAN interface so each side edits only its own files.
Grounded via `wf_65f7373a-58b` (file:line evidence in the recon). **The contract is the sync point —
SPINE confirms it before either side builds.**

## The contract — a POD in `neo/renderer/Model.h` (RENDER-owned; `neo/anim` already includes it)

idlib-only types, so SPINE including it adds no renderer dependency (and RENDER never includes an anim header):

```cpp
struct gltfSkelJoint_t { idStr name; int parentNum; };   // topo-sorted root-first, parentNum<index, single root=-1
struct gltfAnimClip_t {
    idStr                  name;       // synthetic key ending ".md5anim" (the GetAnim ext-gate, Anim.cpp:968)
    int                    numJoints, numFrames, frameRate;
    idList<gltfSkelJoint_t> joints;    // order == the mesh idMD5Joint order (CheckModelHierarchy gate)
    idList<idJointQuat>    baseFrame;  // [numJoints] bind/first pose; Z-up; q normalized + w>=0
    idList<idJointQuat>    frames;     // [numFrames*numJoints] row-major; q normalized + w>=0
    idList<unsigned char>  animBits;   // [numJoints] TX/TY/TZ/QX/QY/QZ bits 0..5 (may be 0x3F = all-6)
    idList<idBounds>       bounds;     // [numFrames] or empty (SPINE derives a default)
};
struct gltfSkin_t { idList<gltfSkelJoint_t> joints; idList<idJointQuat> bindPose; };  // mesh-side skeleton, same order
```
`idJointQuat` is reused 1:1 (JointTransform.h) so SPINE assigns with no conversion. Only the POD crosses
the boundary, as a header declaration both halves already see. **One definition, in Model.h** (an
Anim.h copy would ODR-violate).

## RENDER owns (`patches/rayban-renderer.patch` → ONLY `neo/renderer/Model.cpp` + `Model.h`)
1. **Parse** glTF `skins`/`nodes`/`animations` → `gltfAnimClip_t` (reuse Spike-A's `gltfAccessor_t`/
   `GLTF_SkipValue`): topo-sort joints root-first (glTF nodes are unordered → derive parent index +
   single root), resample each channel sampler to a fixed `frameRate` (LINEAR T/S, SLERP R, STEP),
   convert **translations** `(x,-z,y)*24` (Spike-A basis) and **rotations** as a quaternion
   **conjugation** `q' = R·q·R⁻¹` (NOT a vector swizzle), then **normalize + canonicalize w≥0**
   (`idQuat::CalcW` recovers w; w is never stored).
2. **Emit a SKINNED model** — the biggest cross-cut: Spike-A's `LoadGLTF` makes an `idRenderModelStatic`
   with `NumJoints()==0`, but the combat entity resolves via `idDeclModelDef::SetupJoints` reading
   `model->GetJoints()/NumJoints()` (Model.cpp:2185/2225) and `CheckModelHierarchy` matches the anim
   joints against the model joints. So build an `idMD5Joint[]` in the **same order** as the clip joints
   and expose it via `NumJoints()/GetJoints()` (route `.glb` to `idRenderModelMD5`, or override the two
   virtuals on a skinned static). Purely RENDER-side; never touches `idMD5Anim` privates.
3. **Call** `animationLib.RegisterMemoryAnim(clip)` once per clip (the global `animationLib` is already
   linked in the monolithic HARDLINK_GAME build; Model.h carries the signature).

## SPINE owns (`patches/rayban-base.patch` → ONLY `neo/game/anim/Anim.h` + `Anim.cpp`; build is `-DBASE=ON`)
Two members (must be members — every target field is private, no setter; `JointIndex` is private):
```cpp
bool        idMD5Anim::BuildFromGLTF( const gltfAnimClip_t &clip );        // = LoadAnim minus the idLexer/file
idMD5Anim * idAnimManager::RegisterMemoryAnim( const gltfAnimClip_t &clip ); // = new+Build+animations.Set(name) (cache pre-insert)
```
`BuildFromGLTF` mirrors `LoadAnim` (Anim.cpp:161-331): `jointInfo[i].nameIndex =
animationLib.JointIndex(clip.joints[i].name)` (SAME intern table so `CheckModelHierarchy` matches),
`parentNum`, `animBits&63`, `firstComponent` = running popcount; `componentFrames` packs only the
flagged channels `[tx,ty,tz,qx,qy,qz]`; reproduce the IDENTICAL totaldelta + `baseFrame[0].t.Zero()` +
`animLength=((numFrames-1)*1000+frameRate-1)/frameRate` so speed/root-motion match a real `.md5anim`.
`RegisterMemoryAnim` pre-inserts under the synthetic `.md5anim` token so `ParseAnim`'s
`GetAnim(token)` (Anim_Blend.cpp:2451) hits the cache and NEVER file-loads. **No wire-facing class
changes** — the shipped `animNum → CycleAnim → idAnim → idMD5Anim` path resolves it byte-for-byte.

## Patch split + regen (disjoint by construction)
- RENDER scope `neo/renderer`, SPINE scope `. ':!neo/renderer'` → an `Anim.cpp` edit can never land in
  the renderer patch and a `Model.cpp` edit never in the base patch. **No CMake edit either side.**
- Shared `.build/dhewm3`: only ONE side runs `build-dhewm3.sh` at a time (it `git clean -fdq neo` +
  `reset --hard` then applies BOTH committed patches). **Each side commits its `.patch` before the
  other rebuilds.** `git add -A -N neo` before each regen. A clean build applying base→renderer with no
  reject is the regression gate that the halves didn't drift.

## Kill-criterion test (falsifiable; the proven Spike-A/Dawn harness)
Rigged GLB + a tiny `.def` listing the clip's `.md5anim` token at a known 1-indexed slot → `spawn` →
`CycleAnim(ALL, 1, …)`. ASSERT: (a) `SetupJoints` ok (`NumJoints()==clip.numJoints`, no
`CheckModelHierarchy` Error); (b) `GetAnim(token)` is a CACHE HIT (no "Couldn't load anim"; instrument
`RegisterMemoryAnim`/`BuildFromGLTF` with `window.__d3GltfAnimRegistered/Frames` via EM_ASM — Printf
doesn't reach JS); (c) joints MOVE (sample joint transform t0 vs t0+0.5s → non-zero delta on an
animated joint); (d) det IDENTICAL, zero validation errors. **Bonus:** spawn replicated → the same
animNum across the snapshot wire drives it (closes the format-blind claim end-to-end). Falsifiers:
no-op build → (c) red; wrong joint order → `CheckModelHierarchy` Error red; missing cache insert →
file-load fails → MakeDefault → (b) red.

## Risks (folded from the recon)
- `CheckModelHierarchy` HARD-fails unless anim joint count/name/parentNum EXACTLY match the mesh
  skeleton → RENDER must share ONE topo-sorted ordering between `gltfSkin_t` and `gltfAnimClip_t.joints`.
- The skinned-model `idMD5Joint[]` is easy to under-scope as "just the anim" — without it
  `SetupJoints` fails before any anim plays.
- Quaternion **conjugation** (not swizzle) for the Y-up→Z-up basis; normalize + w≥0 (RENDER discipline;
  invisible until the rig animates visibly wrong → needs an eyeball check, not just the joint-delta).
- Anim length-match: a glTF clip mixed on one channel with a real `.md5anim` of different duration →
  MakeDefault (`Length()` check, Anim_Blend.cpp:2462).
- Phone is the final gate (Dawn-only here); skinned per-frame vert churn interacts with the iter-28/30
  delta-upload/GPU-RSS paths tuned for static geometry — measure on device.

## Status
Design complete + grounded. **BLOCKED on SPINE confirming the contract + implementing the two
`neo/anim` methods** (the SPINE ask is handed to the owner). On SPINE's go: RENDER builds the parser +
skinned model + the call, then runs the kill-criterion test (Dawn), then the phone gate.
