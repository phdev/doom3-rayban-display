# R0 — RBDOOM filmic tonemap (WebGPU-optimized) — PLAN (review before code)

**Track:** RENDER/PERF (Session D), branch `render-track`, worktree `~/rayban-render`.
**Status:** plan for owner review. No engine code until explicit go + the decisions below are locked.
**Operating mode:** reviewed phased plan → adversarial review (done, folded in) → lock decisions via
AskUserQuestion → build on go → ship a falsifiable `metrics{}` gate proven to go red.

Owns ONLY `patches/rayban-renderer.patch` (`neo/renderer`) + `webgpu-port/` + JS shell harness. Never
touches `neo/game/` or `rayban-base.patch` (Session A / SPINE). Regenerate ONLY the renderer half.

---

## 1. What R0 is, and why this pick

R0 = "RBDoom visual features optimized for WebGPU." The backend already ships the easy RBDOOM-class
wins: **bloom** (iter 19), **BFG analytic specular** `pow(N·H,10)` (iter 29), **stencil shadows +
Quest shadow-darken + player shadow** (iter 9/23/25), the full point/projected/ambient/fog/blend
lighting model, sky/subviews/heat-haze. The standout RBDOOM feature that is **absent** and both
high-value and WebGPU-feasible on this capture-replay backend is **HDR filmic tonemapping**.

Why it's the right R0 pick (value × feasibility × determinism-safety), grounded:

- **Value — it implements the only *measured* look target the project owns.** Iter 29 quantified the
  BFG reference at the enpro spawn corridor (game-region luma) and found the corrective curve was
  "almost exactly a γ=2.0 power curve … the BFG look needs **deep blacks, not more lift**" — and that
  our `r_gamma 1.3` lift *was* the wash. A filmic toe-crush + shoulder-rolloff is exactly that shaping,
  and is the principled replacement for the crude per-fragment `pow(color, 1/γ)`.
- **Feasibility — the scaffold already exists and is proven.** The whole post chain is **LDR-on-LDR**:
  bloom (`fs_bright/fs_blur/fs_composite`) and shadow-darken (`fs_darken`) sample the already-composited
  8-bit `BGRA8Unorm` frame via the shared `bloomBGL` layout and the bufferless fullscreen-triangle
  `vs_main`, using the allocate-once, size-checked `currentRenderTex` (`ensureCurrentRenderTarget`,
  `RenderBackend_WebGPU.cpp:1122`). There is **no hidden RGBA16F / G-buffer / per-light-depth
  prerequisite** — grading the composited frame is exactly what the existing passes already do.
- **Determinism-safe by construction.** A fixed-exposure filmic curve is a pure function of the copied
  bytes + two constant uniforms — no time, no frame counter, no RNG, no cross-frame feedback — so it is
  byte-identical across the two `encodeRecordsPass` runs of the `__d3WgpuDet` self-test, exactly like
  the iter-23 shadow-darken fullscreen multiply that CLAUDE.md confirms "runs in det rounds too" and
  left IDENTICAL.

The four other RBDOOM candidates are **deferred** — each needs new render-target/G-buffer/per-light
plumbing that is a multi-session prerequisite, not R0:

| candidate | why NOT R0 |
|---|---|
| SSAO | needs a sampleable depth **+ reconstructed-normal** G-buffer the capture-replay path never produces |
| PCF shadow maps | needs per-light depth-render architecture (6 faces for points) = multi-session |
| HDR bloom | needs an `RGBA16F` linear scene intermediate (we composite in 8-bit) |
| SS shadow-mask blur | niche; the iter-23/25 shadow-darken already covers the "shadows read" goal |

---

## 2. Loss / loop framing (LDD)

- **Loop it improves:** the *art/look* loop — closing the measured gap between our render and the
  RBDOOM-3-BFG reference at the same vantage.
- **Loss term:** a new **`render_look`** block (this milestone introduces it). Measured terms only;
  the on-device WebKit fidelity term reports `status:"not_yet_measured"` until P3 (never weighted).
- **What stays unknown:** WebKit/Metal pixel-exactness vs Dawn (the recurring iter-47b/71/125 failure
  mode); 8-bit banding in crushed blacks (addressed by the dither decision below).

---

## 3. Scope (exact hooks — verified against source)

WGSL (`webgpu-port/shaders/`):
- Add `fn fs_tonemap(in: VSOut) -> @location(0) vec4<f32>` to **`bloom.wgsl`** (reuse `BloomUniforms`:
  `params.x` = exposure, `params.y` = enable). Sample `currentRenderTex`, apply a **white-scaled ACES
  (Narkowicz) fit** `(x(ax+b))/(x(cx+d)+e)` with `a=2.51 b=0.03 c=2.43 d=0.59 e=0.14`, normalized by
  the same fit at white `W` so `W→1`. Output the graded RGB. **Optionally fold a static Bayer dither**
  (see decision D4) into the output, indexed by `@builtin(position)` (pixel coord) — a pure function of
  fragment position, so still det-IDENTICAL (NOT RBDOOM's temporal golden-ratio variant, which is
  frame-dependent and would break `__d3WgpuDet`).
