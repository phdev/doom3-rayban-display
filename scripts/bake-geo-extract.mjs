import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "fs";
const b = await chromium.launch({ headless: false, args: ["--enable-unsafe-webgpu"] });
const p = await (await b.newContext({ viewport: { width: 800, height: 600 } })).newPage();
const log = [];
p.on("console", m => { const t = m.text(); if (/wrote binary|stencil shadows|Saved/i.test(t)) log.push(t); });
await p.goto("http://localhost:5173/?backend=webgpu&nodiag&cb=bake" + Date.now(), { waitUntil: "domcontentloaded" });
// wait until the binaries the engine writes for this pak exist. The engine
// only WRITES a binary when it loaded the ASCII source — so against an
// already-geometry-baked pak only .baas48 appears (the ASCII .aas48 is still
// present). The AAS loads LAST (game InitFromNewMap, after collision/render),
// so wait on it as the settle signal, then extract whatever was written (>0).
const want = ["/save/base/maps/game/enpro.bcm", "/save/base/maps/game/enpro.bmap",
              "/save/base/maps/game/enpro.bproc", "/save/base/maps/game/enpro.baas48"];
const settleOn = "/save/base/maps/game/enpro.baas48";  // last binary written
const dl = Date.now() + 90000;
let sizes = null;
while (Date.now() < dl) {
  sizes = await p.evaluate((paths) => {
    const FS = window.Module && window.Module.FS; if (!FS) return null;
    const out = {};
    for (const f of paths) { try { out[f] = FS.stat(f).size; } catch { out[f] = -1; } }
    return out;
  }, want);
  if (sizes && sizes[settleOn] > 0) { await p.waitForTimeout(1500); break; }  // settle
  await p.waitForTimeout(800);
}
console.log("sizes:", JSON.stringify(sizes));
mkdirSync("/tmp/baked-geo/maps/game", { recursive: true });
for (const f of want) {
  if (!(sizes && sizes[f] > 0)) { console.log("  skip (not written): " + f); continue; }
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
