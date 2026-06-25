# SPINE ASK 1 — Relax the modelDef mesh-extension check to accept `.glb`/`.gltf`

**Owner:** SPINE (`neo/game/anim/Anim_Blend.cpp`, in `rayban-base.patch`) · **Requested by:** RENDER (render-track)
**Status:** code-verified ask; adversarial verdict = HOLDS-WITH-CAVEAT.

**Summary:** A one-line relaxation lets a modelDef bind a glTF mesh, so the unmodified
`idAnimator` combat wire drives a CPU-skinned glTF enemy. The R-GLTF loader, CPU vertex skinning,
and in-memory anim registration are already shipped and Dawn-green (`docs/RENDER_DAWN_GREEN.md`);
this check is the sole remaining hard gate for *parse-and-animate*.

## The change (the exact diff SPINE makes)

In `idDeclModelDef::Parse`, the `"mesh"` token handler, **`Anim_Blend.cpp:2622`**:

```cpp
// before
if ( extension != MD5_MESH_EXT ) {
// after
if ( extension != MD5_MESH_EXT && extension.Icmp("glb") != 0 && extension.Icmp("gltf") != 0 ) {
```

That is the entire functional change (`MD5_MESH_EXT == "md5mesh"`, `renderer/Model.h:45`). Nothing
else in `Parse` or `ParseAnim` is edited.

## Why it's safe (code-grounded)

Everything after the check touches the model only through the abstract `idRenderModel` interface,
all of which our glTF model (`idRenderModelStatic`) implements:
- `FindModel(filename)` dispatches on extension → `LoadGLTF` (shipped, Dawn-green).
- `IsDefaultModel`/`NumJoints`/`GetJoints`/`GetDefaultPose`/`GetJointName`/`GetJointHandle` are all
  real glTF impls (`Model.cpp:189,1341,1350,1381,1371,1359`); `gltfDefaultPose` is non-NULL.
- The joint-parent loop (`2647–2663`) and `SetupJoints` (`2330`, uses only
  `NumJoints`/`GetDefaultPose`/`Bounds`) are interface-driven — format-agnostic by construction.
- The `anim` token resolves through `animationLib.GetAnim` (`Anim_Blend.cpp:2451`). RENDER
  pre-registers the glTF clip via `D3_RegisterGltfAnim` → `RegisterMemoryAnim` (`Anim.cpp:1150`),
  so the lookup is a **cache hit** and never file-loads. `GetAnim`'s miss-path requires a `.md5anim`
  extension (`Anim.cpp:1106`) — RENDER registers under a synthetic `<name>.md5anim` key so even a
  non-cached lookup is harmless.

There is no `.md5mesh`-specific reparse after the check.

## Downstream caveats (HOLDS-WITH-CAVEAT — adversarial verifier)

The one-line change is safe **for the parse/bind/animate path it scopes**. It is *not by itself
sufficient to field a full combat monster*:

1. **`CheckModelHierarchy` is FATAL** (`Anim.cpp:1037–1048` → `gameLocal.Error`). Any joint
   count/name/parent mismatch hard-errors at decl parse. **Precondition:** the registered clip MUST
   be built from the *same glTF skin* as the bound model — satisfied today (both come from the same
   `animationLib` intern table, `Model.cpp:873` / `Anim.cpp:372`).
2. **Named-joint contracts (`GetJointHandle`).** AF/ragdoll (`AF.cpp:453,781,1216,1231`) and Actor
   head/eye/sound-joint attach (`Actor.cpp:588,622,674,1092`) resolve joints **by name**. If the
   glTF skeleton's names don't match the def's expected names (`barrel`, `flash`, head/AF joints),
   they return `INVALID_JOINT` → silent broken attachments. **Scope the first enemies to non-AF /
   non-attachment monsters, OR content authors matching joint names.**
3. **Ragdoll/AF on death** won't work without a matching `.af` + named joints. Scope first enemy to
   non-ragdoll, or author the AF. (Content/scope, not a SPINE edit.)
4. **Shadows (minor):** the deformed snapshot has no precomputed silhouette model → dynamic shadows
   may be absent/bounding-fallback. Acceptable for a first enemy; known-limited.
5. **Save/load (low risk):** the in-memory anim registration is NOT persisted; `idAnimBlend::Restore`
   re-resolves via `GetAnim(key)`. **RENDER must ensure `D3_RegisterGltfAnim` runs on level restore,
   not just first load.**

## Cross-track contract

- **SPINE:** the one-line relax. No other edit.
- **Content:** glTF mesh + (for combat-grade enemies) joint names matching the def, and an `.af` if
  ragdoll is wanted.
- **RENDER:** owns the loader, CPU skin, clip registration (shipped) + the `<name>.md5anim` key
  convention. (Render-zero-change does not apply here — this is a SPINE one-liner; RENDER's work is
  already landed.)

## RENDER's verification plan (RENDER owns this gate)

After the relax lands: author a modelDef decl with `mesh "<x.glb>"` + `anim <name> <clip>` (the entity
`"model"` spawnarg points at the **decl name**, not the file); confirm `Parse` returns true,
`NumJoints()>0`, `CheckModelHierarchy` passes; drive `idAnimator`/`CycleAnim` and assert the deform
probe moves >0.1 D3u (reuse `__d3GltfSkinTestDelta`), det IDENTICAL; falsifiable arm
`r_gltfSkinIdentity 1` → deform 0 → RED.

## Open question for owner

Confirm the first glTF enemy is scoped non-AF / non-ragdoll (caveats 2–3), or budget content time to
author matching joint names + an `.af`.
