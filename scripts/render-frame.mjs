// scripts/render-frame.mjs — the snapshot -> PNG driver CLI (R3-ENGINE-RENDER).
//
// THE FROZEN SEAM CONTRACT (the follow-on R3-arco-render-verb packet consumes
// exactly this; any change here after freeze = gate_version bump + coordination note):
//
//   node scripts/render-frame.mjs --scene <scene.json> --out <frame.png> [--json] [--url <preview-url>]
//
//   scene.json = { "v": 1, "world": <replay world object, verbatim>, "state": <Pin-C RenderSnapshot, verbatim> }
//     - `state` is CONSUMED now (state.pose -> camera via the fixed transform T below).
//     - `world` is CARRIED-BUT-UNCONSUMED until S1 (world.solids engine ingest) lands. Its
//       presence keeps the Arco verb's shape stable across the S1/S2 transition.
//
//   SCENE SEMANTICS = S2 (owner-ACK'd): the camera pose is placed into ONE pinned committed
//   DOOM map (game/enpro). The frame is deterministic + input-sensitive, but its GEOMETRY is
//   semantically UNRELATED to the Arco replay world. CORRECTNESS of the T mapping is explicitly
//   NOT claimed. Every output is stamped scene_source="map-pose:game/enpro" in THREE places
//   (--json, the PNG sidecar, and the output FILENAME) so an S2 frame can never be mistaken for
//   replay-world ground truth (owner amendment 1, BINDING).
//
//   Exit codes (frozen):
//     0  frame written
//     2  wrong-backend: the engine is NOT on the WebGPU backend (the capture machinery
//        `window.__d3FrameCapture` exists only on the wgpu path and never publishes). Note
//        navigator.gpu is STILL defined under ?backend=gl — presence of navigator.gpu is NOT
//        the check; the engine's actual backend is.
//     3  missing-prereq (pak / dist / engine wasm / Chrome)
//     1  other
//
//   --json  -> { v, scene_source, backend, device, macosBuild, chromeVersion, engineWasmSha,
//                pakSha, fixtureSha, map, tick, transform, cvarSetHash, w, h, rawHash, fnv, out }
//
// RF_GATE_MUTATE=<name> (env): UNSTABLE gate-internal plumbing, NOT part of the frozen seam. The
// Arco verb never sets it. Modes: unfreeze-stagger | noboot-barrier | pose-perturb |
// wrong-backend | vacuous | tuple-spoof | scene-source-strip. Documented at applyMutation().
//
// Determinism model: the frame is captured from the det-PROVEN offscreen BGRA8 target via
// CopyTextureToBuffer -> MapRead (NOT a compositor screenshot — those pass through colour
// management and are not byte-stable). Setup -> settle -> freeze -> residency-barrier -> capture,
// in that HARD order (g_stopTime stops Think, so cvars set AFTER freeze do not propagate — the
// order is load-bearing). The gate runs this twice from fresh processes and requires hash equality;
// per-run determinism is self-proven every run, never assumed.

import { chromium } from "playwright-core";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, basename, extname } from "node:path";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---- the FIXED camera transform T (S2). Pinned constants; surfaced in --json.transform. --------
// state.pose{x,y,z,yaw} (Arco replay units; z = eye height, EYE_HEIGHT=1.7 per Pin-C) is mapped
// into game/enpro's committed geometry near the verified-lit spawn corridor. yaw adds; pitch is
// pinned to 0. Deterministic + input-sensitive; NOT claimed correct.
const T = {
  map: "game/enpro",
  anchor: { x: -320, y: 3968, z: -156 }, // enpro spawn corridor (verified lit via det-check)
  yaw0: -180,                            // spawn yaw
  pitch: 0,                              // pinned explicitly (frozen)
  scale: 8,                             // idTech units per replay unit
  eyeHeight: 1.7,                        // Pin-C EYE_HEIGHT
};
const SCENE_SOURCE = `map-pose:${T.map}`;         // owner amendment 1: stamp value
const SCENE_SOURCE_TOKEN = "map-pose.enpro";      // filesystem-safe filename token