- Run `scripts/embed_wgsl.py` to regen the embedded shader header (the **iter-47 stale-embed law** — a
  hard P0 gate: grep the embed for `fs_tonemap` before any visual test).

Engine (`neo/renderer`, the renderer patch):
- `tr_render.cpp` cvar-mirror block (`g_cap*`, ~line 249): add `g_capTonemapOn` + `g_capTonemapExposure`,
  pushed per-view in `RB_BeginDrawingView` from new `r_tonemap` / `r_tonemapExposure` cvars (declared in
  the renderer cvar init). Standard recipe — the backend has no `idCVar` access by design.
- `RenderBackend_WebGPU.cpp`:
  - One **non-additive** fullscreen pipeline `makeBloom("fs_tonemap", /*additive=*/false, "tonemap")`
    (mirrors `fs_bright` at `:1200`; **NOT** the additive `bloomCompositePipeline` at `:1202`). Bind
    through `bloomBGL`; pack `{exposure, enable}` into a reused 32 B UB allocated once alongside `bloomUB`.
  - Compose in the final-pass split (`:3490`): make `tonemapActive` a first-class term and **fold it into
    `splitGUI`** (`:3496`) so the **GUI/HUD always defers to its own post-grade pass** (`:3704`) — the
    iter-19 "post-FX must not warp the HUD" invariant. Run it **after** shadow-darken (`:3419`) and bloom
    composite (`:3635/:3699`) but **before** the GUI overlay. Reuse the 4-term size guard
    (`currentRenderW==depthW && currentRenderH==depthH`) before `copyTextureToTexture(color→currentRenderTex)`
    + one 3-vert Draw sampling back into `color` with `LoadOp_Load`. (Usage flags already legal:
    swapchain + det targets are `RenderAttachment|CopySrc`; `currentRenderTex` is `CopyDst|TextureBinding`.)
  - **False-green guard (mandatory):** add a one-shot counter/log that the tonemap Draw **fired inside a
    determinism round** at det resolution, and assert det target size == `depthW/depthH`. Without it the
    `__d3WgpuDet` IDENTICAL verdict could be vacuous (the size gate silently no-ops the pass offscreen).

No new render targets (reuses `currentRenderTex`); one new pipeline + one 32 B UB. Per-frame cost when
ON = 1 `copyTextureToTexture` + 1 fullscreen pass + 1 `writeBuffer(32B)` — strictly smaller than the
already-iPhone-safe bloom path (iter 30). **Honest note:** with bloom default-OFF (iter 32), turning
`r_tonemap 1` *newly arms* a per-frame copy on frames that currently skip it — bounded (one copy into a
resident target, no alloc churn), but the P3 GPU-mem re-measure must be run **with bloom OFF**.

---

## 4. Falsifiable `metrics{}` gate (strengthened by adversarial review)

Four gates. The **operator-correctness LUT** is the headline (deterministic, tests the *actual* curve,
needs no camera/scene). Each has a recorded mutation proven to turn it RED.

