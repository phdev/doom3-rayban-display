# HANDOFF-RENDER — render-track (Session D, WebGPU renderer, doom3-rayban-display)

Branch `render-track`. Working tree CLEAN, pushed. No task mid-gate. All render work is committed.
(Also mirrored at `coordination/handoff/render-track.md`, commit `8305a84`; this root copy is canonical.)

## Per-item disposition

| Item | State | Disposition + trigger |
|---|---|---|
| **R-IBL (Full PBR look), render half** | DONE Dawn-green (`d5bd65a`; `docs/RENDER_IBL.md`; gate `scripts/ibl-verify.mjs`) | **MERGE NOW** |
| **View smoothing** (`g_viewInterpolate`/`g_viewSmooth`) | DONE shipped+deployed (`f10bde2`), det IDENTICAL | **MERGE NOW** |
| **SPINE ASK 1** (.glb modelDef relax) | CLOSED both halves (`c16d246`) | **MERGE NOW** |
| **Frame generation** | analyzed, NOT built | **ABANDON** (rationale below) |
| PARK-1: **R-IBL P5 content-join** (real per-area cube probes) | UNBUILT | **PARK** — trigger: content-forge ships the probe-baker (R11G11B10F irradiance + LDR radiance cubes + area→probe manifest) **AND** a rigged ORM GLB loads via R-GLTF. `ibl_ambient()` is format-agnostic → only shader change is `synth_*`→`textureSampleLevel(cube,…)`. |
| PARK-2: **R-IBL P6 iPhone gate** | deferred (owner DD) | **PARK** — trigger: iPad free / owner phone check. Mobile-safe by construction (explicit-LOD, single-cube-per-area, self-test `g_capDetTest`-gated). |
| PARK-3: **SPINE ASK 2** (R-TRACER Path B, real idBeam) | SPINE-accepted, deferred | **PARK** — trigger: next SPINE combat rebuild. Render side = ZERO change; spec `docs/SPINE_ASK_TRACER_PATHB.md`. |
| PARK-4: **ASK-1 caveat #5** (`D3_RegisterGltfAnim` on save/load restore) | RENDER owns, unbuilt | **PARK** — trigger: first rigged-enemy save/restore integration (not testable until rigged content exists). |
| PARK-5: **Default-pak fallback** (bare-URL QoL) | offered, not done | **PARK** — trigger: owner wants to bookmark bare `rayban-render.pages.dev`. Change: `src/d3Runtime.js` `resolvePakBase()` defaults `?pak` → `https://doom3-pak.pages.dev/`. |

Also owed (waits, not parks): owner's tuned `g_viewSmooth` (0.2–0.4) → bake as mobile default (now 0.30).

## Frame-gen ABANDON rationale + re-open condition
Buildable variant = camera-only async-timewarp/reprojection (NOT interpolation — +16.7ms latency,
bad for a shooter); reuses R-MBLUR's MV/world-reconstruction math but the forward warp + hole-fill +
HUD/viewmodel exclusion is net-new. **Abandon because:** (1) we're CPU/game-loop-bound (iter-24),
phone ~46.5fps = above the regime where present-rate smoothing pays; (2) the felt judder is a
render-vs-sim seam already damped by view smoothing; (3) ZERO aim benefit — the 60Hz `USERCMD_HZ` sim
floors latency, so generated frames carry stale input (smoother pixels, same/worse responsiveness);
(4) strafe is the worst case for reprojection (lateral motion = max parallax = silhouette tearing);
(5) it **re-arms the iter-30 GPU-process churn** (doubles present rate + per-generated-frame alloc) =
the iOS tab-killer, and is the literal reverse of the shipped submit-skip. Determinism is fine
(cleanly present-isolated; even operator-gateable via a render-both-poses ground-truth test).
**RE-OPEN condition (ALL three):** a future target sustains **<40fps** with **provably idle GPU** AND
the warp is implementable with **zero per-generated-frame allocation** (strict buffer reuse). Cheaper
ladder first: tune `g_viewSmooth`, audit `com_fixedTic` pacing (stabilize REAL fps), get a phone
profile.

