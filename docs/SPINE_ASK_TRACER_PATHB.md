# SPINE ASK 2 — R-TRACER Path B (the real, depth-occluded tracer)

**Owner:** SPINE (`neo/game`, in `rayban-base.patch`) + content (pak) · **Requested by:** RENDER
**Status:** code-verified ask; adversarial verdict = HOLDS-WITH-CAVEAT. Finalizes/corrects
`docs/RENDER_TRACER_SPINE.md` (which has one load-bearing factual error, noted below).

**Summary:** Spawn a short-lived additive beam from the muzzle to the real bullet endpoint, per
round, depth-occluded. The render side captures + draws it with **zero backend change** (verified).
Replaces the approximate renderer-solo Path C (`docs/RENDER_TRACER.md`).

## (a) WHERE to spawn — CORRECTION to the existing doc

The existing doc says the machinegun is hitscan (`def_hitscan_*`). **That is wrong.** There is no
`idWeapon` hitscan path (only `Event_Melee` for fists). The machinegun fires a **fast
`net_instanthit` projectile** (`projectile_bullet`) via `idWeapon::Event_LaunchProjectiles`
(`Weapon.cpp:2819` → `proj->Launch(...)` `:2978`). So **no muzzle→target trace exists to reuse** —
Path B must add a trace or read the projectile impact.

- **Muzzle origin (reuse, no new code):** `muzzleOrigin` at `Weapon.cpp:2887–2894`
  (`barrelJointView`/`flashJointView` via `GetGlobalJointTransform`, else `playerViewOrigin`).
- **Endpoint — two options:**
  1. **Recommended — fire-time forward trace:** in `Event_LaunchProjectiles`, after `muzzleOrigin`,
     `gameLocal.clip.TracePoint(tr, muzzleOrigin, muzzleOrigin + dir*8192, MASK_SHOT_RENDERMODEL|CONTENTS_BODY, owner)`;
     endpoint = `tr.endpos`. Instant, matches the streak feel.
  2. **Faithful — projectile impact:** spawn in `idProjectile::Collide` (`Projectile.cpp:493`) from
     launch-origin → `collision.c.point`. True occluded path, but one frame late + coupled to the
     projectile lifecycle.
- **Cadence/lifetime:** mirror the stock RNG `gameLocal.random.RandomFloat() > 0.5f`
  (`Projectile.cpp:371`) for ~50% of rounds; free after ~60–100 ms. ~5/sec, 1–3 alive — mobile-safe.

## (b) MECHANISM + MATERIAL CONTRACT

- **Entity:** `idBeam` (`Misc.cpp:2230`) spawned programmatically: `SetModel("_BEAM")`, set
  `SHADERPARM_BEAM_WIDTH`, origin = muzzle, **`SetBeamTarget(endpoint)`** (`Misc.cpp:2279`, writes
  `SHADERPARM_BEAM_END_*`), set RGB/ALPHA shaderParms (warm), `Show()`, free after lifetime.
  **Caveat:** `idBeam` is normally map-placed/target-linked; `Event_MatchTarget`
  **`gameLocal.Error`s** with no valid beam target (`Misc.cpp:2329`). For a fire-spawned tracer, set
  the end via `SetBeamTarget` directly and do **NOT** route through target-matching. A lighter
  alternative is a bare render-model entity with `_BEAM` + manual `SHADERPARM_BEAM_END_*`.
- **Material (content, in the pak):** `textures/tracers/tracer_beam` — thin warm streak,
  **`blend add`**, `{ vertexColor }`, no diffuse lighting, **plain explicit texcoords** (NO
  reflect/screen texgen, NO cinematic stage — rejected at `draw_common.cpp:903`). A missing material
  renders opaque-white (iter-33 class) — content bug, not a renderer bug.

## (c) RENDER-SIDE ZERO-CHANGE — VERIFIED (holds)

The beam captures + draws additively through the capture-replay backend with **zero
renderer/backend change**:
- `_BEAM` (`Model_beam.cpp::InstantiateDynamicModel`) is a `DM_CONTINUOUS` dynamic model that builds
  a real 4-vert/2-tri `srfTriangles_t` with populated `tri->verts` per view, per-vertex color from
  `SHADERPARM_RED/GREEN/BLUE/ALPHA`, width from `SHADERPARM_BEAM_WIDTH`. `R_AddEntitySurfaces`
  (`tr_light.cpp:1436`) gives it an `ambientCache`; it passes the early-rejects in
  `RB_STD_T_RenderShaderPasses` (`draw_common.cpp:826,830`).
- Its stages flow through `D3_WebGPU_CapturePassStage` (`draw_common.cpp:1246`):
  `blend add = GLS_SRCBLEND_ONE|GLS_DSTBLEND_ONE → pad1=2 → passAddPipeline` (`tr_render.cpp:994`);
  per-vertex color (SVC) captured into `pad2`.
- **Occlusion is real:** `passAddPipeline` = `depthWrite=false, depthCompare=LessEqual`
  (`RenderBackend_WebGPU.cpp:937`). The opaque-only prepass (`:3563`, `pad1==1`) fills depth for
  intervening world geometry, so the beam is depth-tested against it and occluded correctly.

**Two wording corrections to the old doc (no render change):**
1. The "iter-35 deform vertex-cache read handles deform verts" framing is a **misnomer** — `_BEAM`
   has real `tri->verts` (read at `tr_render.cpp:854`), never the deform/`ambientCache` fallback.
   The iter-35 path is irrelevant here.
2. Occlusion is **conditional on the occluder being OPAQUE** (the prepass only fills opaque depth +
   iter-120 no-stage walls). A beam behind another *translucent* surface is not occluded by it — the
   standard translucent limitation.

## Cross-track contract

- **SPINE:** spawn the short-lived beam on ~50% of machinegun rounds in `Event_LaunchProjectiles`;
  origin = `muzzleOrigin`; end via `SetBeamTarget(tr.endpos)` (option 1); assign the content
  material; bypass target-matching.
- **Content:** the additive `textures/tracers/tracer_beam` material in the pak.
- **RENDER:** nothing to build — **render-zero-change is verified true**. Owns the verification gate.

## (d) COEXISTENCE WITH PATH C

When Path B ships, set **`r_tracers 0`** (default `1`, `RenderSystem_init.cpp:162`) so the
renderer-solo approximate streak doesn't stack on the real beam.

## RENDER's verification plan

On a beam spawn, confirm on Dawn: (1) the pass record captures (`blend add` → `pad1=2`; SVC via
`pad2`); (2) `__d3WgpuDet` IDENTICAL with beams present; (3) zero WebGPU validation errors; (4)
eyeball: a warm additive streak muzzle→impact, occluded by intervening opaque geometry. Phone gate is
the owner-DD follow-up.

## Open questions for owner

- **Spawn site:** option 1 (fire-time trace in `Event_LaunchProjectiles`, RENDER's recommendation for
  instant feel) vs. option 2 (projectile `Collide`, faithful).
- **Entity:** `idBeam` with target-matching bypassed vs. a bare `_BEAM` render-model entity (RENDER
  mildly prefers the bare entity — no targeting machinery to error on).
