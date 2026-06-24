# R-TRACER (Path C) — renderer-solo approximate bullet tracer

**Status: GREEN on Dawn (2026-06-24, `render-track`). Renderer-only; no game/SPINE edit.**

Stock DOOM 3 has no machinegun tracers (it's hitscan; the `tracers` flag at `Projectile.cpp:370`
only applies to *projectiles*). Path C adds a **visual** tracer entirely renderer-side, by
observing the muzzle-flash light the game already spawns on fire.

## How it works

- **Detect the shot (capture, `draw_arb2.cpp`):** the per-vLight loop already sees every light.
  The view muzzle-flash light is identifiable by `vLight->lightDef->parms.lightId >= 100`
  (`LIGHTID_VIEW_MUZZLE_FLASH` + player entnum; map lights leave `lightId` 0). When seen in the
  big 3D view, stash `g_capMuzzleFired = 1` + the muzzle **world origin** (the light origin) + an
  **aim point** ahead along the view forward (`origin + viewaxis[0]*512`).
- **Draw (backend, `RenderBackend_WebGPU.cpp`):** project both world points to screen UV via
  `g_lastProjMatrix * g_lastViewMatrix`, then draw an **additive screen-space streak** between
  them — a bufferless fullscreen pass (`bloom.wgsl` `fs_tracer`: distance-to-segment glow, warm
  color, fades toward the muzzle). Reuses the bloom scaffold (`bloomBGL` + `vs_main` + a 32-byte
  UB + a dummy texture binding) and `makeBloom("fs_tracer", additive=true)`. A **color-only**
  pass (the bloom pipelines carry no depth-stencil), drawn after the 3D pass, before
  bloom/tonemap + the GUI (`tracerActive` is folded into `splitGUI`, so the streak stays under
  the HUD).
- **Cvars:** `r_tracers` (default 1; 0 / `?notracers` = off), `r_tracerIntensity` (1.6),
  `r_tracerWidth` (0.0045 UV half-width).

## Determinism + mobile

- **Det-safe by construction.** The draw is a pure function of frame-constant globals
  (`g_capMuzzleFired`, the muzzle/aim world points, the view matrices) — no time/RNG/feedback.
  `g_capMuzzleFired` is **read** (not cleared) inside `encodeRecordsPass`, so the live encode and
  **both** det re-encodes see the same value and draw the identical streak; it is cleared **once**
  at end-of-frame (after `runDeterminismRound`), exactly like the motion-blur prevVP swap. Gate:
  `__d3WgpuDet` IDENTICAL with `r_tracers` on and off.
- **Mobile-cheap.** One additive bufferless fullscreen pass, only on frames the gun fired. No new
  buffer, no copy, no new pipeline layout. iOS-safe by the same reasoning as bloom.

## Gate (`/tmp/tracer-verify.mjs`, Dawn)

Fire the gun (spawn a centered imp → the iter-127 close-range autofire) and read the live
`window.__d3TracerFired` signal:

| arm | result |
|---|---|
| fires | `r_tracers 1` + firing → `__d3TracerFired = 1` ✓ (streak visible: warm line muzzle→target) |
| falsifiable A/B | `r_tracers 0` → `__d3TracerFired = 0` ✓ (no streak; only the muzzle glow remains) |
| determinism | `__d3WgpuDet` IDENTICAL with `r_tracers` on **and** off ✓ |

Visually confirmed on Dawn: ON shows a warm streak from the barrel toward the aim point; OFF
shows only the always-present muzzle-flash glow. `GATE: PASS ✓`.

## Honest scope — this is the *approximate* tracer

- The streak goes muzzle→(view-forward aim point), **not** the real bullet trace. It's a
  depth-buffer-free 2D streak (no occlusion behind geometry). It draws while the muzzle-flash
  light is present (~the flash duration), so it reads as a short warm streak per burst, not a
  single-frame round. Good enough as a feel effect; tunable via the cvars.
- The **real** tracer (true trace endpoint, per-round, occluded) is **Path B** — a game-side
  beam; see the SPINE spec in the same commit message / `docs/RENDER_TRACER_SPINE.md`.

Build: emsdk-600; WGSL change → `embed_wgsl.py` regenerates `embedded_shaders.h` before the patch
regen; regen ONLY `patches/rayban-renderer.patch`.
