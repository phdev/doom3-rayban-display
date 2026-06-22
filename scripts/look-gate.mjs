// R0 look-direction gate (RENDER/PERF, Session D).
// Captures the enpro spawn corridor in headed Chrome/Dawn (the only honest
// WebGPU readback — drawImage/getImageData on a WebGPU canvas read black, so we
// screenshot at the compositor level) with the tonemap OFF, then ON, then ON at
// a lower exposure. scripts/look-analyze.py computes the iter-29 luma metrics
// (game-region median, std/mean, deep-shadow fraction<8) for each — the
// tonemap-ON frame must move TOWARD the BFG reference vs a FRESH OFF baseline.
//
// This is the Dawn-only "look-direction" arm of the R0 gate. The determinism
// arm is scripts/det-check.mjs; operator-correctness is the in-engine LUT self-test.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.LG_URL || "http://127.0.0.1:4180/?backend=webgpu";
// enpro spawn corridor (iter-38 spawn viewpos); flashlight is OFF by default (iter-37).
const VIEW = process.env.LG_VIEW || "-320 3968 -155.75 180 0";
const OUT = "/tmp/lookgate";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", headless: false, args: ["--ignore-gpu-blocklist"] });
const page = await (await browser.newContext({ viewport: { width: 800, height: 800 }, deviceScaleFactor: 1 })).newPage();
const log = [];
page.on("console", (m) => { const t = m.text(); if (/\[d3\]|tonemap|DETERMIN/i.test(t)) log.push(t); });

console.log(`[look-gate] ${BASE}`);
await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });

// wait for a real rendered frame
const deadline = Date.now() + 150000;
let ready = false;
while (Date.now() < deadline) {
  const r = await page.evaluate(() => !!window.__d3ViewPos || (window.__d3ShadowVols ?? 0) > 0).catch(() => false);
  if (r) { ready = true; break; }
  await page.waitForTimeout(2000);
}
if (!ready) { console.log("[look-gate] never rendered (WebGPU demoted?)"); console.log(log.slice(-10).join("\n")); await browser.close(); process.exit(2); }

const canvas = await page.$("#webgpuCanvas") || await page.$("#gameCanvas");
async function shoot(name) { await page.waitForTimeout(1500); await canvas.screenshot({ path: `${OUT}/${name}.png` }); console.log(`[look-gate] shot ${name}`); }
async function cmd(c) { await page.evaluate((x) => window.d3cmd && window.d3cmd(x), c); }

// Capture at the NATURAL boot spawn — NOT setviewpos (which triggers a
// "Ready" load-fade that catches screenshots black; iter-25/125). Settle long
// so textures prewarm + the boot fade clears, then A/B without moving the camera.
await page.waitForTimeout(9000);

// in-engine gates (authoritative): operator-LUT + determinism
const gates = await page.evaluate(() => ({ lut: window.__d3TonemapLut, lutErr: window.__d3TonemapLutMaxErr, det: window.__d3WgpuDet })).catch(() => ({}));
console.log(`[look-gate] LUT operator gate: pass=${gates.lut} maxErr=${gates.lutErr}; det rounds=${Array.isArray(gates.det)?gates.det.length:0}`);

await cmd("r_tonemap 0"); await shoot("off");
await cmd("r_tonemap 1"); await cmd("r_tonemapExposure 1.0"); await shoot("on_e10");
await cmd("r_tonemapExposure 0.6"); await shoot("on_e06");
await cmd("r_tonemapExposure 1.0"); await cmd("r_tonemapDither 0"); await shoot("on_nodither");

console.log("\n=== tonemap/det console ===");
console.log(log.filter((l) => /tonemap|DETERMIN/i.test(l)).slice(-8).join("\n") || "(none)");
await browser.close();
console.log(`\n[look-gate] wrote ${OUT}/{off,on_e10,on_e06,on_nodither}.png — run: python3 scripts/look-analyze.py`);
