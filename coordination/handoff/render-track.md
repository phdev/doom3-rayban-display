# Handoff — render-track (Session D, WebGPU renderer, doom3-rayban-display)

Branch `render-track`. Working tree CLEAN, 0 ahead of origin — everything committed + pushed
(head `f10bde2`). No task mid-gate. This doc = only what's nowhere else in CLAUDE.md/docs.

## In-flight work — disposition per piece

| Work | State | Disposition |
|---|---|---|
| **R-IBL (Full PBR look), render half** | DONE, Dawn-green (`d5bd65a`, `docs/RENDER_IBL.md`, gate `scripts/ibl-verify.mjs`) | **MERGE NOW** |
| R-IBL **P5 content-join** (real per-area cube probes) | UNBUILT | **PARK** — trigger: content-forge ships the probe-baker (R11G11B10F irradiance + LDR radiance cubes, area→probe manifest) **AND** a rigged ORM GLB loads (R-GLTF). `ibl_ambient()` is format-agnostic → only shader change is `synth_*`→`textureSampleLevel(cube,…)`. |
| R-IBL **P6 iPhone gate** | deferred | **PARK** — trigger: iPad free / owner phone check |
| **View smoothing** (`g_viewInterpolate`/`g_viewSmooth`) | DONE, shipped+deployed (`f10bde2`), det IDENTICAL | **MERGE NOW**. Owner still owes a tuned `g_viewSmooth` value (0.2–0.4) from feeling it on iPhone → then bake as the mobile default (currently 0.30). |
| **SPINE ASK 1** (.glb modelDef relax) | CLOSED both halves (`c16d246`) | **MERGE NOW** |
| **SPINE ASK 2** (R-TRACER Path B, real idBeam) | SPINE-accepted, DEFERRED | **PARK** — trigger: next SPINE combat rebuild. Render side is zero-change; spec `docs/SPINE_ASK_TRACER_PATHB.md`. |
| **Frame generation** | feasibility analyzed, NOT built | **ABANDON** (see verdict below). Re-open trigger: a future target sustains <40fps **with proven GPU headroom** + a zero-per-generated-frame-alloc warp. |
| ASK-1 **caveat #5** (`D3_RegisterGltfAnim` on save/load restore) | RENDER owns, unbuilt | **PARK** — trigger: first rigged-enemy save/restore integration (not testable until rigged content exists) |
| **Default-pak fallback** (bare URL QoL) | offered, not done | **PARK** — trigger: owner wants to bookmark bare `rayban-render.pages.dev`. Small JS change in `src/d3Runtime.js` `resolvePakBase()`: default `?pak` to `https://doom3-pak.pages.dev/`. |

## Frame-gen verdict (exists ONLY here — analysis not committed as a doc)
DON'T build now. Buildable variant = camera-only async-timewarp/reprojection (NOT interpolation —
+16.7ms latency, bad for a shooter). Reuses R-MBLUR's MV/world-reconstruction math but the forward
warp + hole-fill + HUD/viewmodel exclusion is net-new. **Why not:** (1) we're CPU/game-loop-bound
(iter-24), phone ~46.5fps = above the regime where present-rate smoothing pays; (2) the felt judder
is a render-vs-sim seam already damped by view smoothing; (3) ZERO aim benefit (60Hz sim floors
latency → generated frames carry stale input); (4) strafe = worst case for reprojection (parallax
tearing); (5) it **re-arms the iter-30 GPU-process churn** (doubles present rate + per-frame alloc) =
the tab-killer, and is the literal reverse of the shipped submit-skip. Determinism is fine (cleanly
present-isolated; even operator-gateable via render-both-poses ground truth). Cheaper ladder before
it: tune `g_viewSmooth`, audit `com_fixedTic` pacing (stabilize REAL fps), get a phone-side profile.

