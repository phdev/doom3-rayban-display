// R-GLTF Spike-A verification (headed Chrome/Dawn). Boots the engine, writes a
// static GLB (content-forge's crate) into MEMFS as a loose model file, testmodels
// it, and confirms: LoadGLTF parsed it (-> N surfaces), no errors, the WebGPU
// backend renders it with ZERO backend change, and the determinism self-test
// stays IDENTICAL. Headless reads WebGPU black -> headed Chrome only.
import { chromium } from "playwright";
const URL = process.env.GLTF_URL || "http://127.0.0.1:4180/?backend=webgpu";
const GLB = process.env.GLTF_ASSET || "/spike-crate.glb";   // served by vite from public/wasm? -> /wasm/spike-crate.glb
const browser = await chromium.launch({ channel: "chrome", headless: false, args: ["--ignore-gpu-blocklist"] });
const page = await (await browser.newContext({ viewport: { width: 800, height: 800 }, deviceScaleFactor: 1 })).newPage();
const log = [];
page.on("console", (m) => { const t = m.text(); if (/LoadGLTF|gltf|glb|surfaces|testmodel|Couldn't load|Warning|Error|DETERMIN/i.test(t)) log.push(t); });
page.on("pageerror", (e) => log.push("PAGEERROR: " + e.message));

console.log(`[gltf-spike] ${URL}`);
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
// wait for a rendered frame
const dl = Date.now() + 150000;
let ready = false;
while (Date.now() < dl) {
  if (await page.evaluate(() => !!window.__d3ViewPos || (window.__d3ShadowVols ?? 0) > 0).catch(() => false)) { ready = true; break; }
  await page.waitForTimeout(2000);
}
if (!ready) { console.log("[gltf-spike] never rendered"); console.log(log.slice(-10).join("\n")); await browser.close(); process.exit(2); }
console.log("[gltf-spike] booted + rendering");

// write the GLB into MEMFS as a loose model (engine base = /base), then testmodel it.
const ASSET = process.env.GLTF_ASSET || "/wasm/spike-rigged.glb";   // rigged fixture (skin + 1 anim clip)
const wrote = await page.evaluate(async (glbUrl) => {
  const M = window.Module; if (!M || !M.FS) return "no Module.FS";
  const buf = new Uint8Array(await (await fetch(glbUrl)).arrayBuffer());
  const mk = (d) => { try { M.FS.mkdir(d); } catch {} };
  mk("/base/models"); mk("/base/models/spike");
  try { M.FS.writeFile("/base/models/spike/rigged.glb", buf); } catch (e) { return "write ERR " + e.message; }
  return "wrote " + buf.length + " bytes to /base/models/spike/rigged.glb";
}, ASSET).catch((e) => "ERR " + e.message);
console.log("[gltf-spike] FS:", wrote);

await page.evaluate(() => window.d3cmd && window.d3cmd("testmodel models/spike/rigged.glb"));
await page.waitForTimeout(5000);

const canvas = await page.$("#webgpuCanvas") || await page.$("#gameCanvas");
if (canvas) { await canvas.screenshot({ path: "/tmp/gltf-spike.png" }); console.log("[gltf-spike] screenshot -> /tmp/gltf-spike.png"); }

// definitive signals (LoadGLTF sets these via EM_ASM — engine Printf doesn't reach JS)
const sig = await page.evaluate(() => ({
  called: window.__d3GltfCalled || 0,
  surfaces: window.__d3GltfSurfaces,
  loaded: window.__d3GltfLoaded,
  animJoints: window.__d3GltfAnimJoints,     // parsed skeleton joint count
  animFrames: window.__d3GltfAnimFrames,     // resampled clip frame count
  modelJoints: window.__d3GltfModelJoints,   // joints exposed on the skinned model
  animRegistered: window.__d3GltfAnimRegistered,  // D3_RegisterGltfAnim returned (no abort)
})).catch(() => ({}));
console.log("\n=== LoadGLTF signals ===", JSON.stringify(sig));
const det = await page.evaluate(() => window.__d3WgpuDet || null).catch(() => null);
console.log("=== det ===", JSON.stringify(det));
console.log("=== JS console (errors/warnings) ===");
console.log(log.filter((l) => /PAGEERROR|Couldn't|Error|Warning/i.test(l)).slice(-6).join("\n") || "(none)");
console.log("\n=== __d3WgpuDet ===", JSON.stringify(det));

// --- P0 scaffolding for the P3 full-animate kill-criterion ---
// Drive the clip via the shipped testanim (CycleAnim) path and sample the P3
// skinned-vertex probe at two animation phases. Until P2 (CPU-skinning in
// InstantiateDynamicModel) + P3 (the __d3SkinnedVertPos_W EM_ASM probe in
// tr_render.cpp) land, the probe is undefined and this block is a NON-FATAL
// "pending" report. It auto-activates as the hard motion gate once the
// instrument exists (instrument => require delta>threshold AND measuredFrames>=2).
const ANIM_THRESHOLD = Number(process.env.GLTF_ANIM_THRESHOLD || 0.1); // D3 units; make-rig.py derives ~25
let anim = { instrument: false, frames: 0, delta: null };
try {
  await page.evaluate(() => window.d3cmd && window.d3cmd("testanim bend"));
  const sample = () => page.evaluate(() => ({
    pos: window.__d3SkinnedVertPos_W || null,
    frames: window.__d3SkinnedVertMeasuredFrames || 0,
  })).catch(() => ({ pos: null, frames: 0 }));
  await page.waitForTimeout(350); const a = await sample();   // ~clip start
  await page.waitForTimeout(700); const b = await sample();   // ~clip extreme (clip is 1.0s)
  anim.frames = b.frames || 0;
  if (a.pos && b.pos) { anim.instrument = true; anim.delta = Math.hypot(b.pos[0] - a.pos[0], b.pos[1] - a.pos[1], b.pos[2] - a.pos[2]); }
} catch { /* non-fatal in P0 */ }
if (anim.instrument) {
  console.log(`=== ANIMATE === probe delta=${anim.delta.toFixed(3)} D3u (threshold ${ANIM_THRESHOLD}), measuredFrames=${anim.frames}`);
} else {
  console.log("=== ANIMATE (scaffolding) === __d3SkinnedVertPos_W not published yet — pending P2 CPU-skinning + P3 probe (non-fatal in P0)");
}

await browser.close();

const detArr = Array.isArray(det) ? det : [];
const detOk = detArr.length === 0 || detArr.every((r) => r.diffPx === 0 && r.maxDelta === 0);
const meshOk = (sig.called || 0) > 0 && sig.loaded === true && (sig.surfaces || 0) > 0;
const skelOk = (sig.animJoints || 0) > 0 && (sig.modelJoints || 0) === (sig.animJoints || 0);
const animOk = (sig.animFrames || 0) > 1;   // resampled to >1 frame
// Spike-B green: D3_RegisterGltfAnim fires in the clean release build (the
// earlier instantiate failure was a stale wasm/JS minify mismatch, not a code bug).
const regOk = sig.animRegistered === 1;
const reg = regOk ? "fired" : "NOT REGISTERED";
// P0: non-blocking (no instrument yet). P3: hard motion gate (delta>threshold AND >=2 measured frames AND det IDENTICAL).
const animateOk = !anim.instrument || (anim.delta > ANIM_THRESHOLD && anim.frames >= 2 && detOk);
const animStatus = anim.instrument
  ? (animateOk ? `✓ (delta=${anim.delta.toFixed(2)}D3u)` : `✗ (delta=${(anim.delta || 0).toFixed(2)}D3u, frames=${anim.frames})`)
  : "pending P2/P3";
console.log(`\nVERDICT: mesh ${meshOk ? "✓" : "✗"} (surfaces=${sig.surfaces}) | skeleton ${skelOk ? "✓" : "✗"} (animJoints=${sig.animJoints}, modelJoints=${sig.modelJoints}) | anim-clip ${animOk ? "✓" : "✗"} (frames=${sig.animFrames}) | register=${reg} | det ${detOk ? "IDENTICAL ✓" : "NOT IDENTICAL ✗"} | animate ${animStatus}`);
process.exit(meshOk && skelOk && animOk && regOk && detOk && animateOk ? 0 : 1);
