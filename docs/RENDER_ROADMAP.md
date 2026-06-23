# RENDER/PERF track roadmap — modern-renderer feature program (owner-directed 2026-06-22)

> **⟡ RE-SCOPED 2026-06-23 (owner) — read this first; the Phase A/B/C plan below is SUPERSEDED.**
> After the mobile-friendliness analysis of soft shadows and HDR/IBL, the owner **CUT M4 soft
> shadows, F1/M1 HDR, and M2 IBL**, and chose **mobile-friendly motion blur → then M6 PBR** instead.
> The new sequence is: **(1) camera motion blur (mobile) → (2) PBR (GGX, authored metallic-roughness).**
> Motion-blur TYPE locked = **CAMERA/world via DEPTH RECONSTRUCTION** (screen velocity from depth +
> cur/prev view-proj; one bloom-class fullscreen pass; **no per-object velocity G-buffer**; viewmodel
> excluded; tier-scaled, default-OFF, off on the glasses tier). **Determinism correction:** §3/§6 below
> say "motion blur is nondeterministic → cut" — that was conflated with TAA. Motion blur from
> *deterministic* velocity (cur+prev VP are fixed per frame) is `__d3WgpuDet`-compatible, exactly like
> the R0 tonemap post-pass, so it is buildable without sacrificing the determinism instrument. The
> detailed motion-blur milestone plan lives in `docs/MOTIONBLUR_PLAN.md`. PBR (§ below) is unchanged.
> M5 PCF shadow maps remain never-mobile (iter-39 per-light-pass trap). Everything below is retained
> as the superseded prior plan + the still-valid tier/cross-session/PBR detail.

Owner directive: add **PBR, image-based lighting/environment probes, shadow mapping, bloom, motion
blur, and modern antialiasing** to the WebGPU backend. This doc re-architects the R-track to deliver
that, ordered by dependency × value × on-device viability. Produced via a recon→synthesis→adversarial
workflow (`wf_cdea93a2-57f`; 4 adversarial lenses all `sound-with-fixes`, fixes folded in). **Plan for
review — no engine code until the decisions in §6 are locked.**

## 1. The honest reality (what this directive actually is)

It is **not one project**. The six asks split three ways:

1. **Already shipped (in spirit):** LDR bloom (iter-19), BFG analytic specular (iter-29), stencil +
   Quest shadow-darken, and R0's ACES tonemap+dither. "Bloom" is partly done.
2. **Cheap, all-tier, no new per-frame targets** — shippable now in the proven R0/iter-19 mold
   (LDR-on-LDR or static baked data): **FXAA, screen-space soft shadows, baked diffuse IBL, a
   world-normal capture channel.**
3. **Desktop-tier HDR-pipeline re-architecture** — needs new per-frame resident targets the
   **iPhone WebKit→Metal GPU process cannot afford**: RGBA16F scene buffer (HDR), G-buffer MRT (true
   PBR), per-light depth maps (PCF), velocity+history (TAA/motion-blur). iter-26/28/30 proved the
   iPhone killer is **per-frame allocation/bandwidth churn**, and every one of these multiplies it.

Two more hard truths the adversarial review nailed:
- **PBR + IBL are a CONTENT program, not renderer work.** DOOM 3 ships diffuse/normal/specular — **zero
  metallic-roughness data, zero baked probes** (grep confirms). A spec-gloss→metallic heuristic is
  "slop, not an approximation." Real PBR/IBL need a new offline material+probe baker = cross-session
  content work, gated on an owner decision.
- **F1 (HDR) is mis-scoped — it's XL, not L, and desktop-only.** It's a color-FORMAT change rippling
  through ~13 hardcoded-BGRA8 pipelines, and the determinism self-test (`runDeterminismRound`,
  hardcoded BGRA8 + 4-byte readback) must be fixed to resolve→LDR before readback *as a blocking
  sub-task inside F1*, or the project loses its core honesty instrument.

## 2. Dependency-ordered roadmap (resequenced VALUE-FIRST per the adversarial review)

