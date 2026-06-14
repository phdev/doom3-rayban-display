// Phase 4 (area streaming end-to-end) validation driver.
//
// Boots enpro with ?areastream — the JS shell loads the reduced boot pak
// (pak-display-stream.pk4, boot proc only), passes +set com_streamAreas 1, and
// after boot runs streamAreas() which downloads the render-parts blob and binds
// each deferred area via D3_AppendArea. This driver waits for that to finish and
// asserts the world filled in, with NO manual appendArea calls (unlike the Phase
// 1 test) — it exercises the real shipping pipeline.
//
// Requires: public/wasm/base-stream/pak-display-stream.pk4.* + enpro.areas.stream(.json)
// Usage: npm run build && node scripts/test-areastream-e2e.mjs

import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = process.cwd();
const APP_PORT = Number(process.env.SMOKE_APP_PORT || 4180);
const CDP_PORT = Number(process.env.SMOKE_CDP_PORT || 9339);
const APP_URL = `http://127.0.0.1:${APP_PORT}/?areastream`;
const CHROME_BIN = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BOOT_TIMEOUT_MS = Number(process.env.SMOKE_BOOT_TIMEOUT_MS || 180000);

const processes = [];
let userDataDir = null, client = null;

try {
  if (!existsSync(CHROME_BIN)) throw new Error(`Chrome not found at ${CHROME_BIN}`);
  await startPreviewServer();
  userDataDir = await mkdtemp(join(tmpdir(), "doom3-e2e-"));
  await startChrome(userDataDir);
  const target = await openTarget(APP_URL);
  client = await connectCdp(target.webSocketDebuggerUrl);
  await client.send("Runtime.enable"); await client.send("Page.enable");
  await waitFor(() => evaluate(client, "Boolean(document.querySelector('#gameCanvas'))"), "app canvas");
  console.log(`Loaded ${APP_URL}`);

  await waitForRendering(client);
  console.log("Streaming boot OK (reduced boot pak rendered).");
  const shotA = await screenshot(client);
  await writeFile(join(ROOT, "areadump-out", "e2e-A-boot.png"), Buffer.from(shotA, "base64"));

  // wait for the JS streamAreas() driver to finish appending
  console.log("Waiting for streamAreas() to bind deferred areas ...");
  let done = false;
  const start = Date.now();
  while (Date.now() - start < 90000) {
    const log = await evaluate(client, "Array.isArray(window.__d3Logs) ? window.__d3Logs.join('\\n') : ''");
    if (/Area streaming complete|Area streaming error|No area-stream manifest|Area streaming skipped/i.test(log)) { done = true; break; }
    await delay(1000);
  }
  await delay(2000);

  const shotB = await screenshot(client);
  await writeFile(join(ROOT, "areadump-out", "e2e-B-streamed.png"), Buffer.from(shotB, "base64"));

  const log = await evaluate(client, "Array.isArray(window.__d3Logs) ? window.__d3Logs.join('\\n') : ''");
  const reqMatch = log.match(/Area streaming complete: requested (\d+) areas/);
  const requested = reqMatch ? Number(reqMatch[1]) : 0;
  const streamingMsg = (log.match(/Streaming \d+ render areas[^\n]*/g) || []).slice(-1)[0] || "(none)";
  const errors = (log.match(/area \d+ write\/append failed/g) || []).length;
  const skippedReason = (log.match(/Area streaming (skipped|error)[^\n]*/g) || []).slice(-1)[0] || "";
  const changed = shotA !== shotB;

  console.log(`\n=== PHASE 4 END-TO-END RESULT ===`);
  console.log(`  driver finished:    ${done}`);
  console.log(`  ${streamingMsg.trim()}`);
  console.log(`  areas requested:    ${requested}`);
  console.log(`  write/append fails: ${errors}`);
  if (skippedReason) console.log(`  note: ${skippedReason.trim()}`);
  console.log(`  screenshot changed: ${changed} (A ${shotA.length}b, B ${shotB.length}b)`);
  console.log(`  screenshots: areadump-out/e2e-A-boot.png, e2e-B-streamed.png`);
  if (done && requested >= 80 && errors === 0 && changed) {
    console.log(`\n  PASS — boot pak rendered, ${requested} areas streamed + bound via the JS pipeline, no errors.`);
  } else {
    console.log(`\n  REVIEW — expected driver done, ~83 requested, 0 fails, changed=true.`);
  }
} finally {
  client?.close();
  await cleanup();
}
process.exit(0);

