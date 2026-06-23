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
})).catch(() => ({}));
console.log("\n=== LoadGLTF signals ===", JSON.stringify(sig));
const det = await page.evaluate(() => window.__d3WgpuDet || null).catch(() => null);
console.log("=== det ===", JSON.stringify(det));
console.log("=== JS console (errors/warnings) ===");
console.log(log.filter((l) => /PAGEERROR|Couldn't|Error|Warning/i.test(l)).slice(-6).join("\n") || "(none)");
console.log("\n=== __d3WgpuDet ===", JSON.stringify(det));
await browser.close();

const detArr = Array.isArray(det) ? det : [];
const detOk = detArr.length === 0 || detArr.every((r) => r.diffPx === 0 && r.maxDelta === 0);
const meshOk = (sig.called || 0) > 0 && sig.loaded === true && (sig.surfaces || 0) > 0;
const skelOk = (sig.animJoints || 0) > 0 && (sig.modelJoints || 0) === (sig.animJoints || 0);
const animOk = (sig.animFrames || 0) > 1;   // resampled to >1 frame
console.log(`\nVERDICT: mesh ${meshOk ? "✓" : "✗"} (surfaces=${sig.surfaces}) | skeleton ${skelOk ? "✓" : "✗"} (animJoints=${sig.animJoints}, modelJoints=${sig.modelJoints}) | anim-clip ${animOk ? "✓" : "✗"} (frames=${sig.animFrames}) | det ${detOk ? "IDENTICAL ✓" : "NOT IDENTICAL ✗"}`);
process.exit(meshOk && skelOk && animOk && detOk ? 0 : 1);