**Phase A — cheap, all-tier, ships independent of any foundation (the R0/iter-19 mold):**
- **M3 · FXAA** (S) — one fullscreen edge-AA pass on the final LDR frame. iPhone + wearable viable, det-safe, zero new resident targets. The cross-tier antialiasing answer.
- **M4 · Screen-space soft shadows** (M) — render the existing stencil-shadow union to a single-channel mask, bilateral-blur it, modulate. ~80% of the soft-shadow look at a fraction of the cost; **respects the iter-39 law (no per-light pass explosion).** This is the *ship form* of "shadow mapping" on mobile.
- **F2 · World-normal capture channel** (M) — a new capture lane recording per-record model→world rotation + a world-normal varying in `interaction.wgsl` (the iter-13b/iter-38 capture-lane class; no render target). iPhone-safe. Unblocks IBL ambient + correct reflections.

**Phase B — desktop HDR foundation + its dependents (desktop-only first; iPhone gated behind a separate RSS-measure milestone F1b):**
- **F1 · Linear-HDR scratch scene buffer (RGBA16F) + ACES resolve** (XL, desktop-only) — redirect the lit/blend/sky/fog/shadow passes into an RGBA16F target; R0's `fs_tonemap` becomes the HDR→LDR resolve. **Includes the blocking det-harness resolve-to-LDR fix.** Doubles scene-pass bandwidth → desktop-only until F1b clears it on Mac Safari.
- **M1 · HDR bloom** (S, on F1) — re-point iter-19 bloom at the RGBA16F target so the bright-pass sees true >1.0 radiance (real glow energy, not clipped 8-bit).
- **M2 · Baked diffuse IBL** (L, on F2 + a new probe-baker) — offline-bake low-res irradiance cubes per render-area centroid (auto-placed from the area-stream PointInArea dump), load via the existing cube cache, add `irradiance(world_N)` ambient. **Most iPhone-friendly directed feature** (static upload-once cubes). Blocked on the probe-baker (cross-session).

**Phase C — desktop-only spikes, gated on §6 decisions (build only if greenlit):**
- **M5 · True PCF shadow maps** (XL, desktop-only) — per-light depth atlas + PCF. The exact per-light-pass architecture iter-39 dismantled to stop the iPhone crash → **never mobile**; build only if M4 proves visually inadequate on desktop.
- **M6 · Metallic-roughness PBR (GGX)** (XL, asset-gated) — needs F1+F2+a G-buffer (F3) + content-authored metallic-roughness. **Does not exist unless the content decision (§6) says "author PBR materials."**

## 3. CUT (recommended, with evidence)

- **Motion blur — CUT.** Needs a per-pixel velocity buffer id Tech 4 never computes + history feedback → both a per-frame-target multiplier (iPhone-fatal) AND nondeterministic (breaks `__d3WgpuDet`). Lowest value of the six (stylistic, not fidelity). No mobile form exists.
- **TAA — CUT** (use FXAA everywhere; SMAA as a desktop-only upgrade if needed). TAA needs velocity + per-frame history + jitter → inherently nondeterministic (breaks the det self-test) and history/velocity targets are the resident-per-frame class iter-30 proved fatal. **SMAA is the det-safe desktop upgrade path; TAA is not worth sacrificing the determinism instrument.**

## 4. Tier strategy

Per-tier feature ceilings (not desktop-first-then-port):
- **Desktop (Chrome/Dawn):** everything — F1 HDR, HDR bloom, diffuse+(later)specular IBL, M4 soft shadows, FXAA/SMAA, and the M5/M6 spikes. Determinism stays the gate for all deterministic features.
- **iPhone (WebKit):** only zero/near-zero per-frame-churn features — M3 FXAA, M4 soft shadows, M2 baked IBL, F2. F1/HDR only if F1b's Mac-Safari GPU-process RSS re-measure (iter-30 recipe) clears it. No M5/M6/TAA/motion-blur, ever.
- **Ray-Ban wearable (96px):** the cheapest subset only — FXAA + baked IBL; everything else OFF.

## 5. Cross-session dependencies

- **M2 IBL** is blocked on a **new offline probe-baker** (auto-place + headless 6-face render of the reduced-pak level + irradiance convolve + ship cubes) — analogous to the `bake-geo-*` pipeline; a content-track tool, not pure renderer.
- **M6 PBR** is blocked on **content-authored metallic-roughness channels** (Session B / content-forge territory). Coordinate before any M6 work.
- Backend changes stay in `patches/rayban-renderer.patch` (my half); no `neo/game/` or `rayban-base.patch` edits.

