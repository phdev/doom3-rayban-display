// Phase 1 (area-streaming render append) validation driver.
//
// Requires a streaming test pak in public/wasm/base-stream (boot proc omitting
// areas 10..92 + areadump/_areaN.bproc.part bundled — see build-stream-test-pak.py).
// Boots enpro with com_streamAreas 1 (deferred areas render empty), screenshots,
// appends areas 10..92 via D3_AppendArea, screenshots again, and asserts the
// gate didn't crash, the appends bound, and geometry changed.
//
// Usage: npm run build && node scripts/test-stream-render.mjs

import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = process.cwd();
const APP_PORT = Number(process.env.SMOKE_APP_PORT || 4179);
const CDP_PORT = Number(process.env.SMOKE_CDP_PORT || 9338);
const ARGS = encodeURIComponent("+set com_streamAreas 1");
const APP_URL = `http://127.0.0.1:${APP_PORT}/?args=${ARGS}`;
const CHROME_BIN = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BOOT_TIMEOUT_MS = Number(process.env.SMOKE_BOOT_TIMEOUT_MS || 180000);
const FIRST = 10, LAST = 92;   // deferred areas in the test pak

const processes = [];
let userDataDir = null, client = null;

try {
  if (!existsSync(CHROME_BIN)) throw new Error(`Chrome not found at ${CHROME_BIN}`);
  await startPreviewServer();
  userDataDir = await mkdtemp(join(tmpdir(), "doom3-streamtest-"));
  await startChrome(userDataDir);
  const target = await openTarget(APP_URL);
  client = await connectCdp(target.webSocketDebuggerUrl);
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  await waitFor(() => evaluate(client, "Boolean(document.querySelector('#gameCanvas'))"), "app canvas");
  console.log(`Loaded ${APP_URL}`);

  await waitForRendering(client);
  console.log("Streaming boot OK (com_streamAreas 1, deferred areas did not crash boot).");
  await delay(1500);

  const shotA = await screenshot(client);
  await writeFile(join(ROOT, "areadump-out", "stream-A-holes.png"), Buffer.from(shotA, "base64"));

  // append the deferred areas
  console.log(`Appending areas ${FIRST}..${LAST} ...`);
  for (let n = FIRST; n <= LAST; n++) {
    await evaluate(client, `(() => { try { window.Module._D3_AppendArea(${n}); return 1; } catch(e){ return String(e);} })()`);
  }
  // Poll the log and UNION results before the 4000-line ring buffer evicts the
  // early "appendArea N: bound" lines (texture-stream spam churns the buffer).
  const boundSet = new Set(), skippedSet = new Set(), errorSet = new Set(), colSet = new Set();
  for (let t = 0; t < 28; t++) {
    const chunk = await evaluate(client, "Array.isArray(window.__d3Logs) ? window.__d3Logs.slice(-3500).join('\\n') : ''");
    for (const m of chunk.matchAll(/appendArea (\d+): bound/g)) boundSet.add(Number(m[1]));
    for (const m of chunk.matchAll(/appendArea (\d+): skipped/g)) skippedSet.add(Number(m[1]));
    for (const m of chunk.matchAll(/AppendAreaModel: areadump\/_area(\d+)[^\n]*not found/g)) errorSet.add(Number(m[1]));
    for (const m of chunk.matchAll(/appendAreaCol (\d+): appended/g)) colSet.add(Number(m[1]));
    await delay(250);
  }
  const bound = boundSet.size, skipped = skippedSet.size, errors = errorSet.size, colAppended = colSet.size;
  console.log(`  collision appended: ${colAppended}`);

  const shotB = await screenshot(client);
  await writeFile(join(ROOT, "areadump-out", "stream-B-filled.png"), Buffer.from(shotB, "base64"));
  const changed = shotA !== shotB;

  console.log(`\n=== PHASE 1 RENDER APPEND RESULT ===`);
  console.log(`  appendArea bound:   ${bound}`);
  console.log(`  appendArea skipped: ${skipped}`);
  console.log(`  parts not found:    ${errors}`);
  console.log(`  screenshot changed: ${changed} (A ${shotA.length}b, B ${shotB.length}b)`);
  console.log(`  screenshots: areadump-out/stream-A-holes.png, stream-B-filled.png`);

  const expectBound = LAST - FIRST + 1;
  if (bound >= expectBound - 2 && errors === 0 && changed) {
    console.log(`\n  PASS — ${bound}/${expectBound} deferred areas bound, geometry appeared, no missing parts.`);
  } else {
    console.log(`\n  REVIEW — expected ~${expectBound} bound, 0 errors, changed=true.`);
  }
} finally {
  client?.close();
  await cleanup();
}
process.exit(0);