## Node-name parsing status (R-GLTF)
RENDER-side node/joint-name parsing is **IMPLEMENTED**: `LoadGLTF` parses the glTF skin's joint
hierarchy into `gltfJoints`, and `GetJointHandle`/`GetJointName`/`NumJoints`/`GetJoints`/`GetDefaultPose`
resolve against it (Model.cpp; all Dawn-green, in `patches/rayban-renderer.patch`). So a modelDef can
bind a `.glb` and the animator resolves joints by name. **OPEN piece is NOT render parsing — it's the
name-MATCHING CONVENTION:** for attachments (weapon `barrel`/`flash`, head/eye/sound joints) and AF
ragdoll, the glTF skeleton must use joint NAMES the DOOM3 def expects (`GetJointHandle` returns
`INVALID_JOINT` on a mismatch → silent broken attach). That is **content-forge + SPINE** territory
(ASK-1 caveat #2): first glTF enemies scoped non-AF/non-attachment, OR content authors matching names.
No RENDER work pending on node-names beyond the shipped parser. (Cross-track note in content-forge:
rigged enemies remain `deferred:path-b` on RENDER node-names + converter + on-phone deform — the
converter + on-phone deform are content/spike items, not this session's.)

## ⚠ MERGE LANDMINE — paths I own
Mine: `patches/rayban-renderer.patch` (neo/renderer), `webgpu-port/`, `src/`, `docs/RENDER_*.md`,
`docs/SPINE_ASK_*.md`, `scripts/*-verify.mjs` (incl. `ibl-verify.mjs`).
**`patches/rayban-base.patch` is SPINE-domain BUT the render-track copy carries render-track-ONLY game
state a wholesale SPINE base-patch LACKS:** `neo/game/anim/Anim.cpp`+`.h` (the Spike-B glTF anim
bridge — `D3_RegisterGltfAnim`/`BuildFromGLTF`/`RegisterMemoryAnim`) + the `.glb` relax + view
smoothing. SPINE's `viewsmooth-rayban-base.patch` and other base variants DIVERGE and DROP the anim
bridge. **Never let a wholesale SPINE base-patch overwrite this file — diff first, extract only the
intended delta, preserve `Anim.cpp/.h`.** (Bit us twice: `.glb` relax was missing until `c16d246`; the
viewsmooth patch would have regressed R-GLTF — integrated surgically instead.)

## Waiting on other sessions
- **Spine → "iPad free"** → then the device-loss `createBindGroup` Apple-WebKit A/B
  (`doom/RENDER_DEVICELOSS_HANDOFF.md`); `?beacon` hook already in. iPad is iPadOS 26.5, Spine-reserved.
  (R-IBL P5's per-area IBL bind group is the same failure class — settle this before P5.)
- **Spine → base-patch divergence decision:** fold the anim bridge into their canonical lineage, or
  keep me surgically merging. Note sent via owner; awaiting.
- **Owner → tuned `g_viewSmooth`** from the iPhone.
- **Content-forge → R-IBL P5 assets** + a rigged glTF for the full combat-drive verification + the
  R-GLTF phone-green gate (content-forge's MD5/LWO-writer deletion gates on it).

## Tribal knowledge (in full)
- **Mac Safari WebGPU thrash + reset:** after ~6 WebDriver/WebGPU sessions the Mac's GPU+swap degrades
  and every fresh Safari session HANGS at map-load (`__d3ViewPos` never appears, JS execute blocks
  ~60s) — NOT a build bug. Reset between batches: `killall Safari 'com.apple.WebKit.GPU'` +
  `xcrun simctl shutdown all`. `safaridriver --port N` (Remote Automation already enabled); raw W3C
  WebDriver `/tmp/saf.py` (no selenium); the WebDriver `/screenshot` DOES composite the WebGPU canvas
  (unlike `canvas.drawImage`/headless). Serve pak LOCALLY (`?pak=http://localhost:4173/wasm/`) to dodge
  slow remote re-downloads per fresh session.
- **`scripts/gltf-spike.mjs` :4180 quirk:** it starts/expects its OWN server on `127.0.0.1:4180` and
  won't point at an existing preview; `DET_URL` does NOT override its hardcoded URL. Anim-bridge
  preservation this session was proven via the base-patch delta (Anim.cpp byte-unchanged) + successful
  link, not by re-running the harness.
- **Deploy + `?pak` recipe:** `rsync -a --exclude 'wasm/base' --exclude 'wasm/base256'
  --exclude 'wasm/base-stream' --exclude 'wasm/levels' --exclude '*.glb' dist/ /tmp/rr-deploy/` then
  `set -a; source ~/.config/arco/cloudflare.env; set +a; CLOUDFLARE_ACCOUNT_ID=6f3ac7250ecff1b3cb3b9a92fc115b74
  npx wrangler@latest pages deploy /tmp/rr-deploy --project-name rayban-render --branch main`.
  Paks are proprietary + NOT deployed → the bare URL 404s the pak → BLACK screen; always test with
  `?pak=https://doom3-pak.pages.dev/` (WebGPU + area-streaming are default, so `?pak=` is the only
  param needed).
- **256-B four-binding lockstep:** the interaction-module `group(0)` uniform grew 224→256 for R-IBL.
  ALL FOUR bindings must move together: the record bind group, the record-depth bind group, the
  **pass-depth** bind group (`depthPipeline` shares interaction `vs_main`, so `bglDepth`'s
  minBindingSize is the FULL 256-B struct — a 224 pass-depth binding validation-fails ONLY that path),
  and the PBR self-test buffer/binding (same module). Any future `Uniforms` struct grow must bump all
  four or Dawn silently fails the pass-depth prepass.

## Build/gate quick ref
Build emsdk-600 (`source .build/emsdk-600/emsdk_env.sh; GL4ES_PATH=$PWD/.build/gl4es-600 bash
scripts/build-dhewm3.sh`). WGSL change → `python3 scripts/embed_wgsl.py .build/dhewm3/neo/renderer/wgsl
webgpu-port/shaders` BEFORE the patch regen. Regen mine:
`git -C .build/dhewm3 add -A -N neo && git -C .build/dhewm3 diff 8ebc11260d52638d2aff12ce73fbfccaa70db1b9
-- neo/renderer > patches/rayban-renderer.patch`. Gates (Dawn/headed Chrome, deterministic on re-run):
`scripts/ibl-verify.mjs`, `scripts/det-check.mjs`, `scripts/viewmodel-verify.mjs`,
`scripts/tracer-verify.mjs`, `scripts/gltf-spike.mjs`.
