# Device-playability beacon (render-track)

A `?beacon=<collector-base>` hook in the rayban client that reports boot→runtime→spawn progress,
an fps heartbeat, and — the reason it exists — the **WebGPU device-loss reason** OUTWARD to a
collector, so a phone with no usable inspector still yields telemetry. It drives the **shared**
device-playability loop Spine built for Arco (`~/Arco/doom/dev/device_play_collector.mjs` +
`scripts/run_eval_device_play.sh`); the collector + verdict are reused as-is.

**Why:** the standing render-track target is the intermittent **`device lost (destroyed)`** on
iOS 18 (iPad) AND iOS 26.5 (iPhone) — the Safari-26/Emscripten WebGPU issue (imgui#9103),
almost certainly tripped by a render-pass/material in the capture-replay backend we own. The
loop lets us A/B which command trips it and verify a fix on a real device, version-proof.

## Client hook (this repo)

- **`index.html`** — an inline `<script>` (runs before the bundle, so it survives a bundle/wasm
  load hang). Gated on `?beacon=<base>`; a no-op touching no globals when absent (zero prod
  overhead). It:
  - POSTs `{run,t,ev,phase,fps,heap,vp,shdw,lost,tail,...}` to `<base>/b` (text/plain → no CORS
    preflight; the collector sets `ACAO:*`). `keepalive` so an unload beacon flushes.
  - emits `boot` (with `ua`), a 1500 ms `hb` heartbeat, and detects `runtime` (Module up) +
    `spawn` (first real rendered view, `window.__d3ViewPos`) by polling the engine's existing
    `window.__d3*` signals — **no engine edit** for those.
  - counts presented frames via a `GPUQueue.prototype.submit` hook for `fps` (honest under the
    iter-30 submit-skip: a static frame reads low).
  - **self-blank guard:** polls `<base>/active`; on supersede (a newer run booted) or `stop`,
    navigates to `about:blank` to **release this tab's WebGPU context**. Each device launch opens
    a new Safari tab, so without this the old test tabs stay live and N WebGPU contexts contend
    the GPU — tanking perf AND amplifying the device-loss we're chasing.
  - exposes `window.__d3Beacon(ev, extra)` for the engine to call.
- **`src/d3Runtime.js`** — the `device.lost` handler sets `window.__d3DeviceLost` and fires
  `window.__d3Beacon('gpu-lost', {reason, msg})` **immediately** (the critical signal — a jetsam
  kill still lands the reason at the collector before the tab dies).

Events: `boot · runtime · spawn · hb · gpu-lost · blanked · pagehide`. The collector's verdict
keys off `spawn` + `gpu-lost` + `fps_p50` (see its source).

## Running the loop

```bash
# 1. collector (shared, from the Arco tree):
node ~/Arco/doom/dev/device_play_collector.mjs 8787      # POST /b · GET /active · /verdict · /stop · /reset

# 2. serve the rayban client reachable from the phone (cloudflared tunnel over the built dist/).
#    IMPORTANT (iOS 26): a cross-SITE POST to a trycloudflare collector can be dropped. Serve the
#    client SAME-ORIGIN with the collector (one tunnel fronting both) — then ?beacon points at the
#    same origin and the POST is same-origin. (iOS 18 / iPad has no such restriction.)

# 3. launch on device (devices are SHARED with Spine — coordinate first; never run two WebGPU
#    contexts on one device):
#   iPhone:  xcrun devicectl device process launch --device <UDID> \
#              --payload-url "<client-url>?backend=webgpu&pak=<pak>&beacon=<collector-base>" \
#              --terminate-existing com.apple.mobilesafari
#   iPad:    PYMOBILEDEVICE3_UDID=<UDID> pymobiledevice3 webinspector launch \
#              "<client-url>?backend=webgpu&pak=<pak>&beacon=<collector-base>" --userspace

# 4. read the verdict:
curl -s localhost:8787/verdict | python3 -m json.tool
curl -s localhost:8787/stop          # tell every test tab to self-blank (free their GPU contexts)
```

## Status

- Client hook + self-blank guard: **DONE** (Dawn smoke-verified: events arrive at a local
  collector; default boot — no `?beacon` — is byte-unaffected).
- The on-device **A/B of which backend command trips the device-loss** + a `device.lost`
  recovery (re-acquire/fallback) or GPU-pressure reduction: **queued** behind device
  availability (both devices currently held by Spine — coordinate before grabbing one).
