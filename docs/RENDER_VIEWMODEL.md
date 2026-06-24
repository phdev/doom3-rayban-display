# R-VIEWMODEL — view-model depth separation (the weapon-clip fix)

**Status: GREEN on Dawn (2026-06-24, `render-track`). Phone = deferred final gate.**
Renderer-only (`patches/rayban-renderer.patch`); no SPINE/game edit, no shader change.

## The bug

GL's `RB_EnterWeaponDepthHack` (`tr_render.cpp:1381`, native path) does **two** things to keep
the first-person weapon from clipping into nearby walls/enemies:

1. `glDepthRange(0, 0.5)` — confine the weapon to the **front half** of the depth buffer.
2. `projectionMatrix[14] *= 0.25` — compress the weapon's projected depth.

The WebGPU capture-replay port baked only **half** of this: the projection compress is folded
into the captured MVP at three capture sites (`draw_arb2.cpp` interactions, `tr_render.cpp`
pass stages, `tr_render.cpp` depth-fill), but the `glDepthRange(0,0.5)` half was **never
ported**. So a very close wall could still occupy depth in front of the compressed weapon →
the gun clips into close geometry. (Diagnosed + deferred 2026-06-17; built 2026-06-24.)

## The fix

Apply the depth-range half at replay via a **per-record `[0,0.5]` viewport** on weapon records.

**Capture** (flag the records — `sPad1` is the free field; sky's `sPad1` use is on `pad3==2`
records that route to `lastSkyRecords`, which the touched loops never iterate):

- `draw_arb2.cpp` (lit interactions → `g_capRecords`): `r.sPad1 = weaponDepthHack ? 1u : 0u`.
- `tr_render.cpp` pass-stage capture (→ `g_passRecords`): same.
- `tr_render.cpp` depth-fill capture (iter-120, `pad3==4` → `g_passRecords`): same.

**Replay** (`RenderBackend_WebGPU.cpp::encodeRecordsPass` — the body shared by the live frame
AND both determinism re-encodes): a `setWeaponDepthRange(rp, r, state)` helper re-issues
`wgpuRenderPassEncoderSetViewport(rp, 0,0, depthW,depthH, 0.0, weapon ? 0.5 : 1.0)` only on a
weapon↔world transition (world records dominate; world stays at the pass-default `[0,1]`).
Applied consistently across every loop that writes or tests the weapon's depth, so the gun's
prepass depth, lit depth, and pass-stage depth all live in `[0,0.5]` and never self-z-fight:

- **prepass** — interaction depth-fill loop + opaque pass-record fill loop (one shared state);
- **lit interaction pass** — per interaction, with a reset to `[0,1]` around every
  `drawVolumes` call (stencil shadow volumes are world-space and must mark/test at full range);
- **final pass-record loop** — per weapon pass stage.

### Shadow exemption (regression found + fixed 2026-06-24)

Moving the weapon into the `[0,0.5]` slab while the stencil shadow volumes stayed at `[0,1]`
introduced a regression: a world/player volume *behind* the gun fails the depth test over the
gun's now-shallow depth and increments the stencil there, so the interaction pipeline's
`stencilRef(128) GreaterEqual stencilValue` test drops those pixels to black — a hard-edged
**shadow gash on the gun/arm** (user-reported; A/B confirmed: ON had it, OFF + `r_shadows 0` did
not). Native DOOM3 never world-shadows the view weapon (`noSelfShadow`). **Fix:** in the lit
interaction pass, draw weapon records with the **stencil reference at 255** (`255 >= anyValue`
always passes → never shadowed); the pipeline's stencil ops are `Keep`, so this only exempts the
weapon from the shadow *test* and cannot corrupt the stencil. Gated by `r_weaponDepthSep` (OFF →
ref stays 128 → byte-identical). `litResetWorld()` restores ref 128 (alongside the viewport)
before every `drawVolumes` so volume marking is unaffected. Re-verified on Dawn: ON now renders
the gun/arm clean (matches OFF) **and** det stays IDENTICAL.

Gated by `r_weaponDepthSep` (default **1** = GL parity; **0** = the old projection-only WebGPU
behavior, for A/B). With the cvar 0, `setWeaponDepthRange` emits **zero** `SetViewport` calls →
byte-identical to the pre-R-VIEWMODEL frame (OFF-identity).

## Why it's determinism-safe

`encodeRecordsPass` is the single body called for the live surface and for both det re-encode
targets (`detTexA`/`detTexB` in `runDeterminismRound`). The viewport commands are therefore
emitted **identically** in both det encodes for the same captured records → byte-identical
output. The det self-test proves reproducibility, not match-to-a-prior-baseline, so the
(intended) visual shift of the weapon's depth does not make it "DIFF".

## Gate (`scripts/viewmodel-verify.mjs`, Dawn / headed Chrome)

Two runs at the enpro spawn (the gun is given at spawn), reading the live `__d3WeaponDepthRecords`
signal + `__d3WgpuDet`:

| arm | result |
|---|---|
| (1) determinism, `r_weaponDepthSep 1` | `__d3WgpuDet` **IDENTICAL** (every round diffPx==0) |
| (2) feature fires | `__d3WeaponDepthRecords` = **16** (>0 — gun records get `[0,0.5]`) |
| (3) falsifiable A/B, `r_weaponDepthSep 0` | `__d3WeaponDepthRecords` = **0** (OFF-identity) + det **IDENTICAL** |

The 16→0 flip under the cvar proves the gate is **non-vacuous** (the feature is genuinely
controlled, not an always-on path). `GATE: PASS ✓`.

## Honest scope / remaining

- The Dawn gate proves **determinism + the path fires + falsifiable controllability**. The
  **visual** confirmation that the gun no longer clips into close walls is a headed-Chrome
  eyeball + **on-device** follow-up (the phone gate, deferred per owner decision DD — same as
  the other render milestones). The clip is lighting/position-dependent and the
  setviewpos-angle harness is unreliable on the wearable input path, so it is verified by the
  owner in play.
- The view weapon's heat-haze stages (a separate `g_hazeRecords` post-pass) are **not** flagged —
  no DOOM 3 weapon material uses `heatHaze`, and that pass doesn't gate the weapon's depth.

Build: emsdk-600; regen ONLY `patches/rayban-renderer.patch`
(`git -C .build/dhewm3 add -A -N neo && git diff 8ebc112 -- neo/renderer`). No WGSL change
(fixed-function viewport), so no `embed_wgsl.py` step.