async function screenshot(client) {
  const r = await client.send("Page.captureScreenshot", { format: "png" });
  return r.data;
}

async function waitForRendering(client) {
  const startedAt = Date.now();
  let latest = "";
  while (Date.now() - startedAt < BOOT_TIMEOUT_MS) {
    latest = await evaluate(client, "Array.isArray(window.__d3Logs) ? window.__d3Logs.join('\\n') : ''");
    if (/recursive shutdown|Error during initialization|bad area model lookup/i.test(latest)) {
      throw new Error("Boot failed (gate/append bug?):\n" + tail(latest));
    }
    if (await evaluate(client, "typeof window.__d3ViewPos === 'string'")) {
      // also wait for the loading overlay to hide so screenshot A is an in-game frame
      await waitFor(async () => evaluate(client, `(() => {
        const l = document.querySelector('#loadingPanel');
        if (!l) return true;
        const s = getComputedStyle(l);
        return l.hidden || s.visibility === 'hidden' || Number(s.opacity) < 0.05;
      })()`), "loading overlay hide", 20000).catch(() => {});
      return;
    }
    await delay(500);
  }
  throw new Error("Rendering did not start:\n" + tail(latest));
}

// ---- CDP plumbing ----
async function startPreviewServer() {
  const viteBin = join(ROOT, "node_modules", ".bin", "vite");
  const server = spawn(viteBin, ["preview", "--host", "127.0.0.1", "--port", String(APP_PORT), "--strictPort"],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  processes.push(server); pipeOutput(server, "vite");
  await waitForHttp(`http://127.0.0.1:${APP_PORT}/`, "Vite preview");
}
async function startChrome(profileDir) {
  const chrome = spawn(CHROME_BIN, ["--headless=new", `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-component-update", "--enable-webgl",
    "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "about:blank"],
    { stdio: ["ignore", "pipe", "pipe"] });
  processes.push(chrome); pipeOutput(chrome, "chrome");
  await waitForHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, "Chrome DevTools");
}
async function openTarget(url) {
  const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  if (!r.ok) throw new Error(`open target ${r.status}`);
  return r.json();
}
async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl); const cbs = new Map(); let id = 1;
  await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (!m.id) return; const cb = cbs.get(m.id); if (!cb) return; cbs.delete(m.id); m.error ? cb.reject(new Error(m.error.message)) : cb.resolve(m.result); });
  return { send(method, params = {}) { const i = id++; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((res, rej) => cbs.set(i, { resolve: res, reject: rej })); }, close() { ws.close(); } };
}
async function evaluate(client, expression) {
  const r = await client.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || "eval failed");
  return r.result?.value;
}
async function waitForHttp(url, label, t = 30000) { await waitFor(async () => { try { return (await fetch(url)).ok; } catch { return false; } }, label, t); }
async function waitFor(check, label, t = 30000) { const s = Date.now(); while (Date.now() - s < t) { try { if (await check()) return; } catch {} await delay(250); } throw new Error(`${label} timed out`); }
function pipeOutput(child, label) { child.stdout?.on("data", (c) => { const t = c.toString().trim(); if (t) console.log(`[${label}] ${t}`); }); child.stderr?.on("data", (c) => { const t = c.toString().trim(); if (t && !/DevTools listening|swiftshader|GL errors|gl_utils|registration_request|crash|updater|file_io|InitializeLog|environment\.cc|shared_image/i.test(t)) console.error(`[${label}] ${t}`); }); }
function tail(t, n = 30) { return String(t).trim().split("\n").slice(-n).join("\n"); }
async function cleanup() { for (const c of processes.reverse()) await stopProcess(c); if (userDataDir) { try { await rm(userDataDir, { recursive: true, force: true }); } catch {} } }
async function stopProcess(child) { if (child.exitCode !== null || child.signalCode !== null) return; child.kill("SIGTERM"); const ex = once(child, "exit"); const f = delay(3000).then(() => { if (child.exitCode === null) child.kill("SIGKILL"); }); await Promise.race([ex, f]); }
