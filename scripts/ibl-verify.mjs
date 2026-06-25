// R-IBL (Full PBR look) operator gate — RENDER/PERF Session D.
// Boots HEADED Chrome (real Dawn WebGPU; headless reads the WebGPU canvas black)
// and reads the in-engine IBL operator self-test (window.__d3IblSelfErr / __d3Ibl):
// fs_ibl_selftest drives the REAL ibl_ambient + synthetic probe for two known configs
// and byte-compares to the C++ ibl_cpu mirror. Also reads __d3WgpuDet (determinism)
// and __d3Pbr (the PBR-P0 gate must stay green after the 224->256 binding grow).
//
//   Run 1 (default): __d3IblSelfErr maxErr<=2 PASS  +  __d3WgpuDet IDENTICAL  +  __d3Pbr true
//   Run 2 (+set r_iblMutate 1): the shader halves the IBL term while the CPU mirror stays
//     correct -> __d3IblSelfErr large -> RED (proves the gate is NON-VACUOUS).
//
// Usage: node scripts/ibl-verify.mjs [baseUrl]
//   default base = http://localhost:4173/?backend=webgpu&pak=http://localhost:4173/wasm/
import { chromium } from "playwright";

const BASE = process.argv[2] ||
  "http://localhost:4173/?backend=webgpu&pak=http://localhost:4173/wasm/";
const TIMEOUT_MS = Number(process.env.IBL_TIMEOUT_MS || 150000);

const browser = await chromium.launch({
  channel: "chrome", headless: false, args: ["--ignore-gpu-blocklist"],
});

async function boot(label, extraArgs) {
  const ctx = await browser.newContext({ viewport: { width: 760, height: 760 } });
  const page = await ctx.newPage();
  const url = BASE + (extraArgs ? "&args=" + encodeURIComponent(extraArgs) : "");
  const errs = [];
  page.on("console", (m) => { const t = m.text(); if (/IBL operator|PBR GGX|DETERMINISM|shaderErr|error|FAIL/i.test(t)) errs.push(t); });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  const deadline = Date.now() + TIMEOUT_MS;
  let snap = {};
  while (Date.now() < deadline) {
    snap = await page.evaluate(() => ({
      ibl: window.__d3Ibl, iblErr: window.__d3IblSelfErr,
      pbr: window.__d3Pbr, pbrErr: window.__d3PbrSelfErr,
      det: Array.isArray(window.__d3WgpuDet) ? window.__d3WgpuDet : null,
      view: !!window.__d3ViewPos,
    })).catch(() => ({}));
    // the IBL self-test fires at detFrameCounter>=38, so wait until iblErr is defined
    if (snap.iblErr !== undefined && snap.iblErr !== null && snap.det && snap.det.length >= 2) break;
    await page.waitForTimeout(2000);
  }
  await ctx.close();
  const detIdentical = Array.isArray(snap.det) && snap.det.length > 0 &&
    snap.det.every((r) => typeof r === "string" ? /IDENTICAL/i.test(r) : (r.diffPx === 0 && r.maxDelta === 0));
  console.log(`[${label}] iblErr=${snap.iblErr} ibl=${snap.ibl} pbrErr=${snap.pbrErr} detIdentical=${detIdentical} detRounds=${snap.det?.length}`);
  console.log(`   ${errs.slice(-4).join("\n   ")}`);
  return { iblErr: snap.iblErr, ibl: snap.ibl, pbrErr: snap.pbrErr, detIdentical };
}

const ok = await boot("OPERATOR", null);                     // maxErr<=2, det IDENTICAL, pbr green
const red = await boot("MUTATION", "+set r_iblMutate 1");    // maxErr large -> RED
await browser.close();

const operatorPass = ok.ibl === true && ok.iblErr !== null && ok.iblErr <= 2;
const detPass = ok.detIdentical === true;
const pbrStillGreen = ok.pbrErr === 0;
const mutationRed = red.iblErr !== null && red.iblErr > 10;  // halving the term moves >>2 LSB

console.log("\n=== R-IBL GATE ===");
console.log(`operator (maxErr<=2):      ${operatorPass ? "PASS ✓" : "FAIL ✗"} (iblErr=${ok.iblErr})`);
console.log(`determinism (IDENTICAL):   ${detPass ? "PASS ✓" : "FAIL ✗"}`);
console.log(`PBR-P0 still green:        ${pbrStillGreen ? "PASS ✓" : "FAIL ✗"} (pbrErr=${ok.pbrErr})`);
console.log(`falsifiable (mutation RED): ${mutationRed ? "PASS ✓" : "FAIL ✗"} (mutated iblErr=${red.iblErr})`);
const allPass = operatorPass && detPass && pbrStillGreen && mutationRed;
console.log(`\nGATE: ${allPass ? "PASS ✓" : "FAIL ✗"}`);
process.exit(allPass ? 0 : 1);
