// Determinism self-test harness (RENDER/PERF session, Session D).
// Boots the app in HEADED Chrome (real Metal->Dawn WebGPU; headless reads the
// WebGPU canvas black and demotes to GL) and reads the in-engine determinism
// self-test (window.__d3WgpuDet, CLAUDE.md "Iter 6.8"). The self-test renders
// identical draw records twice into offscreen BGRA8, copies to MapRead buffers,
// and byte-compares -- it must report IDENTICAL. This is the R0 gate instrument.
//
// Usage: node scripts/det-check.mjs [url]
//   default url = http://localhost:5173/?backend=webgpu
//   env: DET_URL, DET_TIMEOUT_MS (default 180000), DET_ROUNDS (default 2)
import { chromium } from "playwright";

const URL = process.argv[2] || process.env.DET_URL || "http://localhost:5173/?backend=webgpu";
const TIMEOUT_MS = Number(process.env.DET_TIMEOUT_MS || 180000);
const WANT_ROUNDS = Number(process.env.DET_ROUNDS || 2);

const browser = await chromium.launch({
  channel: "chrome",          // use the installed Google Chrome (real GPU), not bundled Chromium
  headless: false,            // headed: WebGPU compositing + a real Dawn device
  args: ["--ignore-gpu-blocklist"],
});
const ctx = await browser.newContext({ viewport: { width: 800, height: 800 } });
const page = await ctx.newPage();

const d3log = [];
const allLog = [];
page.on("console", (m) => { const t = m.text(); allLog.push(t); if (/\[d3\]|DETERMINISM|backend|WebGPU|primary|demot|pak|stream|Error|error/i.test(t)) d3log.push(t); });
page.on("pageerror", (e) => { d3log.push(`PAGEERROR: ${e.message}`); });
page.on("requestfailed", (r) => { const u = r.url(); if (/wasm|pak|stream/.test(u)) d3log.push(`REQFAIL: ${u} ${r.failure()?.errorText || ""}`); });

console.log(`[det-check] loading ${URL}`);
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
const gpu = await page.evaluate(() => ({ hasGpu: !!navigator.gpu, hasModule: typeof window.Module !== "undefined" })).catch((e) => ({ err: String(e) }));
console.log(`[det-check] navigator.gpu=${gpu.hasGpu} Module=${gpu.hasModule} ${gpu.err || ""}`);

const deadline = Date.now() + TIMEOUT_MS;
let det = null;
let lastState = "";
while (Date.now() < deadline) {
  const snap = await page.evaluate(() => ({
    det: window.__d3WgpuDet || null,
    heap: window.__d3HeapMB || null,
    shadowVols: window.__d3ShadowVols ?? null,
    diag: (document.querySelector("#diag")?.textContent || "").split("\n")[0]?.slice(0, 160) || "",
  })).catch(() => ({}));
  if (snap.diag && snap.diag !== lastState) { lastState = snap.diag; console.log(`[det-check] diag: ${snap.diag}`); }
  const rounds = Array.isArray(snap.det) ? snap.det : (snap.det && snap.det.rounds) ? snap.det.rounds : null;
  if (rounds && rounds.length >= WANT_ROUNDS) { det = snap.det; console.log(`[det-check] heap=${snap.heap}MB shadowVols=${snap.shadowVols}`); break; }
  if (typeof snap.det === "object" && snap.det && snap.det.count >= WANT_ROUNDS) { det = snap.det; break; }
  await page.waitForTimeout(2000);
}

console.log("\n=== window.__d3WgpuDet ===");
console.log(JSON.stringify(det, null, 2));
console.log("\n=== d3 / boot / error console lines (last 25) ===");
console.log(d3log.slice(-25).join("\n") || "(none captured)");
console.log(`\n[det-check] total console lines seen: ${allLog.length}`);

await browser.close();

// Verdict: every recorded round must be byte-identical.
// __d3WgpuDet rounds are { round, diffPx, maxDelta, w, h, surfaces }.
const arr = Array.isArray(det) ? det : (det && det.rounds) || [];
const identical = arr.length > 0 && arr.every((r) =>
  typeof r === "string" ? /IDENTICAL/i.test(r) : (r.diffPx === 0 && r.maxDelta === 0));
if (!det) { console.log("\nRESULT: NO DET DATA (WebGPU may have demoted to GL — check console lines above)"); process.exit(2); }
console.log(`\nRESULT: ${identical ? "IDENTICAL ✓" : "NOT IDENTICAL ✗"}`);
process.exit(identical ? 0 : 1);
