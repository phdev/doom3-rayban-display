# Tracers — what SPINE should do (Path B: the real tracer)

Path C (shipped, renderer-solo) is an *approximate* visual streak: muzzle → view-forward aim
point, no real trace endpoint, no occlusion. The **real** tracer needs game-side spawning, which
is SPINE's domain (`neo/game`, `patches/rayban-base.patch`). The render track already renders the
result with **zero backend change** — additive beam/model surfaces flow through the existing
capture-replay path (`g_passRecords` → `passAddPipeline`).

## Recommended — Path B: hitscan beam (keeps instant-hit feel)

The machinegun is **hitscan** (`def_hitscan_*`), so keep instant hits and just add a visual beam
on fire:

1. **Where:** the machinegun fire path — `idWeapon` hitscan / `Weapon.cpp` `Attack`, where the
   trace from muzzle → target is already computed for damage. The muzzle position is
   `GetMuzzlePos()` / the `flash` joint; the impact point is the existing hitscan trace endpoint.
2. **What:** on a fraction of shots (~50%, mirror the stock `Projectile.cpp:371` RNG), spawn a
   short-lived **additive beam** from muzzle → trace endpoint. `idBeam` (`game/Misc.cpp`) is the
   natural entity (renders a beam between two points with a material); a brief lifetime (~60–100 ms)
   + free. This is per-round, uses the *real* endpoint, and occludes correctly (real geometry).
3. **Content (pak):** a tracer beam material — additive (`blend add`), a thin warm glowing streak
   texture — present in the reduced pak. A missing material renders opaque-white (the iter-33
   class), which is a content fix, not a renderer bug.
4. **Render side (mine):** nothing. `idBeam`'s surfaces are captured + replayed additively
   automatically. I'll verify on Dawn once you spawn them.

## Alternative — Path A: stock projectile tracer (smallest code, changes feel)

DOOM 3's built-in mechanism (`Projectile.cpp:370`): a projectile with `"tracers" "1"` +
`"model_tracer" "<glowing streak model>"` swaps to the tracer model on ~50% of shots. To use it,
make the machinegun fire a **fast projectile** (`def_projectile`) instead of hitscan + supply a
`model_tracer`. Smallest change (one def + a model), but **bullets become traveling projectiles**
(not instant) — changes hit-feel and interacts with the auto-fire/hit path. Only choose this if a
projectile machinegun is acceptable.

## Mobile note (corrected)

Not a concern: at 600 rpm × ~50% that's ~5 short-lived tracers/sec (~1–3 alive at once). The
earlier "~200 entities/frame" estimate was wrong.

## Render-track ↔ SPINE handshake

- Render track owns: the Path C approximate streak (shipped) + verifying the Path B beam renders.
- SPINE owns: the spawn (idBeam on fire, or the projectile-tracer def) — `neo/game` /
  `rayban-base.patch`.
- Content owns: the additive tracer beam material/model in the pak.

When SPINE spawns the beam, the render track will confirm it captures + renders additively on
Dawn (and the approximate Path C can be turned off via `r_tracers 0` so the two don't stack).
