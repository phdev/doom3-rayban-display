# DOOM 3 — Meta Ray-Ban Display

An open-source [dhewm3](https://github.com/dhewm/dhewm3) (DOOM 3, GPL idTech4)
build compiled to WebAssembly and rendered with a **custom WebGPU backend**,
packaged as a web app shell for the **Meta Ray-Ban Display**. It uses Meta
Neural Band pinch gestures + W3C `DeviceOrientationEvent` head-turning for input,
and streams a reduced first-level (`maps/game/enpro`, the Enpro Plant) so it
loads fast on a wearable.

It is the DOOM 3 sibling of
[glquake2-rayban-display](https://github.com/phdev/glquake2-rayban-display) and
follows the same architecture: a Vite web shell, an engine source **patch**, and
a local packaging workflow. It boots into the level and renders the 3D world —
industrial geometry, per-pixel lighting, stencil shadows — at ~50–60 fps on real
GPU hardware.

---

## Play URL

**The reduced DOOM 3 paks are not shipped in this repo** (they contain
copyrighted id Software game data). Host them yourself and pass the base URL:

```
https://phdev.github.io/doom3-rayban-display/?pak=<URL-encoded base URL>
```

`<base URL>` is the folder that contains `base/`, `base-stream/`, and `base256/`
(e.g. a Cloudflare R2 bucket). After the first load the chunks/blobs cache in
browser storage, so later launches with the same URL are offline-fast.

The reference deployment hosts the paks on **Cloudflare Pages** at
`https://doom3-pak.pages.dev/`, so the play URL is:

```
https://phdev.github.io/doom3-rayban-display/?pak=https://doom3-pak.pages.dev/
```

The engine itself (`.js`/`.wasm`/`.data`) is served from GitHub Pages; only the
paks come from your `?pak=` host.

### Hosting the paks (Cloudflare Pages)

R2 needs to be enabled on the account; Cloudflare **Pages** works out of the box
(public by default, CORS via a `_headers` file) and is what the reference deploy
uses. With `wrangler` authenticated to your account:

```bash
scripts/upload-paks-to-pages.sh        # stages base/ + lean areastream set + _headers, deploys
# -> https://doom3-pak.pages.dev/  ;  launch with ?pak=https://doom3-pak.pages.dev/
```

If you prefer R2 (enable it in the dashboard first), `scripts/upload-paks-to-r2.sh`
does the equivalent with `aws s3 sync`. Either way the host needs CORS allowing
the Pages origin to `GET` (the scripts set `Access-Control-Allow-Origin`).

---

## Generate your own glasses-optimized pak

You must own DOOM 3 and supply your own PK4s — **no game data is in this repo**.
This repo ships the tools to turn your owned data into the small, glasses-tuned
package the app loads (reduced to one level, binary-geometry-baked, per-area
streamed, unused monsters stripped, sound off).

The fastest way is to hand the prompt below to a coding agent (Claude Code,
Cursor, etc.) running **on your own machine** in this repo. Do **not** paste or
upload copyrighted PK4 contents into a hosted chat service.

```text
I own DOOM 3 and have my legally obtained PK4s at:

DOOM3_BASE=/absolute/path/to/dhewm3/base   # has pak000.pk4..pak008.pk4 + game00..03.pk4

Build a GLASSES-OPTIMIZED display pak for the doom3-rayban-display web app (this
repo) from maps/game/enpro, install it into public/wasm/, and verify it.

Goal:
- A reduced single-level package for maps/game/enpro (the Enpro Plant), small
  enough to load fast on a Meta Ray-Ban Display: per-area RENDER geometry
  streaming with ALL textures resident at boot.
- Outputs, chunked + manifested, ready for scripts/upload-paks-to-pages.sh:
  - public/wasm/base/          (monolith, the ?noareastream fallback)
  - public/wasm/base-stream/   (boot pak + enpro.areas.stream geometry blob)
- A short report: original size, boot-pak size, streamed-geometry size,
  retained/removed file counts.

Rules:
- Keep ONLY what maps/game/enpro references — run the repo's decl-aware closure
  (scripts/reduce-d3-map-pk4.py). Never delete by folder/filename alone.
- Preserve everything the first level needs: world textures, the player weapon(s)
  AND their projectiles/effects (verify the imp fireball particles
  impfireball2 / imp_trail2 / imp_explosion + their textures are present), every
  monster that ACTUALLY spawns in enpro and its animations, the friendly Sentry
  Bot, the NPCs (Swann/Campbell share characters/npcs), GUIs/HUD, fonts, lights,
  particles, decals.
- STRIP only the monsters that never spawn in enpro: cacodemon, spectre, skeleton
  (models/md5/monsters/<m>/ and models/monsters/<m>/). Confirm 0 map refs first.
- Do NOT strip the cinematics — the cutscene idAnimated entities (e.g.
  enpro_cin_player_1) fatally error on a missing anim and abort the map load.
- Bake the binary geometry caches INTO the pak (.bcm/.bproc/.bmap/.baas48) so the
  ~2.3 s ASCII parse is skipped even on first visit.
- Split the render geometry for per-area streaming: the boot region resides in
  the boot pak, the rest goes in enpro.areas.stream. The boot pak keeps ALL
  textures (textures load at boot, only geometry streams).
- Audio is disabled at runtime (s_noSound 1); no .wav/.ogg are needed — keep the
  .sndshd decls so material/entity decls don't error.

Suggested steps (use THIS repo's scripts; read CLAUDE.md iters 62/64/73/74 for
the exact pipeline):
1. Work in a temp dir; leave DOOM3_BASE unchanged.
2. scripts/reduce-d3-map-pk4.py  -> reduced enpro pak (closure over the map +
   engine GUIs + the loadout weapons).
3. Boot the engine once on the reduced pak so it writes .bcm/.bproc/.bmap/.baas48,
   then bake them into the pak (scripts/bake-geo-extract.mjs + bake-geo-pak.py).
   This is the monolith public/wasm/base/pak-display.pk4.
4. Strip models/md5/monsters/{cacodemon,spectre,skeleton}/ + the matching
   models/monsters/ texture dirs from the pak.
5. scripts/bake-area-stream.sh + scripts/pack-area-stream.py  -> the areastream
   boot pak (boot-region geometry) + enpro.areas.stream; merge ALL textures into
   the boot pak so nothing but geometry streams.
6. scripts/chunk-pk4.py each pak (<= 4 MB chunks + manifest).
7. Install into public/wasm/{base,base-stream}/.
8. npm run dev, open the bare URL (default = areastream), and inspect the console:
   - confirm it boots, renders, and streams geometry ("Area streaming complete"),
   - fix any genuinely-referenced first-level asset that logs "Couldn't load"
     (especially weapon projectile/effect particles and spawned-monster anims).
9. Report the sizes and counts.

Prefer commands that can be rerun, and show the exact commands used.
```

Then host the result and launch:

```bash
scripts/upload-paks-to-pages.sh    # -> https://<project>.pages.dev/
# https://phdev.github.io/doom3-rayban-display/?pak=https://<project>.pages.dev/&glasses
```

---

## Status & features

The engine compiles, boots, mounts a reduced PK4, and renders the enpro level in
the browser. Highlights of what this fork adds on top of stock dhewm3:

### Renderer — WebGPU (primary)
- A **hand-written WebGPU backend** is the default renderer. It captures the
  engine's per-frame draw records (interactions, shadows, blend/fog, sky, GUI)
  and replays them through WGSL pipelines. This fixes the iPhone WebKit-WebGL
  "chunky-tile"/flicker artifact that GL4ES exhibits (byte-identical frames on
  device).
- **GL4ES (WebGL2) fallback** auto-engages if the browser lacks WebGPU.
  `?backend=gl` forces it; `?echo` runs both side-by-side.

### Boot speed
- **Binary geometry cache baked into the pak**: `.bcm` (collision), `.bproc`
  (render), `.bmap` (entities), `.baas48` (AI nav) replace the slow ASCII
  `.cm`/`.proc`/`.map`/`.aas48` parse — the ~2.3 s tokenizer cost is gone, even
  on first visit.
- **Per-area geometry streaming** (default): the boot pak carries every texture +
  the boot-region render geometry; the rest of the render geometry streams in
  per render-area after the player is already playing.
- GUI reference-closure pruning, main-menu deferral, and decl-purge tuning trim
  the rest of the "Configuring / Starting map" time.

### Asset size
- A **reduced display pak** contains only the assets `maps/game/enpro` references
  (built by `scripts/reduce-d3-map-pk4.py` — a decl-aware closure over the map).
- Unused monsters that never spawn in enpro (cacodemon/spectre/skeleton) are
  stripped. Current download: **~17.7 MB boot + ~2.7 MB streamed geometry**.

### Wearable / glasses build
- **Clean UI on the glasses**: the debug readout, log/copy buttons, fx panel, and
  on-screen D-pad are hidden on the wearable (small-display / Android-WebView /
  `?glasses`). `?diag` forces the debug UI back on any device.
- **Permanent flashlight** — a view-attached projected light that stays lit with
  any weapon equipped (toggle with the on-screen chip / the flashlight gesture).
- **Unlimited ammo** — reserves are kept topped up; the readout shows real
  numbers and never depletes.
- **Auto-fire assist** — traces forward from the view and fires when a hostile is
  centered; a line-of-fire trace holds fire when the friendly Sentry Bot is in
  the way.
- **Sound disabled** (`s_noSound 1`) — no audio ships and the engine skips audio
  init.

### Input
- Meta Neural Band **pinch** = attack, **pinch-hold** = flashlight; head turning
  via `DeviceOrientationEvent`; an on-screen D-pad is the touch/desktop fallback.

---

## URL parameters

| Param | Effect |
|---|---|
| `?pak=<url>` | Base URL for the paks (required when hosting externally). |
| `?backend=gl` | Force the GL4ES (WebGL2) renderer instead of WebGPU. |
| `?echo` | Render GL + WebGPU side-by-side (debug). |
| `?noareastream` / `?nostream` | Load the monolith (everything at boot, no geometry streaming). |
| `?hd` | 256px-texture monolith tier. |
| `?diag` / `?debug` | Force the debug overlay on (incl. on the glasses). |
| `?glasses` | Force the clean wearable UI (hides debug + D-pad). |
| `?nodiag` | Hide the debug overlay. |

---

## Build

Requires the pinned Emscripten + GL4ES toolchains (set up under `.build/`).

```bash
# engine (regenerates neo/ from the patch, builds dhewm3.wasm + installs to public/wasm/)
source .build/emsdk-600/emsdk_env.sh
GL4ES_PATH=$PWD/.build/gl4es-600 bash scripts/build-dhewm3.sh

# web shell
npm install && npm run dev      # local dev server (serves public/wasm paks locally)
npm run build                   # dist/ for deploy
```

Engine source lives in `patches/dhewm3-meta-rayban-display.patch` (applied onto a
pinned dhewm3 commit). The WebGPU shaders are in `webgpu-port/shaders/*.wgsl`
(embedded into the build by `scripts/embed_wgsl.py`). `dhewm3.wasm` is gitignored;
CI (`.github/workflows/deploy-pages.yml`) rebuilds it from the patch and bundles
`src` → `dist` with Vite.

### Packaging the paks
- `scripts/reduce-d3-map-pk4.py` — build the reduced display pak from your owned
  DOOM 3 PK4s (keeps only enpro-referenced assets).
- `scripts/bake-area-stream.sh` + `scripts/pack-area-stream.py` — split the
  binary render geometry into the boot region + the per-area stream blob.
- `scripts/chunk-pk4.py` — chunk a pak for HTTP-friendly fetching.
- `scripts/upload-paks-to-r2.sh` — push `public/wasm/{base,base-stream,base256}`
  to a Cloudflare R2 bucket.

You must own DOOM 3 and supply your own PK4s; this repo ships no game data.

---

## Known limitations
- **iPhone "orange panel" bug (open):** at the enpro spawn, two panels render
  bright orange on iPhone WebKit-WebGPU (correct/dark on Chrome/Dawn and on Mac
  Safari — it does not reproduce on the Mac GPU). NaN-safe guards were added to
  the lit-pass shader per the documented WebKit near-plane interpolation
  pathology, but the iPhone-GPU mechanism is still unresolved.
- Cutscenes are kept (the cutscene `idAnimated` entities fatally error on a
  missing anim, so they cannot simply be stripped).
- Saves use volatile Emscripten MEMFS, so on death the level reloads from the
  boot autosave but there is no cross-reload persistence.

## License
Engine: GPL (dhewm3 / idTech4). Game data: not included — owned separately.
