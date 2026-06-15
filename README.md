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

Example:

```
https://phdev.github.io/doom3-rayban-display/?pak=https%3A%2F%2Fcdn.example.com%2Fdoom3%2F
```

The engine itself (`.js`/`.wasm`/`.data`) is served from GitHub Pages; only the
paks come from your `?pak=` host.

### Hosting the paks on Cloudflare R2

1. Build the paks locally (see [Build](#build)) — they land in
   `public/wasm/{base,base-stream,base256}/`.
2. Create a public R2 bucket and add a CORS rule allowing `https://phdev.github.io`
   to `GET` (see the header of `scripts/upload-paks-to-r2.sh`).
3. Upload:
   ```bash
   R2_BUCKET=<bucket> R2_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com \
     scripts/upload-paks-to-r2.sh
   ```
4. Launch with `?pak=<your public base URL>/doom3/`.

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