| gate (`metrics{}`) | asserts | mutation that falsifies it |
|---|---|---|
| `tonemap_operator_lut_match` | a known 256-step gradient pushed through `fs_tonemap` on-GPU, read back, matches the CPU-computed Narkowicz OP3 fit within ±1 LSB | ship the **identity curve** (return sampled color) / drop the exposure uniform / swap channels → LUT mismatch → **red** (proves it measures the *operator*, not merely "a pass ran" or "it got darker") |
| `tonemap_determinism_identical` | `__d3WgpuDet` rounds 1–6 report IDENTICAL with `r_tonemap 1`, **AND** the one-shot "tonemap fired in det round at det res" assertion is true | inject a **per-encode** counter into exposure (the two det passes run back-to-back in one round — must be per-encode, not per-frame) → rounds report `N px differ` → **red** (proves the IDENTICAL arm can catch a nondeterministic grade and isn't vacuously skipped) |
| `tonemap_hud_invariant` | a HUD/GUI-region luma is **unchanged** OFF-vs-ON (the HUD renders in its own post-grade pass) | remove the `tonemapActive` fold from `splitGUI` → HUD gets tone-crushed → region luma moves → **red** |
| `tonemap_look_direction` *(Dawn-only, honestly bounded)* | vs a **freshly-measured OFF baseline** (NOT iter-29's stale 82.7), the opt-in graded frame moves its game-region luma {median, std/mean, deep-shadow-fraction<8} toward the BFG reference (32.1 / 1.03 / 48%) by a margin **> the iter-30 ~2.45 px noise floor** | identity curve → no movement → **red**; this arm is explicitly *Dawn-verified, WebKit-unverified* until P3 |

If D4 = "dither in R0", add `tonemap_banding_reduced` (flat-step ≥1-LSB run count across a dark gradient
drops with dither ON; zero the offset → red) so R0 cannot ship a visibly-banded grade the look gate
can't see.

Roll into the report as `render_look`: the four gates `measured`; `webkit_fidelity` =
`not_yet_measured` (P3). Never weight the loss over the unmeasured WebKit term.

**Verification instruments:** `scripts/det-check.mjs` (headed Chrome/Dawn → `__d3WgpuDet`, already built
+ baseline-green); a new `scripts/look-gate.mjs` (LUT read-back + frozen same-vantage luma grid per the
iter-25 settle rules). Headless WebGPU reads black — headed Chrome/Dawn only; then Mac Safari + iOS Sim
before the physical iPhone (the test-Mac-sim-first rule). The iPhone is the final gate.

---

## 5. Phases

- **P0 — operator + plumbing.** `fs_tonemap` in `bloom.wgsl`; `r_tonemap`/`r_tonemapExposure` cvars +
  `g_cap*` mirrors + `RB_BeginDrawingView` push; `embed_wgsl.py` regen (+grep guard); one non-additive
  pipeline + 32 B UB. *Verify:* engine compiles (emsdk-600); `d3cmd("r_tonemap 1")`/exposure reach the
  backend; `tonemap_operator_lut_match` GREEN and proven RED by the identity-curve mutation.
- **P1 — compose in EndFrame.** Fold `tonemapActive` into `splitGUI`; the copy+grade pass after
  shadow-darken/bloom, before GUI; the false-green det assertion. *Verify:* `tonemap_determinism_identical`
  GREEN + proven RED by the per-encode counter; `tonemap_hud_invariant` GREEN + proven RED; OFF path
  byte-identical to baseline.
- **P2 — look gate + fresh baseline.** Capture the **current default** OFF frame first (re-anchor),
  then OFF-vs-ON. *Verify:* `tonemap_look_direction` GREEN at the locked exposure; (D4) banding gate.
- **P3 — on-device.** Mac Safari → iOS Sim → physical iPhone; re-measure `com.apple.WebKit.GPU` RSS
  (iter-30 recipe) **with bloom OFF + tonemap ON**. *Verify:* GPU process stays below the iter-30
  ~1 GB/min climb; visual A/B matches Dawn. Only then is any default-on flip raised with the owner.

Commit + push to `render-track` after each phase; regenerate ONLY `patches/rayban-renderer.patch`
(`git -C .build/dhewm3 add -A -N neo && git -C .build/dhewm3 diff 8ebc11260d52638d2aff12ce73fbfccaa70db1b9 -- neo/renderer > patches/rayban-renderer.patch`); keep CLAUDE.md current.

## 6. Flag / default policy

`?tonemap` (absent = OFF) gates `r_tonemap` (default **0**) + `r_tonemapExposure` (default 1.0).
**OFF on every tier** (desktop / iPhone-96px / `?hd`-256px) until P3 passes AND the owner approves a flip.
`?args=+set r_tonemap 1 +set r_tonemapExposure 0.6` = the on-device A/B entry; `r_tonemap 0` = escape hatch.
**When `r_tonemap 1`, the profile also sets `r_gamma 1.0`** so the per-fragment `pow(color,1/γ)`
(`interaction.wgsl`) doesn't double-shape the frame the tonemap is meant to replace.

## 7. Risks (folded from adversarial review)

- **8-bit banding** in crushed blacks (no RGBA16F intermediate) — the honest cost; D4 (static dither)
  is the mitigation and closes the gate's banding blind spot.
- **Stale-embed** (iter-47): edit `.wgsl` without `embed_wgsl.py` → old shader runs. P0 grep guard.
- **Compose-order / HUD crush** (iter-19): `tonemapActive` MUST be folded into `splitGUI` even when
  bloom/haze are off, or the HUD tone-crushes. Covered by `tonemap_hud_invariant`.
- **WebKit ≠ Dawn** (iter-47b/71/125): a pure byte-remap is low NaN-risk, but the look arm is Dawn-only
  and the det arm is byte-identity (not curve-correctness on Metal). Only P3 on-device A/B closes it —
  the visual claim is explicitly bounded to "Dawn-verified, WebKit-unverified until device."
- **Newly-armed per-frame copy** when bloom is off — bounded, but P3 GPU-mem re-measure must use bloom OFF.

## 8. Decisions — LOCKED with owner (2026-06-22, AskUserQuestion)

1. **Scope/target → Independent `?tonemap`, default OFF on all tiers.** The native-parity default is
   untouched; this is the *principled* BFG-look curve that replaces the iter-29 gamma wash, opt-in only.
   Fold into `?bfg` only after the on-device flip. The gate's "toward the BFG reference" target is honest
   because it judges ONLY the opt-in graded mode, never the validated default.
2. **Operator → ACES / Narkowicz OP3** (white-scaled, `W=11.2`). Single operator for R0.
3. **Dither → INCLUDE in R0.** Static Bayer (8×8) folded into `fs_tonemap` output, indexed by
   `@builtin(position)` (det-safe; NOT the temporal golden-ratio variant). Adds the
   `tonemap_banding_reduced` gate to R0; closes the banding blind spot.
4. **Exposure → expose `r_tonemapExposure` on the fx slider panel** for live on-device tuning, alongside
   bloom/gamma.