## 6. Decisions — LOCKED with owner (2026-06-22)

1. **Motion blur + ALL antialiasing → CUT.** Owner cut motion blur AND antialiasing (FXAA/SMAA/TAA all
   dropped — no new AA work). Determinism instrument preserved. **M3 (FXAA) removed from the roadmap.**
2. **PBR → AUTHOR metallic-roughness (the content program).** True PBR via authored metallic-roughness
   channels + a G-buffer (F3). XL, **cross-session with the content/forge track** — coordinate before M6.
3. **Shadows → screen-space soft shadows (M4), all-tier.** True PCF (M5) deferred/desktop-only-if-ever.
4. **Sequencing → value-first.** Phase A first; F1/HDR desktop-only until F1b clears iPhone.

### Finalized milestone set (post-decisions)
- **Phase A (cheap, all-tier, ship now):** **M4 screen-space soft shadows** + **F2 world-normal channel.**
  (FXAA cut → no longer in Phase A.)
- **Phase B (desktop HDR foundation):** **F1** RGBA16F + det-harness resolve fix → **M1** HDR bloom →
  **M2** baked diffuse IBL (needs the probe-baker; most iPhone-friendly).
- **Phase C (greenlit, content-gated, XL):** **F3** G-buffer + **M6** true metallic-roughness PBR (GGX) +
  specular IBL — blocked on content-authored metallic-roughness (coordinate with the content track).
- **CUT:** motion blur, FXAA/SMAA/TAA, true PCF shadow maps (M5, unless desktop demands it later).

## Status
Decisions LOCKED → **building Phase A, value-first** (M4 soft shadows + F2 world-normal). Each milestone
ships a falsifiable `metrics{}` gate proven red + default-OFF until on-device-verified (R0 pattern).
PBR (M6) needs a content-track hand-off for metallic-roughness authoring before it can start.
Recon caveat: 6/7 per-feature recon agents were rate-limited; synthesis + the 4 adversarial lenses
source-grounded the plan directly; individual milestone specs can be deepened on request.

---

## 7. FORMAT CONTRACT — LOCKED with CONTENT + SPINE (2026-06-22)

Content-forge + SPINE reviewed the program; owner locked the contract. **Both PBR and IBL ride
mechanisms the engine already has → minimal render-side surface, ZERO base-patch (SPINE) edits.**

- **PBR → ORM-packed into the existing specularmap slot.** Content emits one ORM texture
  (**R=AO, G=roughness, B=metallic, LINEAR**) placed in the material's specularmap slot; render
  reinterprets it as PBR via an **`isPBR` flag in the unused `specular_color.w`**. **No new engine
  keyword, no new binding, no base-patch edit — only render's GGX shader math.** (Separate _mr/_rmo
  maps would need a `Material.cpp` keyword = SPINE base-patch = a much larger v2; rejected for v1.)
  Content-forge ALREADY emits `metallic.png`+`roughness.png` (the Meshy gun) → P0 unblocked now.
- **PBR scope:** **new content-forge assets only** (MR-native). Legacy DOOM 3 has no MR data; deriving
  it is the rejected spec-gloss "slop". (Matches §6.)
- **IBL → 6 face PNGs** (`_px.._nz`, RGBA8, square, **32px**) + a tiny `cameraCubeMap` `.mtr` per probe
  → loads through the **unchanged cube path**. **Per-area centroid placement, per-area selection,
  ≤32-probe budget. CPU-hemisphere bake (v1).**
- **CONTENT owns:** the ORM pack + `.mtr` auto-gen, the probe-baker (sibling of `bake_lighting.mjs`),
  and the falsifiable gates (`pbr_orm_packed_ok`, `mr_channels_in_range`, `pbr_material_has_orm`,
  `mtr_pbr_roundtrip`; `probe_energy_nonzero`, `probe_directional`, `probe_cube_format_ok` — each
  mutation-proven RED). Sequencing: **IBL (Phase B) before PBR (Phase C)**; PBR P0 ships now (maps exist).