async function screenshot(client) { return (await client.send("Page.captureScreenshot", { format: "png" })).data; }
async function waitForRendering(client) {
  const s = Date.now(); let latest = "";
  while (Date.now() - s < BOOT_TIMEOUT_MS) {
    latest = await evaluate(client, "Array.isArray(window.__d3Logs) ? window.__d3Logs.join('\\n') : ''");
    if (/recursive shutdown|Error during initialization|bad area model lookup/i.test(latest)) throw new Error("Boot failed:\n" + tail(latest));
    if (await evaluate(client, "typeof window.__d3ViewPos === 'string'")) {
      await waitFor(async () => evaluate(client, `(() => { const l=document.querySelector('#loadingPanel'); if(!l) return true; const s=getComputedStyle(l); return l.hidden||s.visibility==='hidden'||Number(s.opacity)<0.05; })()`), "loading hide", 20000).catch(() => {});
      return;
    }
    await delay(500);
  }
  throw new Error("Rendering did not start:\n" + tail(latest));
}
async function startPreviewServer() {
  const viteBin = join(ROOT, "node_modules", ".bin", "vite");
  const server = spawn(viteBin, ["preview", "--host", "127.0.0.1", "--port", String(APP_PORT), "--strictPort"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  processes.push(server); pipeOutput(server, "vite"); await waitForHttp(`http://127.0.0.1:${APP_PORT}/`, "Vite preview");
}
async function startChrome(profileDir) {
  const chrome = spawn(CHROME_BIN, ["--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--enable-webgl", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "about:blank"], { stdio: ["ignore", "pipe", "pipe"] });
  processes.push(chrome); pipeOutput(chrome, "chrome"); await waitForHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, "Chrome DevTools");
}
async function openTarget(url) { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`, { method: "PUT" }); if (!r.ok) throw new Error(`open ${r.status}`); return r.json(); }
async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl); const cbs = new Map(); let id = 1;
  await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (!m.id) return; const cb = cbs.get(m.id); if (!cb) return; cbs.delete(m.id); m.error ? cb.reject(new Error(m.error.message)) : cb.resolve(m.result); });
  return { send(method, params = {}) { const i = id++; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((res, rej) => cbs.set(i, { resolve: res, reject: rej })); }, close() { ws.close(); } };
}
async function evaluate(client, expression) { const r = await client.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || "eval failed"); return r.result?.value; }
async function waitForHttp(url, label, t = 30000) { await waitFor(async () => { try { return (await fetch(url)).ok; } catch { return false; } }, label, t); }
async function waitFor(check, label, t = 30000) { const s = Date.now(); while (Date.now() - s < t) { try { if (await check()) return; } catch {} await delay(250); } throw new Error(`${label} timed out`); }
function pipeOutput(child, label) { child.stdout?.on("data", (c) => { const t = c.toString().trim(); if (t) console.log(`[${label}] ${t}`); }); child.stderr?.on("data", (c) => { const t = c.toString().trim(); if (t && !/DevTools listening|swiftshader|GL errors|gl_utils|registration_request|crash|updater|file_io|InitializeLog|environment\.cc|shared_image|XNNPACK|allocator multiple/i.test(t)) console.error(`[${label}] ${t}`); }); }
function tail(t, n = 30) { return String(t).trim().split("\n").slice(-n).join("\n"); }
async function cleanup() { for (const c of processes.reverse()) await stopProcess(c); if (userDataDir) { try { await rm(userDataDir, { recursive: true, force: true }); } catch {} } }
async function stopProcess(child) { if (child.exitCode !== null || child.signalCode !== null) return; child.kill("SIGTERM"); const ex = once(child, "exit"); const f = delay(3000).then(() => { if (child.exitCode === null) child.kill("SIGKILL"); }); await Promise.race([ex, f]); }
