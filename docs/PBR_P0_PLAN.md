# PBR-P0 — metallic-roughness GGX shader (the M6 de-risking step)

**Status: DONE on Dawn (2026-06-23, `render-track`). Falsifiable gate green. Phone gate (P3) deferred to the iPad rig.**

The first, renderer-only slice of M6 PBR: a GGX/Cook-Torrance direct BRDF that
consumes content-forge's ORM pack, gated so legacy materials are byte-identical.
Per the §7 contract (locked 2026-06-22 with SPINE + content-forge): **zero new
engine keyword, zero new binding, zero base-patch** — the ORM rides the existing
`specularmap` slot and `isPBR` rides the unused `specular_color.w`.

## What shipped

- **`interaction.wgsl` `pbr_direct(N,L,V,albedo,roughness,metallic,ao)`** — Karis
  UE4-mobile GGX: `F0=mix(0.04,albedo,metallic)`, Trowbridge-Reitz `D` (α=rough²),
  Smith Schlick-GGX `G` (k=(rough+1)²/8, direct), Schlick `F`, spec =
  `D·G·F/(4·NdotL·NdotV)`, diffuse = `(1-F)·(1-metallic)·albedo` (un-π-normalized to
  match the engine's legacy diffuse scale), `ao` on the diffuse term. Returns the
  BRDF; the caller applies `N·L` + the light radiance (same outer structure as legacy).
- **`isPBR` gate in `fs_main`** — `if (u.specular_color.w > 0.5)` → `t_specular` is the
  **LINEAR ORM** (R=AO, G=roughness, B=metallic) and the BRDF term is `pbr_direct`;
  **else the legacy Blinn-Phong path runs VERBATIM** (the OFF-identity guarantee).
  `specular_color.w` is a per-record uniform → uniform control flow → the branch +
  the `textureSample` in the else are legal.
- **Capture (`draw_arb2.cpp`)** — `r.specularColor[3]` is OVERWRITTEN with the isPBR
  flag (so legacy records get exactly 0). P0 driver = `r_pbrForce` (A/B); the
  per-material ORM-name convention is wired when content's ORM `.mtr` lands (gated on
  R-GLTF — no ORM GLB loads yet).
- **Cvars** — `r_pbr` (1, master enable) + `r_pbrForce` (0, force isPBR for A/B),
  via the standard `g_cap*` mirror.

## Falsifiable gate (Dawn)

`runPbrSelfTest` (one-shot, frame≥36) drives the **REAL `pbr_direct`** via a dedicated
fullscreen pipeline (interaction module `vs_fs_main` + `fs_pbr_selftest`, a single
group(0) uniform BGL — no textures) for two known configs and byte-compares the
readback to the CPU `pbr_cpu` mirror (same formula, `PBR_PI=3.14159265` exact):

- **A (dielectric, metallic=0)** → `(196,25,25)` — tests diffuse + Fresnel + (1-metallic).
- **B (metal, metallic=1)** → `(6,1,1)` — tests D·G·F0 spec, no diffuse.

**Gate (`/tmp/pbr-verify.mjs`, headed Chrome/Dawn): operator maxErr=0 PASS · OFF-identity
det IDENTICAL.** **Falsifiable:** a `diffuse * 0.5` mutation → config A `(98,13,13)` →
**maxErr=98 RED** (config B unchanged — diffuse-only). `window.__d3Pbr` / `__d3PbrSelfErr`.

> Self-test config caveat: L=V → VdotH=1 → the Schlick `(1-VdotH)^5` term is 0, so the
> **Fresnel exponent is not exercised** by these configs (F=F0 in both). The metallic
> split, D, G, F0, kd, diffuse, and spec ARE covered. A grazing-angle config is a P3 add.

## Remaining for full M6 (NOT P0)

- **End-to-end** (a content GLB with an ORM `.mtr` renders PBR on a device) — gated on
  **R-GLTF** (no ORM GLB loads yet) + finalizing the per-material isPBR signal (ORM-name
  convention; confirm with content-forge) + the **iPad phone gate**.
- **F3 G-buffer** + **specular IBL** (needs F2 world-normal) — the larger M6 pieces.
- Look calibration in real enpro lighting (the un-π-normalized scale was chosen to sit
  near the legacy diffuse energy; tune on-device).

Build: emsdk-600; regen ONLY `patches/rayban-renderer.patch`; the shader bakes from
`webgpu-port/shaders/` via `embed_wgsl.py` at build time.
