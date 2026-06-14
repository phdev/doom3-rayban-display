// Phase 0 (area-streaming) validation driver.
//
// Boots the built app in headless Chrome (CDP), waits for enpro to load, runs
// the engine's `dumpAreaSplit` console command, then pulls /save/areadump/*
// out of MEMFS to disk and runs scripts/pack-area-stream.py for the GO/NO-GO.
//
// Usage: npm run build && node scripts/dump-area-split.mjs
//   env: CHROME_BIN, SMOKE_APP_PORT, SMOKE_CDP_PORT, DUMP_OUT (default ./areadump-out)

import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = process.cwd();
const APP_PORT = Number(process.env.SMOKE_APP_PORT || 4178);
const CDP_PORT = Number(process.env.SMOKE_CDP_PORT || 9337);
const APP_URL = process.env.SMOKE_URL || `http://127.0.0.1:${APP_PORT}/`;
const CHROME_BIN =
  process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BOOT_TIMEOUT_MS = Number(process.env.SMOKE_BOOT_TIMEOUT_MS || 180000);
const OUT_DIR = process.env.DUMP_OUT || join(ROOT, "areadump-out");

const processes = [];
let userDataDir = null;
let client = null;

try {
  if (!existsSync(CHROME_BIN)) {
    throw new Error(`Chrome not found at ${CHROME_BIN}. Set CHROME_BIN.`);
  }
  await startPreviewServer();
  userDataDir = await mkdtemp(join(tmpdir(), "doom3-dump-chrome-"));
  await startChrome(userDataDir);

  const target = await openTarget(APP_URL);
  client = await connectCdp(target.webSocketDebuggerUrl);
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  await client.send("Log.enable");

  await waitFor(() => evaluate(client, "Boolean(document.querySelector('#gameCanvas'))"), "app canvas");
  console.log(`Loaded ${APP_URL}`);

  // DUMP_BOOT_AREAS sets the boot region kept resident in the boot .bcm (must
  // match split-bproc-areas.py). space-separated — idCmdArgs tokenizes on commas.
  const bootAreas = (process.env.DUMP_BOOT_AREAS || "0,1,2,3,4,5,6,7,8,9").replace(/,/g, " ");

  // Robust against the flaky headless boot (__d3ViewPos can lag minutes under
  // swiftshader): retry dumpAreaSplit until it produces the json fragments. The
  // map loads (gameRenderWorld ready) before the first render, and the command
  // no-ops harmlessly until then.
  console.log("Waiting for map + running dumpAreaSplit (retry until output)...");
  const hasFragments = `(() => { try {
    const FS = window.Module.FS;
    const walk = (d) => { let r = []; let es; try { es = FS.readdir(d); } catch { return r; }
      for (const e of es) { if (e === "." || e === "..") continue; const f = (d === "/" ? "" : d) + "/" + e;
        let st; try { st = FS.stat(f); } catch { continue; }
        if (FS.isDir(st.mode)) r = r.concat(walk(f)); else r.push(e); } return r; };
    const ns = new Set(walk("/save"));
    return ns.has("render.json") && ns.has("collision.json") && ns.has("entities.json");
  } catch { return false; } })()`;
  let dumped = false;
  const dumpStart = Date.now();
  while (Date.now() - dumpStart < BOOT_TIMEOUT_MS) {
    const log = await evaluate(client, "Array.isArray(window.__d3Logs) ? window.__d3Logs.join('\\n') : ''");
    if (/recursive shutdown|Error during initialization|ERROR: Couldn't load default/i.test(log)) {
      throw new Error("Boot failed:\n" + log.split("\n").slice(-25).join("\n"));
    }
    await evaluate(client, `(() => { try { window.Module.ccall("D3_ExecCommand", null, ["string"], ["dumpAreaSplit ${bootAreas}"]); return 1; } catch (e) { return 0; } })()`);
    await delay(4000);
    if (await evaluate(client, hasFragments)) { dumped = true; break; }
  }
  if (!dumped) throw new Error("dumpAreaSplit never produced json fragments within timeout");
  console.log("enpro loaded. dumpAreaSplit produced output.");

  // Walk /save (the engine nests writes under fs_savepath) and return every
  // dump file with its full path + size. Matches *.bproc.part, *.entities,
  // and the *.json metric fragments.
  const walkExpr = `(() => {
    const FS = window.Module.FS;
    const out = [];
    const isDump = (n) => /\\.(bproc\\.part|bcm\\.part|entities)$/.test(n) || n === "enpro.boot.bcm" ||
      ["render.json","collision.json","entities.json","targets.json","adjacency.json"].includes(n);
    const walk = (dir, depth) => {
      if (depth > 8) return;
      let es; try { es = FS.readdir(dir); } catch { return; }
      for (const e of es) {
        if (e === "." || e === "..") continue;
        const full = (dir === "/" ? "" : dir) + "/" + e;
        let st; try { st = FS.stat(full); } catch { continue; }
        if (FS.isDir(st.mode)) walk(full, depth + 1);
        else if (isDump(e)) out.push({ path: full, name: e, size: st.size });
      }
    };
    walk("/save", 0);
    return out;
  })()`;

  // wait for the dump to land — poll for the json fragments anywhere under /save
  let listing = [];
  const ready = await waitFor(async () => {
    listing = await evaluate(client, walkExpr);
    const names = new Set(listing.map((f) => f.name));
    return names.has("entities.json") && names.has("collision.json") && names.has("render.json");
  }, "areadump json fragments", 30000).then(() => true).catch(() => false);

  if (!ready) {
    const log = await evaluate(client, "Array.isArray(window.__d3Logs) ? window.__d3Logs.slice(-40).join('\\n') : ''");
    const tree = await evaluate(client, `(() => {
      const FS = window.Module.FS; const out = [];
      const walk = (d, dep) => { if (dep>6) return; let es; try { es = FS.readdir(d); } catch { return; }
        for (const e of es) { if (e==="."||e==="..") continue; const f=(d==="/"?"":d)+"/"+e;
          let st; try{st=FS.stat(f);}catch{continue;} out.push((FS.isDir(st.mode)?"d ":"f ")+f);
          if (FS.isDir(st.mode)) walk(f, dep+1); } };
      walk("/save", 0); return out.slice(0, 80).join("\\n");
    })()`);
    throw new Error("dumpAreaSplit produced no json fragments.\n--- /save tree ---\n" + tree + "\n--- log tail ---\n" + log);
  }

  console.log(`Dump produced ${listing.length} files, total ${(listing.reduce((a, f) => a + f.size, 0) / 1e6).toFixed(2)} MB`);

  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  // pull each file (base64) to disk, keyed by basename (parts are flat)
  for (const f of listing) {
    const b64 = await evaluate(client, `(() => {
      const FS = window.Module.FS;
      const bytes = FS.readFile(${JSON.stringify(f.path)});
      let bin = "";
      const CH = 0x8000;
      for (let i = 0; i < bytes.length; i += CH) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
      }
      return btoa(bin);
    })()`);
    await writeFile(join(OUT_DIR, f.name), Buffer.from(b64, "base64"));
  }
  console.log(`Pulled dump to ${OUT_DIR}`);

  // print the key metric fragments
  for (const name of ["render.json", "collision.json", "entities.json", "targets.json"]) {
    const f = listing.find((x) => x.name === name);
    if (!f) continue;
    const txt = await evaluate(client, `window.Module.FS.readFile(${JSON.stringify(f.path)}, { encoding: "utf8" })`);
    console.log(`\n----- ${name} (head) -----`);
    console.log(String(txt).split("\n").slice(0, 14).join("\n"));
  }

  // run the packer
  console.log("\n=== running pack-area-stream.py ===");
  await runPacker(OUT_DIR);

  console.log("\nPhase 0 dump validation complete.");
} finally {
  client?.close();
  await cleanup();
}
process.exit(0);

