// R0 P3 — Mac Safari (WebKit→Metal) verification via safaridriver WebDriver.
// WebKit is the iPhone proxy and the project's recurring failure mode is
// WebKit≠Dawn (iter-47b/71/125). The in-engine LUT self-test is capture-
// independent, so reading window.__d3TonemapLut HERE proves the ACES operator
// on the Metal stack; __d3WgpuDet proves determinism on WebKit.
//
// Prereq: safaridriver -p 4445 already running (remote automation enabled).
// Usage: node scripts/safari-verify.mjs [url]
const DRV = process.env.SAF_DRV || "http://localhost:4445";
const URL = process.argv[2] || "http://localhost:4180/?backend=webgpu&args=%2Bset%20r_tonemap%201%20%2Bset%20r_tonemapExposure%200.6";
const TIMEOUT = Number(process.env.SAF_TIMEOUT_MS || 150000);

async function wd(method, path, body) {
  const r = await fetch(DRV + path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (j.value && j.value.error) throw new Error(`${path}: ${j.value.error} ${j.value.message||""}`);
  return j.value;
}

let sid;
try {
  const cap = await wd("POST", "/session", { capabilities: { alwaysMatch: { browserName: "safari" } } });
  sid = cap.sessionId;
  console.log(`[safari] session ${sid} (Safari ${cap.browserVersion})`);
  await wd("POST", `/session/${sid}/url`, { url: URL });
  console.log(`[safari] navigated: ${URL}`);
  // Safari throttles rendering when its window is not foreground/focused
  // (iter-35/36) → the engine never advances frames → the det/LUT self-tests
  // never fire. Force Safari frontmost during the run.
  const { exec } = await import("node:child_process");
  const focus = () => exec(`osascript -e 'tell application "Safari" to activate'`);
  focus();

  const probe = `return JSON.stringify({gpu: !!navigator.gpu, lut: window.__d3TonemapLut, lutErr: window.__d3TonemapLutMaxErr, tmDet: window.__d3TonemapDet, det: window.__d3WgpuDet, diag: (document.querySelector('#diag')?(document.querySelector('#diag').textContent||'').split(String.fromCharCode(10))[0].slice(0,150):'')});`;
  const deadline = Date.now() + TIMEOUT;
  let st = {};
  let lastDiag = "";
  while (Date.now() < deadline) {
    try {
      const raw = await wd("POST", `/session/${sid}/execute/sync`, { script: probe, args: [] });
      st = JSON.parse(raw);
      if (st.diag && st.diag !== lastDiag) { lastDiag = st.diag; console.log(`[safari] diag: ${st.diag}`); }
      // done when the LUT self-test populated AND >=2 det rounds (or lut + some det)
      const detN = Array.isArray(st.det) ? st.det.length : 0;
      if (st.lut !== undefined && st.lut !== null && detN >= 1) break;
    } catch (e) { /* page mid-load */ }
    focus();   // keep Safari foreground so it keeps rendering
    await new Promise((r) => setTimeout(r, 2500));
  }

  console.log("\n=== Safari (WebKit WebGPU) results ===");
  console.log("navigator.gpu :", st.gpu);
  console.log("LUT operator  :", st.lut, "(maxErr=" + st.lutErr + ")");
  console.log("tonemap-in-det:", JSON.stringify(st.tmDet));
  console.log("det rounds    :", JSON.stringify(st.det));

  // screenshot
  const shot = await wd("GET", `/session/${sid}/screenshot`);
  if (shot) { const { writeFileSync } = await import("node:fs"); writeFileSync("/tmp/safari-tonemap.png", Buffer.from(shot, "base64")); console.log("[safari] screenshot -> /tmp/safari-tonemap.png"); }

  // verdicts
  const detArr = Array.isArray(st.det) ? st.det : [];
  const detOk = detArr.length > 0 && detArr.every((r) => r.diffPx === 0 && r.maxDelta === 0);
  const lutOk = st.lut === true && (st.lutErr === 0 || st.lutErr <= 2);
  console.log(`\nWEBKIT VERDICT: operator ${lutOk ? "PASS ✓" : "FAIL ✗"} | determinism ${detOk ? "IDENTICAL ✓" : "NOT IDENTICAL ✗"}`);
  process.exitCode = (lutOk && detOk) ? 0 : 1;
} catch (e) {
  console.log("[safari] ERROR:", e.message);
  process.exitCode = 2;
} finally {
  if (sid) await wd("DELETE", `/session/${sid}`).catch(() => {});
}
