import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "fs";
const b = await chromium.launch({ headless: false, args: ["--enable-unsafe-webgpu"] });
const p = await (await b.newContext({ viewport: { width: 800, height: 600 } })).newPage();
const log = [];
p.on("console", m => { const t = m.text(); if (/wrote binary|stencil shadows|Saved/i.test(t)) log.push(t); });
await p.goto("http://localhost:5173/?backend=webgpu&nodiag&cb=bake" + Date.now(), { waitUntil: "domcontentloaded" });
// wait until all 3 .b* exist + stencil shadows (map fully loaded)
const want = ["/save/base/maps/game/enpro.bcm", "/save/base/maps/game/enpro.bmap", "/save/base/maps/game/enpro.bproc"];
const dl = Date.now() + 90000;
let sizes = null;
while (Date.now() < dl) {
  sizes = await p.evaluate((paths) => {
    const FS = window.Module && window.Module.FS; if (!FS) return null;
    const out = {};
    for (const f of paths) { try { out[f] = FS.stat(f).size; } catch { out[f] = -1; } }
    return out;
  }, want);
  if (sizes && want.every(f => sizes[f] > 0)) { await p.waitForTimeout(1500); break; }  // settle
  await p.waitForTimeout(800);
}
console.log("sizes:", JSON.stringify(sizes));
mkdirSync("/tmp/baked-geo/maps/game", { recursive: true });
for (const f of want) {
  const b64 = await p.evaluate((path) => {
    const FS = window.Module.FS; const u8 = FS.readFile(path);
    let s = ""; const C = 0x8000; for (let i = 0; i < u8.length; i += C) s += String.fromCharCode.apply(null, u8.subarray(i, i + C));
    return btoa(s);
  }, f);
  const name = f.split("/").pop();
  const bytes = Buffer.from(b64, "base64");
  writeFileSync("/tmp/baked-geo/maps/game/" + name, bytes);
  console.log("  wrote /tmp/baked-geo/maps/game/" + name + " (" + bytes.length + " bytes)");
}
await b.close();