function runPacker(indir) {
  return new Promise((resolve, reject) => {
    const p = spawn("python3", [
      join(ROOT, "scripts", "pack-area-stream.py"),
      "--input", indir,
      "--output-dir", join(ROOT, "public", "wasm", "base-stream"),
      "--name", "enpro",
    ], { cwd: ROOT, stdio: "inherit" });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("packer exit " + code))));
  });
}

async function waitForMapLoaded(client) {
  const startedAt = Date.now();
  let latest = "";
  while (Date.now() - startedAt < BOOT_TIMEOUT_MS) {
    latest = await evaluate(client, "Array.isArray(window.__d3Logs) ? window.__d3Logs.join('\\n') : ''");
    if (/\[boot\] Error:|Missing engine artifact|recursive shutdown|Error during initialization/i.test(latest)) {
      throw new Error("Boot failed:\n" + tail(latest));
    }
    // The view-pos chip (window.__d3ViewPos) is published from RB_BeginDrawingView
    // only once the world is actively rendering — i.e. the map is fully loaded.
    const rendering = await evaluate(client, "typeof window.__d3ViewPos === 'string'");
    if (rendering) {
      await delay(2000); // settle a couple frames so InitFromNewMap is fully done
      return;
    }
    await delay(500);
  }
  throw new Error("Map load timed out (no __d3ViewPos):\n" + tail(latest));
}