## Tribal knowledge not in CLAUDE.md/docs
- **Mac Safari WebGPU thrash (env quirk):** after ~6 WebDriver/WebGPU sessions the Mac's GPU+swap
  degrades and every fresh Safari session HANGS at map-load (`__d3ViewPos` never appears, JS execute
  blocks ~60s). Not a build bug. Between batches: `killall Safari 'com.apple.WebKit.GPU'` +
  `xcrun simctl shutdown all`. `safaridriver --port N` (Remote Automation already enabled); raw W3C
  WebDriver `/tmp/saf.py` (no selenium); the WebDriver `/screenshot` DOES composite the WebGPU canvas
  (unlike `canvas.drawImage`/headless). Serve pak LOCALLY (`?pak=http://localhost:4173/wasm/`) to
  dodge slow remote re-downloads per fresh session.
- **`scripts/gltf-spike.mjs` wants its OWN server on :4180** — it won't point at an existing preview;
  `DET_URL` doesn't override its hardcoded URL. This session proved the anim-bridge preservation via
  the base-patch delta (Anim.cpp byte-unchanged) + successful link instead of re-running it.
- **Deploy recipe:** `rsync -a --exclude 'wasm/base' --exclude 'wasm/base256' --exclude 'wasm/base-stream'
  --exclude 'wasm/levels' --exclude '*.glb' dist/ /tmp/rr-deploy/` then
  `set -a; source ~/.config/arco/cloudflare.env; set +a; CLOUDFLARE_ACCOUNT_ID=6f3ac7250ecff1b3cb3b9a92fc115b74
  npx wrangler@latest pages deploy /tmp/rr-deploy --project-name rayban-render --branch main`.
  Paks are NOT deployed (proprietary) → the bare URL 404s the pak → black screen; always test with
  `?pak=https://doom3-pak.pages.dev/`.
- **Interaction-module `group(0)` uniform is now 256 B** (grew 224→256 for R-IBL). ALL FOUR bindings
  must stay lockstep: record, record-depth, **pass-depth** (`depthPipeline` shares interaction
  `vs_main` → `bglDepth` min size is the full struct), and the PBR self-test buffer. A future struct
  grow must bump all four or Dawn validation-fails only the pass-depth path.

## ⚠ Paths I own — MERGE LANDMINE (must stay intact through the master merge)
- Mine: `patches/rayban-renderer.patch` (neo/renderer), `webgpu-port/`, `src/`, `docs/RENDER_*.md`,
  `docs/SPINE_ASK_*.md`, `scripts/*-verify.mjs`, `scripts/ibl-verify.mjs`.
- **`patches/rayban-base.patch` is SPINE-domain BUT the render-track copy carries render-track-ONLY
  game state a SPINE base-patch lacks: `neo/game/anim/Anim.cpp`+`.h` (the Spike-B glTF anim bridge:
  `D3_RegisterGltfAnim`/`BuildFromGLTF`/`RegisterMemoryAnim`) + the `.glb` relax + view smoothing.**
  SPINE's `viewsmooth-rayban-base.patch` (and likely other SPINE base variants) DIVERGE and DROP the
  anim bridge. **Never let a wholesale SPINE base-patch overwrite this file — diff first, extract only
  the intended delta, preserve Anim.cpp/.h.** (This bit us twice: the `.glb` relax was missing until
  `c16d246`; the viewsmooth patch would have regressed R-GLTF.)

## Waiting on other sessions
- **Spine → "iPad free"** signal → then run the device-loss `createBindGroup` Apple-WebKit A/B
  (`doom/RENDER_DEVICELOSS_HANDOFF.md`); the `?beacon` hook is already in. iPad is iPadOS 26.5 now,
  Spine-reserved. (Doubly relevant: R-IBL P5 adds a per-area IBL bind group = same failure class.)
- **Spine → base-patch divergence decision:** fold the anim bridge into their canonical lineage, or
  keep me surgically merging. Note sent via owner; awaiting.
- **Owner → tuned `g_viewSmooth`** value (0.2–0.4) from the iPhone.
- **Content-forge → R-IBL P5** (probe-baker + ORM materials) + a rigged glTF for the full combat-drive
  verification + the R-GLTF phone-green gate (which content-forge's MD5/LWO-writer deletion gates on).