- **RENDER must add (the §F list):** the per-area **centroid dump field** (probe placement), the
  **cube-cache cap** raise (≤32), the **ORM + irradiance WGSL** (GGX reading ORM; `irradiance(world_N)`
  ambient using F2's world-normal), and the **`isPBR` flag** plumbing (`specular_color.w`).

## 8. NEW MILESTONE — R-GLTF: glTF model loader + skinned-anim bridge (RENDER-owned, SPIKE-GATED)

SPINE surfaced this as the **cross-track unblocker** and squarely RENDER's lane (it intersects the PBR
contract — a glTF loader that auto-gens a `.mtr` per material *is* the render↔content asset bridge).
Content-forge emits **GLB**; the engine loads MD5/LWO/ASE but **not glTF** — so nothing content-forge
generates can enter the engine until this lands. **Content is HOLDING its MD5 writer until a spike passes.**

- **Wire contract is format-blind (SPINE-verified):** combat replication is two 12-bit `animNum` fields
  → `CycleAnim(ch, animNum)`, a symbolic 1-indexed token into `idDeclModelDef::anims[]` — says nothing
  about MD5 vs glTF. **glTF enemies "just work" with shipped combat, zero netcode/anim-drive change** —
  *condition:* glTF anims register into the same `.def` anim-list in the same 1-indexed order (pipeline,
  not netcode). M8/M9 combat untouched.
- **The one hard gap (the spike's kill-criterion):** dhewm3's `idMD5Anim` is text-`.md5anim`-only.
  Build `idMD5Anim`/`idJointQuat` frame arrays **in-memory** from glTF clips (cleaner than a disk
  round-trip for WASM) so the resolved object is an `idMD5Anim`. **⚠ this touches `neo/anim` — coordinate
  the patch split with SPINE** (renderer owns `idRenderModelGLTF` in `neo/renderer`; the anim bridge may
  cross into base-patch files).
- Otherwise clean: ModelManager dispatch = one else-if (extension→subclass); the WebGPU backend consumes
  abstract 60-byte CPU-skinned `idDrawVert` → a glTF loader that CPU-skins into that layout (mirroring
  `idMD5Mesh::TransformVerts`) needs **zero backend changes**; the glTF parser uses stock idlib (JSON via
  `idLexer`); materials = auto-gen `.mtr` + the ORM contract above.
- **SPIKE (recommended NEXT, ~3–5 pd):** load + render + **animate** one rigged glTF in WebGPU **on a
  phone** (re-export an imp, or content's `forge_blaster_v1.glb` static first). Bonus: spawn it as a
  replicated enemy → confirm the same 12-bit `animNum` drives it with the unmodified combat patch.
  **PASS → content ships glTF-emit + deletes the MD5 writer. FAIL on the anim bridge → fallback = glTF
  for static props (kill LWO), keep MD5 for rigged enemies.** **Do NOT delete any converter until the
  spike passes.** Full milestone ~21–30 pd.

## 9. Revised sequencing (post-alignment)

1. **R-GLTF spike** — RECOMMENDED NEXT. Cross-track unblocker (content + SPINE both gated on it) + the
   PBR-contract foundation. De-risks the entire content→engine pipeline before anyone deletes converters.
2. **PBR P0 shader math** (ORM-in-specular-slot + `isPBR`) — can ride alongside R-GLTF (the maps exist
   now; needs glTF-loaded assets to be useful).
3. **M4 soft shadows + F2 world-normal** — pure-render polish, no cross-track dependency; slot around the
   spike.
4. **Phase B:** F1 HDR foundation (desktop-only) + M1 HDR bloom + M2 baked IBL (render adds centroid-dump
   field + cube-cache cap; content builds the probe-baker).
5. **Phase C:** full PBR (GGX on glTF assets) + specular IBL.

## Status (updated 2026-06-22)
Format contract LOCKED; glTF loader added as R-GLTF (RENDER-owned, spike-gated). **Recommended next =
the R-GLTF spike** (cross-track unblocker). M4/F2/PBR-P0 ready to slot around it. Coordinate the
anim-bridge patch split with SPINE before touching `neo/anim`.