function transformPose(pose) {
  const x = T.anchor.x + T.scale * pose.x;
  const y = T.anchor.y + T.scale * pose.y;
  const z = T.anchor.z + T.scale * (pose.z - T.eyeHeight);
  const yaw = T.yaw0 + pose.yaw;
  const pitch = T.pitch;
  return { setviewpos: [x, y, z, yaw, pitch], anchor: T.anchor, yaw0: T.yaw0, pitch: T.pitch, scale: T.scale, map: T.map };
}

// ---- FNV-1a (must be byte-identical to the C++ side in RenderBackend_WebGPU.cpp) ---------------
function fnv1a(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// ---- arg parsing ------------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--scene") out.scene = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--url") out.url = argv[++i];
    else { process.stderr.write(`render-frame: unknown arg ${a}\n`); process.exit(1); }
  }
  return out;
}

function die(code, msg) {
  process.stderr.write(`render-frame: ${msg}\n`);
  process.exit(code);
}

// ---- host / prereq metadata -------------------------------------------------------------------
function hostTuple() {
  const get = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: "utf8" }).trim(); } catch { return "unknown"; } };
  return { device: get("sysctl", ["-n", "hw.model"]), macosBuild: get("sw_vers", ["-buildVersion"]) };
}
function engineWasmSha() {
  const p = join(REPO_ROOT, "public/wasm/dhewm3.wasm");
  try { return sha256(readFileSync(p)); } catch { return null; }
}
// pakSha: stable digest of the served pak variant (sorted path:size list). Default boot uses
// base-stream (STREAM_TIER). Keys the baseline so a pak swap is a legitimate regen event.
function pakSha() {
  const dir = join(REPO_ROOT, "public/wasm/base-stream");
  try {
    const entries = readdirSync(dir).sort();
    const lines = entries.map((f) => { try { return `${f}:${statSync(join(dir, f)).size}`; } catch { return `${f}:?`; } });
    return sha256(lines.join("\n"));
  } catch { return null; }
}
function chromePresent() {
  for (const p of ["/Applications/Google Chrome.app"]) { try { statSync(p); return true; } catch {} }
  return false;
}