// ---- CDP plumbing (trimmed from smoke-local-browser.mjs) ----
async function startPreviewServer() {
  const viteBin = join(ROOT, "node_modules", ".bin", "vite");
  const server = spawn(viteBin, ["preview", "--host", "127.0.0.1", "--port", String(APP_PORT), "--strictPort"],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  processes.push(server);
  pipeOutput(server, "vite");
  await waitForHttp(APP_URL, "Vite preview server");
}

async function startChrome(profileDir) {
  const chrome = spawn(CHROME_BIN, [
    "--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profileDir}`,
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    "--disable-component-update", "--enable-webgl", "--ignore-gpu-blocklist",
    "--enable-unsafe-swiftshader", "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  processes.push(chrome);
  pipeOutput(chrome, "chrome");
  await waitForHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, "Chrome DevTools");
}

async function openTarget(url) {
  const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  if (!response.ok) throw new Error(`Unable to open Chrome target: ${response.status}`);
  return response.json();
}

async function connectCdp(webSocketDebuggerUrl) {
  const ws = new WebSocket(webSocketDebuggerUrl);
  const callbacks = new Map();
  let nextId = 1;
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const cb = callbacks.get(message.id);
    if (!cb) return;
    callbacks.delete(message.id);
    if (message.error) cb.reject(new Error(`${message.error.message}: ${message.error.data || ""}`.trim()));
    else cb.resolve(message.result);
  });
  return {
    send(method, params = {}) {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => callbacks.set(id, { resolve, reject }));
    },
    close() { ws.close(); },
  };
}

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "eval failed");
  return result.result?.value;
}

async function waitForHttp(url, label, timeoutMs = 30000) {
  await waitFor(async () => {
    try { return (await fetch(url, { method: "GET" })).ok; } catch { return false; }
  }, label, timeoutMs);
}

async function waitFor(check, label, timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try { if (await check()) return; } catch {}
    await delay(250);
  }
  throw new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`);
}

function pipeOutput(child, label) {
  child.stdout?.on("data", (c) => { const t = c.toString().trim(); if (t) console.log(`[${label}] ${t}`); });
  child.stderr?.on("data", (c) => { const t = c.toString().trim(); if (t && !/DevTools listening|Trying to load the allocator|swiftshader|Fontconfig|GPU stall/i.test(t)) console.error(`[${label}] ${t}`); });
}

function tail(text, lines = 40) { return String(text).trim().split("\n").slice(-lines).join("\n"); }

async function cleanup() {
  for (const child of processes.reverse()) await stopProcess(child);
  if (userDataDir) { try { await rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} }
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = once(child, "exit");
  const forced = delay(3000).then(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  await Promise.race([exited, forced]);
}
