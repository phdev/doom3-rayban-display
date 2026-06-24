// R-VIEWMODEL gate: weapon view-model depth separation, verified on Dawn (headed Chrome).
// GL's RB_EnterWeaponDepthHack confines the view weapon to the front half of the depth
// buffer via glDepthRange(0,0.5) so it never clips into close world geometry. The WebGPU
// port baked only the projection-compress half; R-VIEWMODEL adds the depth-range half as a
// per-record [0,0.5] viewport on weapon-flagged records (sPad1==1u). This proves it on the
// correctness oracle (Dawn); the phone is the deferred final gate.
//
// Gates:
//   (1) determinism : __d3WgpuDet IDENTICAL (every round diffPx==0) with the gun in view
//                     + feature ON — the per-record viewport is applied identically in both
//                     det re-encodes (encodeRecordsPass is the shared body), so it cannot
//                     introduce non-determinism.
//   (2) feature fires: __d3WeaponDepthRecords > 0 at the enpro spawn (the gun is given at
//                     spawn) — proves capture flags real weapon records AND the replay path
//                     applies the [0,0.5] range to them.
//   (3) falsifiable : r_weaponDepthSep 0 -> __d3WeaponDepthRecords == 0 (feature disabled =>
//                     OFF-identity, zero SetViewport calls) AND det still IDENTICAL. The
//                     1->0 flip taking the count >0 -> 0 proves the gate genuinely controls
//                     the feature (not a vacuous always-on path).
//
// Usage: node scripts/viewmodel-verify.mjs
//   env: VM_URL (default http://localhost:4173/), VM_PAK (default doom3-pak.pages.dev),
//        VM_TIMEOUT_MS (default 150000)
import { chromium } from "playwright";

const BASE = process.env.VM_URL || "http://localhost:4173/";
const PAK = process.env.VM_PAK || "https://doom3-pak.pages.dev/";
const TIMEOUT_MS = Number(process.env.VM_TIMEOUT_MS || 150000);

async function run(label, extraArgs) {
  const args = encodeURIComponent(`+set r_wgpuDetTest 1 ${extraArgs}`.trim());
  const url = `${BASE}?backend=webgpu&pak=${encodeURIComponent(PAK)}&args=${args}`;
  const browser = await chromium.launch({ channel: "chrome", headless: false, args: ["--ignore-gpu-blocklist"] });
  const ctx = await browser.newContext({ viewport: { width: 800, height: 800 } });
  const page = await ctx.newPage();
  const logs = [];
  page.on("console", (m) => { const t = m.text(); if (/\[d3\]|DETERMIN|weapon|WeaponDepth|device lost|Error|error/i.test(t)) logs.push(t); });
  page.on("pageerror", (e) => logs.push("PAGEERROR " + e.message));
  console.log(`\n[${label}] ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

  const deadline = Date.now() + TIMEOUT_MS;
  let det = null, wmMax = 0, lastDiag = "";
  const started = Date.now();
  while (Date.now() < deadline) {
    const s = await page.evaluate(() => ({
      det: window.__d3WgpuDet || null,
      wm: (typeof window.__d3WeaponDepthRecords !== "undefined") ? window.__d3WeaponDepthRecords : null,
      shadowVols: window.__d3ShadowVols ?? null,
      diag: (document.querySelector("#diag")?.textContent || "").split("\n")[0]?.slice(0, 130) || "",
    })).catch(() => ({}));
    if (typeof s.wm === "number" && s.wm > wmMax) wmMax = s.wm;
    if (s.diag && s.diag !== lastDiag) { lastDiag = s.diag; console.log(`[${label}] ${Math.round((Date.now()-started)/1000)}s diag: ${s.diag}  wmRec=${s.wm} shdw=${s.shadowVols}`); }
    det = Array.isArray(s.det) ? s.det : det;
    const rounds = Array.isArray(det) ? det.length : 0;
    const elapsed = Date.now() - started;
    // Need >=2 det rounds AND >=35s elapsed (the spawn loadout gives the gun ~3s in,
    // and several det rounds run by ~15s). For the ON run also wait for the gun to
    // actually appear (wmMax>0); for OFF the count stays 0 by design, so time-gate it.
    const gunReady = (label.includes("ON")) ? (wmMax > 0) : (elapsed > 40000);
    if (rounds >= 3 && gunReady) break;
    await page.waitForTimeout(2000);
  }
  const fin = await page.evaluate(() => ({ det: window.__d3WgpuDet || null, wm: window.__d3WeaponDepthRecords ?? null })).catch(() => ({}));
  det = Array.isArray(fin.det) ? fin.det : det;
  if (typeof fin.wm === "number" && fin.wm > wmMax) wmMax = fin.wm;
  await browser.close();

  const rounds = Array.isArray(det) ? det.length : 0;
  const ident = rounds > 0 && det.every((r) => r.diffPx === 0);
  console.log(`[${label}] det rounds=${rounds} IDENTICAL=${ident}  weaponDepthRecords(max)=${wmMax}`);
  if (rounds > 0) console.log(`[${label}] det: ${JSON.stringify(det.map((r) => ({ round: r.round, diffPx: r.diffPx, surf: r.surfaces })))}`);
  if (logs.length) console.log(`[${label}] log tail:\n  ${logs.slice(-10).join("\n  ")}`);
  return { ident, wmMax, rounds };
}

const on = await run("ON  (r_weaponDepthSep 1)", "+set r_weaponDepthSep 1");
const off = await run("OFF (r_weaponDepthSep 0)", "+set r_weaponDepthSep 0");

console.log("\n================ R-VIEWMODEL GATE ================");
console.log(`(1) determinism ON : ${on.ident ? "IDENTICAL ✓" : "DIFF ✗"} (${on.rounds} rounds)`);
console.log(`(2) feature fires  : weaponDepthRecords=${on.wmMax} ${on.wmMax > 0 ? "✓ (gun records get [0,0.5])" : "✗ (NO weapon records!)"}`);
console.log(`(3) A/B OFF        : weaponDepthRecords=${off.wmMax} ${off.wmMax === 0 ? "✓ (feature off, OFF-identity)" : "✗"} ; det ${off.ident ? "IDENTICAL ✓" : "DIFF ✗"}`);
const pass = on.ident && on.wmMax > 0 && off.wmMax === 0 && off.ident;
console.log(`\nGATE: ${pass ? "PASS ✓" : "FAIL ✗"}`);
process.exit(pass ? 0 : 1);