// ---- gate-internal mutations (NOT the frozen seam) --------------------------------------------
const MUTATE = process.env.RF_GATE_MUTATE || "";
function applyMutation(hooks) {
  switch (MUTATE) {
    case "": return;
    case "pose-perturb":        hooks.posePerturbYaw = 5; return;            // MUT-B: +5 yaw POST-LOAD (committed fixture untouched)
    case "wrong-backend":       hooks.backend = "gl"; return;               // MUT-C1: ?backend=gl -> exit 2
    case "vacuous":             hooks.captureVacuous = true; return;        // MUT-C2: inject a blank frame
    case "tuple-spoof":         hooks.spoofChrome = true; return;           // MUT-D: spoof chromeVersion -> missing tuple
    case "scene-source-strip":  hooks.stripSceneSource = true; return;      // MUT-E (owner amd 1): drop sidecar stamp
    case "unfreeze-stagger":    hooks.staggerMs = Number(process.env.RF_GATE_STAGGER_MS || 0); return; // MUT-A: stagger the capture game-time -> different scene
    case "noboot-barrier":      hooks.captureImmediate = true; return;      // MUT-A fallback: capture at the run-varying first frame (wall-clock-coupled)
    default: die(1, `unknown RF_GATE_MUTATE '${MUTATE}'`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.scene) die(1, "missing --scene");
  if (!args.out) die(1, "missing --out");

  const hooks = { backend: "webgpu", posePerturbYaw: 0, captureVacuous: false, captureImmediate: false, spoofChrome: false, stripSceneSource: false, staggerMs: 0 };
  applyMutation(hooks);

  // prereqs (exit 3 if missing)
  const wasmSha = engineWasmSha();
  const pSha = pakSha();
  if (!wasmSha) die(3, "missing engine wasm (public/wasm/dhewm3.wasm) — run STAGING build");
  if (!pSha) die(3, "missing pak (public/wasm/base-stream) — run STAGING pak copy");
  if (!chromePresent()) die(3, "Google Chrome not installed (headed WebGPU requires installed Chrome)");

  // scene
  let scene;
  try { scene = JSON.parse(readFileSync(args.scene, "utf8")); }
  catch (e) { die(1, `cannot read --scene: ${e.message}`); }
  if (scene?.v !== 1 || !scene.world || !scene.state?.pose) die(1, "scene.json must be { v:1, world, state{pose} }");
  const fixtureSha = sha256(readFileSync(args.scene));
  const pose = { ...scene.state.pose };
  if (hooks.posePerturbYaw) pose.yaw = (pose.yaw || 0) + hooks.posePerturbYaw;
  const tick = scene.state.tick;
  const xform = transformPose(pose);

  // pinned deterministic cvar set (applied BEFORE freeze). Disable the periodic in-engine det
  // self-test — the gate proves determinism itself via two processes; my capture uses its own
  // offscreen resources, so this only removes noise/contention. cvarSetHash keys the baseline.
  // com_fixedTic 1 must be pinned from BOOT (a +set boot arg, so it wins over the app's own +set /
  // autoexec seta — StartupVariable re-applies command-line +set LAST). Otherwise catch-up ticks run
  // during the slow level-load and race game-time ~4x ahead by arm-time, which is nondeterministic
  // (measured 20s vs 43s across two boots). With it, no catch-up: game-time advances a fixed 16ms per
  // rendered frame, so the capture target is crossed at a tick-exact game-time in every run.
  const BOOT_ARGS = "+set com_fixedTic 1";
  // r_wgpuDetTest 0: disable the periodic in-engine det self-test (my gate proves determinism via two
  // processes; the capture uses its own offscreen resources, so this only removes contention).
  const PINNED_CVARS = ["r_wgpuDetTest 0"];
  const cvarSetHash = sha256([BOOT_ARGS, ...PINNED_CVARS].sort().join("\n"));

  const baseUrl = (args.url || "http://localhost:4190/");
  const url = baseUrl + (/\?/.test(baseUrl) ? "&" : "?") + `backend=${hooks.backend}&args=${encodeURIComponent(BOOT_ARGS)}`;

  const browser = await chromium.launch({ channel: "chrome", headless: false, args: ["--ignore-gpu-blocklist"] });
  const ctx = await browser.newContext({ viewport: { width: 800, height: 800 } });
  const page = await ctx.newPage();
  const logs = [];
  page.on("console", (m) => { const t = m.text(); if (/\[d3\]|FrameCapture|backend|demot|Error|error/i.test(t)) logs.push(t); });
  page.on("pageerror", (e) => logs.push(`PAGEERROR: ${e.message}`));

  let exitCode = 1;
  try {
    const chromeVersion = browser.version();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    const d3cmd = (cmd) => page.evaluate((c) => window.d3cmd && window.d3cmd(c), cmd);
    const read = (fn) => page.evaluate(fn).catch(() => null);

    // Boot: wait until the ENGINE is rendering frames (the #diag overlay shows a numeric fps —
    // backend-agnostic, so this also detects the GL path for the wrong-backend mutation) OR a
    // WebGPU-only global appears. Then REQUIRE the WebGPU backend (only it publishes __d3ShadowVols
    // / __d3WgpuTexMB / __d3FrameCapture). Engine-renders-but-no-wgpu => exit 2 (wrong backend).
    const BOOT_MS = 300000, t0 = Date.now();
    let engineUp = false, wgpuUp = false, lastLog = 0;
    while (Date.now() - t0 < BOOT_MS) {
      const s = await read(() => ({ sv: window.__d3ShadowVols ?? null, tex: window.__d3WgpuTexMB ?? null, cap: !!window.__d3FrameCapture, rt: window.__d3RenderTimeMs ?? null, diag: (document.querySelector("#diag")?.textContent || "").split("\n")[0]?.slice(0, 90) || "" }));
      const wg = s?.sv != null || s?.tex != null || s?.cap;
      if (wg) wgpuUp = true;
      if (wg || /fps\s+\d/.test(s?.diag || "")) engineUp = true;
      const el = Math.round((Date.now() - t0) / 1000);
      if (el - lastLog >= 15) { lastLog = el; process.stderr.write(`[render-frame] boot ${el}s wgpu=${wgpuUp} rt=${s?.rt} diag="${s?.diag || ""}"\n`); }
      if (hooks.captureImmediate && engineUp) break;
      if (engineUp && wgpuUp) break;
      await sleep(1000);
    }
    if (!engineUp) { exitCode = 1; throw new Error(`engine never rendered a view within ${BOOT_MS / 1000}s`); }
    if (!wgpuUp && !hooks.captureImmediate) { exitCode = 2; throw new Error("WebGPU backend not active (gl demote / wrong backend)"); }
    process.stderr.write(`[render-frame] engine up after ${Math.round((Date.now() - t0) / 1000)}s (wgpu=${wgpuUp})\n`);

    // Setup: pin the deterministic cvar set (com_fixedTic 1 -> game-time advances a fixed 16ms/frame,
    // so the capture target is crossed at a tick-exact game-time in every run) and place the camera.
    // NO g_stopTime freeze: the capture fires at a FIXED game-time (below), and idTech4 game state is
    // a fixed-16ms-timestep function of game-time, so that frame is deterministic across runs.
    if (!hooks.captureImmediate) {
      for (const c of PINNED_CVARS) await d3cmd(c);
      const [x, y, z, yaw, pitch] = xform.setviewpos;
      await d3cmd(`setviewpos ${x} ${y} ${z} ${yaw} ${pitch}`);
      await sleep(2500);   // let the teleport land + the load-fade clear before the target crossing
    }

    // Target game-time (ms). Fixed + well above the arm-time game-time so both runs approach the
    // crossing from BELOW (a target <= current game-time would fire immediately at a run-varying
    // time). MUT-A staggers it -> a different scene; the immediate fallback uses ~0.
    const BASE_TARGET_MS = 60000;
    const target = hooks.captureImmediate ? 1 : (BASE_TARGET_MS + (hooks.staggerMs || 0));
    const rtNow = await read(() => window.__d3RenderTimeMs ?? null);
    process.stderr.write(`[render-frame] arming capture at game-time ${target}ms (current ~${rtNow}ms)\n`);
    if (!hooks.captureImmediate && rtNow != null && rtNow >= target) { exitCode = 1; throw new Error(`arm-time game-time ${rtNow}ms already >= target ${target}ms (target too low)`); }

    await page.evaluate(() => { window.__d3FrameCapture = null; });
    await d3cmd(`r_wgpuCaptureFrame ${target}`);

    // Poll: the capture fires when main-view game-time crosses `target`.
    const CAP_MS = 180000, c0 = Date.now();
    let cap = null, lastAwait = 0;
    while (Date.now() - c0 < CAP_MS) {
      cap = await read(() => {
        const c = window.__d3FrameCapture;
        if (!c || !c.pixels || c.w <= 0) return null;
        return { w: c.w, h: c.h, hash: c.hash >>> 0, gen: c.gen >>> 0, pixels: Array.from(c.pixels) };
      });
      if (cap) break;
      const el = Math.round((Date.now() - c0) / 1000);
      if (el - lastAwait >= 15) { lastAwait = el; const rt = await read(() => window.__d3RenderTimeMs ?? null); process.stderr.write(`[render-frame] awaiting capture ${el}s: game-time ~${rt}ms / target ${target}ms\n`); }
      await sleep(300);
    }
    await d3cmd("r_wgpuCaptureFrame 0");
    if (!cap) { exitCode = 1; throw new Error("__d3FrameCapture never published (game-time never reached target, or capture failed)"); }
    if (!hooks.captureImmediate && cap.gen !== target) { exitCode = 1; throw new Error(`capture fired for gen ${cap.gen} != armed target ${target}`); }

    const pixels = Uint8Array.from(cap.pixels);   // published bytes: [B,G,R,0xFF] per pixel (BGRA, alpha forced)
    if (hooks.captureVacuous) pixels.fill(0);     // MUT-C2: inject a blank (all-black) frame -> CLAUSE-2 vacuity RED
    // Integrity: JS FNV-1a over the published bytes MUST equal the engine's C++ FNV-1a. (Skipped under
    // the vacuous fault, which deliberately overwrites the bytes AFTER capture.)
    const jsFnv = fnv1a(pixels);
    if (!hooks.captureVacuous && jsFnv !== cap.hash) { exitCode = 1; throw new Error(`FNV mismatch: JS ${jsFnv.toString(16)} != C++ ${cap.hash.toString(16)}`); }
    const rawHash = sha256(Buffer.from(pixels));  // the durable gate hash (over raw padding-stripped, alpha-forced pixels)
    // vacuity stats over RGB (CLAUSE-2 surface): nonblack fraction + distinct colours (capped).
    let nonblack = 0; const colors = new Set(); const nPix = pixels.length / 4;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] || pixels[i + 1] || pixels[i + 2]) nonblack++;
      if (colors.size < 512) colors.add((pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2]);
    }
    const nonblackFrac = nonblack / nPix;
    const distinctColors = colors.size;

    // BGRA -> RGBA for the PNG artifact (hash is order-agnostic; the artifact must look right).
    const rgba = new Uint8Array(pixels.length);
    for (let i = 0; i < pixels.length; i += 4) { rgba[i] = pixels[i + 2]; rgba[i + 1] = pixels[i + 1]; rgba[i + 2] = pixels[i]; rgba[i + 3] = 255; }
    const { encodePNG } = await import(join(REPO_ROOT, "gates/inspect_render/png-encode.mjs"));
    const png = encodePNG(cap.w, cap.h, rgba);

    // scene_source stamped in the FILENAME (owner amendment 1c).
    const ext = extname(args.out) || ".png";
    const base = basename(args.out, ext);
    const stampedName = `${base}.${SCENE_SOURCE_TOKEN}.t${tick}${ext}`;
    const outPath = join(dirname(resolve(args.out)), stampedName);
    writeFileSync(outPath, png);

    // scene_source stamped in the SIDECAR (owner amendment 1b). MUT-E drops it.
    const host = hostTuple();
    const reportedChrome = hooks.spoofChrome ? `SPOOF-${chromeVersion}` : chromeVersion;
    const meta = {
      v: 1,
      scene_source: hooks.stripSceneSource ? undefined : SCENE_SOURCE,
      backend: hooks.backend,
      device: host.device, macosBuild: host.macosBuild, chromeVersion: reportedChrome,
      engineWasmSha: wasmSha, pakSha: pSha, fixtureSha,
      map: T.map, tick,
      transform: xform,
      cvarSetHash,
      w: cap.w, h: cap.h,
      rawHash, fnv: cap.hash.toString(16),
      nonblackFrac, distinctColors,
      out: outPath,
    };
    writeFileSync(outPath + ".json", JSON.stringify(meta, null, 2) + "\n");

    exitCode = 0;
    if (args.json) process.stdout.write(JSON.stringify(meta) + "\n");
    else process.stdout.write(`render-frame: wrote ${outPath} (${cap.w}x${cap.h}) rawHash=${rawHash.slice(0, 16)} scene_source=${SCENE_SOURCE}\n`);
  } catch (e) {
    process.stderr.write(`render-frame: ${e.message}\n`);
    process.stderr.write(logs.slice(-15).join("\n") + "\n");
  } finally {
    await browser.close().catch(() => {});
  }
  process.exit(exitCode);
}

main();
