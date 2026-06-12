import "./styles.css";
import "./webgl-record.js";
import { installTAA } from "./taa.js";
import { createHeadTracking } from "./headTracking.js";
import { createRuntimeConfig, bootDoom3 } from "./d3Runtime.js";
import { createWearableInput } from "./wearableInput.js";

const app = document.querySelector("#app");
const runtimeConfig = createRuntimeConfig();

let engine = null;
let booting = false;
let headTracking = null;
let wearableInput = null;
let autoFlashlightArmed = false;
let loadingProgress = 0;
let loadingHideTimer = 0;
let enemyIndicatorTimer = 0;
let autoFireSensitivityTimer = 0;
const enemyPresence = {
  left: false,
  right: false
};
const runtimeLogs = [];
const AUTO_FIRE_IMU_SENSITIVITY_SCALE = 0.5;
const AUTO_FIRE_SENSITIVITY_HOLD_MS = 250;

window.__d3Logs = runtimeLogs;

app.innerHTML = `
  <main class="game-shell" aria-label="DOOM 3 runtime">
    <canvas id="gameCanvas" class="game-canvas" tabindex="-1"></canvas>
    <canvas id="webgpuCanvas" class="webgpu-canvas" width="448" height="448" aria-hidden="true"></canvas>
    <div id="enemyLeftIndicator" class="enemy-indicator enemy-indicator-left" aria-hidden="true"></div>
    <div id="enemyRightIndicator" class="enemy-indicator enemy-indicator-right" aria-hidden="true"></div>
    <div id="flashlightIndicator" class="flashlight-indicator" role="button" tabindex="0">Flashlight</div>
    <section id="loadingPanel" class="loading-panel" role="status" aria-live="polite">
      <div id="loadingLabel" class="loading-label">Loading</div>
      <div
        id="loadingProgress"
        class="loading-track"
        role="progressbar"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow="0"
      >
        <div id="loadingBar" class="loading-bar"></div>
      </div>
    </section>
    <div id="moveControls" class="move-controls" aria-label="Movement controls" hidden>
      <button class="move-btn move-fwd" type="button" data-move="forward" aria-label="Move forward">▲</button>
      <button class="move-btn move-left" type="button" data-move="left" aria-label="Strafe left">◄</button>
      <button class="move-btn move-right" type="button" data-move="right" aria-label="Strafe right">►</button>
      <button class="move-btn move-back" type="button" data-move="back" aria-label="Move backward">▼</button>
    </div>
    <div id="yawMeter" class="yaw-meter" data-zone="deadzone" aria-hidden="true"></div>
    <span id="statusText" class="runtime-hidden" aria-hidden="true"></span>
    <span id="imuStatus" class="runtime-hidden" aria-hidden="true"></span>
    <pre id="diag" style="position:fixed;left:4px;top:4px;right:4px;margin:0;z-index:9999;font:11px/1.35 ui-monospace,Menlo,monospace;color:#7fff7f;background:rgba(0,0,0,.72);padding:5px 6px;white-space:pre-wrap;word-break:break-word;pointer-events:auto;max-height:60vh;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;touch-action:pan-y"></pre>
    <button id="diagToggle" type="button" aria-label="Toggle debug console" style="position:fixed;right:8px;top:8px;z-index:10000;min-width:44px;min-height:30px;padding:4px 10px;font:600 13px/1 ui-monospace,Menlo,monospace;color:#9effa0;background:rgba(0,0,0,.8);border:1px solid #2f6f30;border-radius:7px;-webkit-appearance:none;cursor:pointer">hide log</button>
    <button id="diagCopy" type="button" aria-label="Copy debug log to clipboard" style="position:fixed;right:100px;top:8px;z-index:10000;min-width:44px;min-height:30px;padding:4px 10px;font:600 13px/1 ui-monospace,Menlo,monospace;color:#9effa0;background:rgba(0,0,0,.8);border:1px solid #2f6f30;border-radius:7px;-webkit-appearance:none;cursor:pointer">copy log</button>
    <div id="glDiag" hidden style="position:fixed;left:8px;top:46px;z-index:10000;max-width:78vw;font:600 11px/1.45 ui-monospace,Menlo,monospace;color:#ffd24a;background:rgba(0,0,0,.85);border:1px solid #8a6a20;border-radius:7px;padding:5px 8px;white-space:pre-wrap;word-break:break-word;pointer-events:none"></div>
  </main>
`;

const refs = {
  canvas: document.querySelector("#gameCanvas"),
  enemyLeftIndicator: document.querySelector("#enemyLeftIndicator"),
  enemyRightIndicator: document.querySelector("#enemyRightIndicator"),
  flashlightIndicator: document.querySelector("#flashlightIndicator"),
  loadingPanel: document.querySelector("#loadingPanel"),
  loadingLabel: document.querySelector("#loadingLabel"),
  loadingProgress: document.querySelector("#loadingProgress"),
  loadingBar: document.querySelector("#loadingBar"),
  yawMeter: document.querySelector("#yawMeter"),
  statusText: document.querySelector("#statusText"),
  imuStatus: document.querySelector("#imuStatus"),
  moveControls: document.querySelector("#moveControls"),
  glDiag: document.querySelector("#glDiag"),
  webgpuCanvas: document.querySelector("#webgpuCanvas")
};

// Phase 5d: when ?backend=webgpu, reveal the side-by-side WebGPU canvas
// so the user can see what the WebGPU backend is rendering (currently a
// debug clear; will become real engine output as call sites migrate).
if (/[?&]backend=webgpu\b/.test(location.search) && refs.webgpuCanvas) {
  refs.webgpuCanvas.classList.add("is-active");
  // DEFAULT (cutover): with ?backend=webgpu, the WebGPU canvas IS the
  // fullscreen primary display and the GL canvas is hidden (opacity, not
  // display:none — SDL still owns its context/sizing). Add &echo for the
  // old side-by-side debug layout (small box top-right, GL fullscreen).
  // ?wgpufull is still accepted as a synonym of the default.
  if (!/[?&]echo\b/.test(location.search)) {
    refs.webgpuCanvas.classList.add("is-primary");
    document.getElementById("gameCanvas")?.classList.add("is-ghost");
  }
}

// Determinism comparison harness — captures N consecutive canvas frames and
// reports pixel-level deltas. The chunky-tile FP-determinism bug on iPhone
// Safari shows up as 1-7% of pixels differing frame-to-frame on a stationary
// scene with max delta up to 192/255. WebGPU should produce 0% / 0. Use this
// to A/B the two backends.
//
// Usage from Safari Web Inspector (Mac/iPhone):
//   await window.detTest("#webgpuCanvas", 5)
//   await window.detTest("#gameCanvas",   5)
//   await window.detTest("#gameCanvas",   5, 250)  // 250ms between captures
//
// `delayMs` controls how long we wait between captures. The default 200ms
// handles low-fps mobile (iPhone hits ~7 fps = 140ms/frame); on Chrome/desktop
// pass a smaller number. If too small, consecutive captures may both read
// the same engine frame and trivially diff to zero — that's NOT proof of
// determinism. To validate the harness, run detTest on something with
// expected motion (with camera input) — it should report >0% diff.
window.detTest = async function detTest(selector = "#webgpuCanvas", frameCount = 5, delayMs = 200) {
  const canvas = document.querySelector(selector);
  if (!canvas) { console.warn("detTest: no canvas", selector); return null; }
  const w = canvas.width, h = canvas.height;
  if (!w || !h) { console.warn("detTest: zero-size canvas", selector); return null; }
  const tmp = document.createElement("canvas");
  tmp.width = w; tmp.height = h;
  const ctx2d = tmp.getContext("2d", { willReadFrequently: true });
  const frames = [];
  for (let i = 0; i < frameCount; ++i) {
    if (i > 0) {
      // Wait a full engine frame to give the renderer time to redraw.
      await new Promise((r) => setTimeout(r, delayMs));
    }
    await new Promise((r) => requestAnimationFrame(r));
    try {
      ctx2d.clearRect(0, 0, w, h);
      ctx2d.drawImage(canvas, 0, 0, w, h);
      frames.push(ctx2d.getImageData(0, 0, w, h).data);
    } catch (e) {
      console.warn("detTest: drawImage failed (preserveDrawingBuffer?)", e.message);
      return null;
    }
  }
  const totalPx = w * h;
  let sumDiffPx = 0, maxDelta = 0;
  const perFrame = [];
  for (let i = 1; i < frames.length; ++i) {
    const a = frames[i - 1], b = frames[i];
    let diffPx = 0, frameMax = 0;
    for (let p = 0; p < a.length; p += 4) {
      const dr = Math.abs(a[p] - b[p]);
      const dg = Math.abs(a[p + 1] - b[p + 1]);
      const db = Math.abs(a[p + 2] - b[p + 2]);
      const d = Math.max(dr, dg, db);
      if (d > 0) diffPx++;
      if (d > frameMax) frameMax = d;
    }
    sumDiffPx += diffPx;
    if (frameMax > maxDelta) maxDelta = frameMax;
    perFrame.push({ pair: `${i - 1}->${i}`, diffPct: (diffPx / totalPx * 100).toFixed(3), maxDelta: frameMax });
  }
  const meanDiffPct = (sumDiffPx / (frames.length - 1) / totalPx * 100).toFixed(3);
  const summary = `detTest ${selector}: meanDiff=${meanDiffPct}% maxDelta=${maxDelta} (${w}x${h}, ${frames.length} frames)`;
  console.info(summary);
  for (const f of perFrame) console.info(`  ${f.pair}: ${f.diffPct}% pxs differ, maxDelta=${f.maxDelta}`);
  if (typeof appendRuntimeLog === "function") appendRuntimeLog(`[detTest] ${summary}`);
  return { selector, w, h, meanDiffPct: Number(meanDiffPct), maxDelta, perFrame };
};

// One-shot full determinism A/B: pauses the engine (so animated lights and
// sparks don't dominate the diff), waits for it to settle, runs detTest on
// both canvases at the same delay, prints a side-by-side summary. This is
// THE test for the chunky-tile bug: with the engine paused, ANY frame-to-
// frame diff is rendering-side non-determinism. On iPhone GL we expect
// ~1-7% (the bug). On WebGPU we expect 0%.
//
// Usage:
//   await window.fullDetTest()         // 5 frames, 250ms delay
//   await window.fullDetTest(10, 300)  // 10 frames, 300ms delay
window.fullDetTest = async function fullDetTest(frameCount = 5, delayMs = 250) {
  if (typeof window.d3cmd !== "function") {
    console.warn("fullDetTest: d3cmd not available; engine may not have booted");
    return null;
  }
  console.info("[fullDetTest] pausing engine for fair comparison...");
  window.d3cmd("g_stopTime 1");
  window.d3cmd("pause");
  // Wait for the engine to settle (a couple of frames of "engine still running
  // its last frame" then idle).
  await new Promise((r) => setTimeout(r, 1500));
  console.info("[fullDetTest] running detTest on #webgpuCanvas...");
  const wgpu = await window.detTest("#webgpuCanvas", frameCount, delayMs);
  console.info("[fullDetTest] running detTest on #gameCanvas...");
  const gl   = await window.detTest("#gameCanvas",   frameCount, delayMs);
  console.info("[fullDetTest] resuming engine...");
  window.d3cmd("g_stopTime 0");
  window.d3cmd("pause");
  const verdict =
    `\n┌─ WebGPU port determinism A/B (engine paused) ─\n` +
    `│ #webgpuCanvas: meanDiff=${wgpu?.meanDiffPct ?? "?"}% maxDelta=${wgpu?.maxDelta ?? "?"}\n` +
    `│ #gameCanvas:   meanDiff=${gl?.meanDiffPct   ?? "?"}% maxDelta=${gl?.maxDelta   ?? "?"}\n` +
    `└── If GL > 0.5% and WebGPU = 0%, WebGPU port fixes the chunky-tile bug.\n`;
  console.info(verdict);
  if (typeof appendRuntimeLog === "function") {
    appendRuntimeLog(`[fullDetTest] WebGPU=${wgpu?.meanDiffPct}% / GL=${gl?.meanDiffPct}%`);
  }
  return { wgpu, gl };
};

// Compact, always-visible GPU summary built from the captured GL4ES init lines.
// The decisive field is "highp FS": a mobile GPU without high-precision floats in
// fragment shaders underflows DOOM 3's lighting math to ~0 (near-black scene).
function updateGlDiag() {
  if (!refs.glDiag || !glInfo.length) return;
  const find = (re) => glInfo.find((l) => re.test(l)) || "";
  const has = (re) => glInfo.some((l) => re.test(l));
  const renderer = (find(/OpenGL renderer:/i).split(/renderer:/i)[1] || "?").trim();
  const highp = has(/high precision float in fragment shader available/i) ? "YES" : "NO";
  const floatRT = has(/color_buffer_float +detected/i) ? "yes" : "NO";
  const halfRT = has(/color_buffer_half_float +detected/i) ? "yes" : "NO";
  const colorAtt = (find(/Max Color Attachments/i).replace(/^LIBGL:\s*/i, "").trim() || "?");
  const arb2 = has(/ARB2 renderer: *Available/i) ? "yes" : "NO/missing";
  const errs = glInfo.filter((l) => /error|: END not found|program is invalid|not available/i.test(l)).length;
  // Lead with the ACTIVE render backend — the GL context still exists
  // (fallback + lightgem + texture uploads) but under WebGPU-primary it no
  // longer renders the scene, and "GPU: GL4ES" read as if it did.
  const wgpuPrimary = /[?&]backend=webgpu\b/.test(location.search) && !/[?&]echo\b/.test(location.search);
  const backendLine = wgpuPrimary
    ? "render: WebGPU (Dawn) — GL idle (fallback/lightgem only)\n"
    : "";
  refs.glDiag.textContent =
    backendLine +
    `GL ctx: ${renderer}\nhighp FS: ${highp}   floatRT: ${floatRT}   halfRT: ${halfRT}\n` +
    `ARB2: ${arb2}   ${colorAtt}   shaderErrs: ${errs}`;
  refs.glDiag.hidden = false;
}

// On-screen movement pad (mobile/wearable): each button drives the engine's
// existing w/a/s/d binds via synthetic key events (verified to reach the engine),
// so no engine change is needed. Head-turning still aims; this just walks.
const MOVE_KEYS = {
  forward: { key: "w", code: "KeyW", keyCode: 87 },
  back: { key: "s", code: "KeyS", keyCode: 83 },
  left: { key: "a", code: "KeyA", keyCode: 65 },
  right: { key: "d", code: "KeyD", keyCode: 68 }
};
const moveActive = Object.create(null);

function setMove(dir, down) {
  const k = MOVE_KEYS[dir];
  if (!k || Boolean(moveActive[dir]) === Boolean(down)) {
    return;
  }
  moveActive[dir] = Boolean(down);
  const type = down ? "keydown" : "keyup";
  // Dispatch a fresh event to each plausible SDL target (window/document/canvas);
  // whichever the Emscripten keyboard listener is bound to picks it up.
  for (const target of [window, document, refs.canvas]) {
    target.dispatchEvent(new KeyboardEvent(type, {
      key: k.key, code: k.code, keyCode: k.keyCode, which: k.keyCode,
      bubbles: true, cancelable: true
    }));
  }
}

function wireMoveControls() {
  if (!refs.moveControls) {
    return;
  }
  for (const btn of refs.moveControls.querySelectorAll(".move-btn")) {
    const dir = btn.dataset.move;
    const press = (e) => { e.preventDefault(); e.stopPropagation(); setMove(dir, true); btn.classList.add("is-down"); };
    const release = (e) => { if (e) { e.preventDefault(); e.stopPropagation(); } setMove(dir, false); btn.classList.remove("is-down"); };
    btn.addEventListener("pointerdown", press);
    btn.addEventListener("pointerup", release);
    btn.addEventListener("pointercancel", release);
    btn.addEventListener("pointerleave", release);
    // Belt-and-suspenders for browsers that fire touch before pointer.
    btn.addEventListener("contextmenu", (e) => e.preventDefault());
  }
  // Release everything if the page is hidden/blurred mid-press.
  window.addEventListener("blur", () => { for (const d of Object.keys(MOVE_KEYS)) setMove(d, false); });
}

// Touch-look: dragging on the RIGHT side of the screen aims the camera,
// feeding the same engine hook head tracking uses (D3_AddViewAngles).
// idTech sign convention: yaw+ = turn left, pitch+ = look down — so
// dyaw = -dx * sens (drag left → look left) and dpitch = dy * sens
// (drag up → look up). Coexists with head tracking (both add deltas).
// Touches that start on buttons/overlays or the left side (movement pad
// territory) are ignored. ?looksens=<deg/px> tunes sensitivity.
function wireTouchLook() {
  const SENS = (() => {
    const m = location.search.match(/[?&]looksens=([0-9.]+)/);
    const v = m ? parseFloat(m[1]) : NaN;
    return Number.isFinite(v) && v > 0 && v <= 2 ? v : 0.25;
  })();
  let lookId = null;
  let lastX = 0;
  let lastY = 0;

  document.addEventListener("touchstart", (e) => {
    if (lookId !== null) return;
    for (const t of e.changedTouches) {
      if (t.clientX < window.innerWidth * 0.45) continue;        // left = move pad side
      const el = document.elementFromPoint(t.clientX, t.clientY);
      if (el && (el.closest("button") || el.closest("#diag"))) continue;
      lookId = t.identifier;
      lastX = t.clientX;
      lastY = t.clientY;
      break;
    }
  }, { passive: true });

  document.addEventListener("touchmove", (e) => {
    if (lookId === null) return;
    for (const t of e.changedTouches) {
      if (t.identifier !== lookId) continue;
      const dx = t.clientX - lastX;
      const dy = t.clientY - lastY;
      lastX = t.clientX;
      lastY = t.clientY;
      if (engine && typeof engine.callAddViewAngles === "function") {
        engine.callAddViewAngles(-dx * SENS, dy * SENS);
      }
      e.preventDefault();   // stop Safari scroll/bounce while aiming
      break;
    }
  }, { passive: false });

  const endLook = (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === lookId) { lookId = null; break; }
    }
  };
  document.addEventListener("touchend", endLook, { passive: true });
  document.addEventListener("touchcancel", endLook, { passive: true });

  // Desktop: click-drag on the right side of the screen aims, mirroring the
  // touch path (no pointer lock — keeps the cursor for the UI).
  let mouseLook = false;
  let mLastX = 0, mLastY = 0;
  document.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (e.clientX < window.innerWidth * 0.45) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el && (el.closest("button") || el.closest("#diag") || el.closest("#fxPanel") || el.closest("input"))) return;
    mouseLook = true;
    mLastX = e.clientX;
    mLastY = e.clientY;
  });
  document.addEventListener("mousemove", (e) => {
    if (!mouseLook) return;
    const dx = e.clientX - mLastX;
    const dy = e.clientY - mLastY;
    mLastX = e.clientX;
    mLastY = e.clientY;
    if (engine && typeof engine.callAddViewAngles === "function") {
      engine.callAddViewAngles(-dx * SENS, dy * SENS);
    }
    e.preventDefault();
  });
  document.addEventListener("mouseup", () => { mouseLook = false; });
  document.addEventListener("mouseleave", () => { mouseLook = false; });
}

// FX panel: live sliders for bloom + lighting calibration (every change runs
// a console command next frame via d3cmd — no rebuild, works on-device too).
function wireFxPanel() {
  const btn = document.createElement("button");
  btn.id = "fxToggle";
  btn.type = "button";
  btn.textContent = "fx";
  btn.setAttribute("style", "position:fixed;right:8px;top:46px;z-index:10000;min-width:44px;min-height:30px;padding:4px 10px;font:600 13px/1 ui-monospace,Menlo,monospace;color:#9effa0;background:rgba(0,0,0,.8);border:1px solid #2f6f30;border-radius:7px;-webkit-appearance:none;cursor:pointer");
  document.body.appendChild(btn);

  const panel = document.createElement("div");
  panel.id = "fxPanel";
  panel.setAttribute("style", "position:fixed;right:8px;top:82px;z-index:10000;display:none;padding:10px 12px;font:600 12px/1.6 ui-monospace,Menlo,monospace;color:#9effa0;background:rgba(0,0,0,.85);border:1px solid #2f6f30;border-radius:7px;min-width:230px");
  const SLIDERS = [
    { label: "bloom scale",  cvar: "r_bloomScale",     min: 0,   max: 3,   step: 0.05, value: 1.25 },
    { label: "bloom thresh", cvar: "r_bloomThreshold", min: 0,   max: 1,   step: 0.02, value: 0.5 },
    // Iter 35: defaults = native dhewm3 parity; ?bfg preset shifts
    // lightScale 3 + shadow-darken 0.6 (sliders show the active preset).
    { label: "gamma",        cvar: "r_gamma",          min: 0.5, max: 2,   step: 0.05, value: 1.0 },
    { label: "brightness",   cvar: "r_brightness",     min: 0.5, max: 2,   step: 0.05, value: 1.0 },
    // Multiplies LIGHT energy (pools brighten, shadow contrast scales with
    // it) instead of lifting the whole frame. Native = 2, BFG preset = 3.
    { label: "light scale",  cvar: "r_lightScale",     min: 1,   max: 6,   step: 0.25,
      value: /[?&]bfg\b/.test(location.search) ? 3 : 2 },
    // Quest-style visible shadows: shadowed pixels multiply by this
    // (1 = vanilla per-light masking only, lower = darker shadows).
    { label: "shadow dark",  cvar: "r_shadowDarken",   min: 0.2, max: 1,   step: 0.05,
      value: /[?&]bfg\b/.test(location.search) ? 0.6 : 1.0 },
  ];
  for (const s of SLIDERS) {
    const row = document.createElement("div");
    const cap = document.createElement("div");
    cap.textContent = `${s.label}: ${s.value}`;
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(s.min);
    input.max = String(s.max);
    input.step = String(s.step);
    input.value = String(s.value);
    input.setAttribute("style", "width:100%;accent-color:#5fae61");
    input.addEventListener("input", () => {
      cap.textContent = `${s.label}: ${input.value}`;
      if (typeof window.d3cmd === "function") {
        window.d3cmd(`${s.cvar} ${input.value}`);
      }
    });
    row.appendChild(cap);
    row.appendChild(input);
    panel.appendChild(row);
  }
  document.body.appendChild(panel);
  btn.addEventListener("click", () => {
    panel.style.display = panel.style.display === "none" ? "block" : "none";
  });
}

refs.canvas.width = runtimeConfig.width;
refs.canvas.height = runtimeConfig.height;
refs.canvas.style.aspectRatio = `${runtimeConfig.width} / ${runtimeConfig.height}`;
refs.canvas.focus({ preventScroll: true });

// Per-pixel temporal accumulation (opt-in via ?taa[=α]). Masks Apple Metal's
// per-frame FP non-determinism by blending consecutive frames at the
// composite layer. See src/taa.js for the math.
installTAA(refs.canvas);

// On-device diagnostics (the loading panel hides the canvas; this overlay stays
// on top so a black-screened phone still shows WHY). Reports the WebGL renderer
// + limits, any WebGL context loss (the classic iOS out-of-GPU-memory failure),
// and uncaught errors. Add ?nodiag to hide it.
const diagEl = document.querySelector("#diag");
const diagToggle = document.querySelector("#diagToggle");
const diagLines = [];
// GL/renderer init lines, pinned to the top of the overlay so they stay visible
// (they otherwise scroll out before the level loads). This is the key
// iPhone-GPU-vs-desktop diagnostic: GPU name + whether high-precision float is
// available in fragment shaders (mobile GPUs underflow lighting math without it).
const glInfo = [];
window.__d3GLInfo = glInfo;
let diagProgLine = "";
// Live one-liner for the on-device WebGL probe (texture memory + GL errors),
// declared here so renderDiag can reference it without a temporal-dead-zone error.
let glProbeLine = "";
// Live one-liner for the sampled rendered-frame brightness (engine output before
// the CSS filter) — tells dark-shader-output apart from a display/exposure issue.
let framePxLine = "";
// Lines are always collected so the "show log" button can reveal them even when
// the overlay started hidden (?nodiag). Visibility is just a CSS toggle.
let diagHidden = /[?&]nodiag\b/.test(location.search);
function applyDiagVisibility() {
  if (diagEl) diagEl.style.display = diagHidden ? "none" : "block";
  if (diagToggle) diagToggle.textContent = diagHidden ? "show log" : "hide log";
}
// The full overlay text — GL diagnostics + probe pinned on top, live log below.
// Shared by renderDiag (display) and the copy button so what you copy is exactly
// what you see (and it works even while the overlay is collapsed).
// Build stamp + live fps — the first line of the diag, so a phone screenshot
// always tells us WHICH build it runs (iOS Safari serves stale builds
// relentlessly) and whether the engine is frozen (fps 0) or just slow.
const BUILD_STAMP = (typeof __ENGINE_VER__ !== "undefined")
  ? new Date(Number(__ENGINE_VER__)).toISOString().slice(5, 16).replace("T", " ")
  : "dev";
let fpsLine = `build ${BUILD_STAMP} UTC | fps —`;
try { console.info("[d3] build:", BUILD_STAMP, "UTC"); } catch {}
// Crash telemetry: iOS Safari kills the tab on memory ("a problem
// repeatedly occurred") and takes the evidence with it. Persist the live
// stats every beat; if the previous session didn't end cleanly, surface
// its last-known state at the top of this session's log.
try {
  const prev = localStorage.getItem("d3_prev_session");
  if (prev && localStorage.getItem("d3_clean_exit") !== "1") {
    const p = JSON.parse(prev);
    const line = `⚠ previous session DIED: ${p.line} (${Math.round((Date.now() - p.t) / 1000)}s ago)`;
    diagLines.push(line);
    console.warn("[d3]", line);
  }
  localStorage.setItem("d3_clean_exit", "0");
  addEventListener("pagehide", () => { try { localStorage.setItem("d3_clean_exit", "1"); } catch {} });
} catch {}
// Stale-bundle self-detection (iter 31): iOS Safari serves cached bundles far
// past the Pages 600s TTL — that's how a device read "r_shadows 0" from a
// pre-iter-29 bundle while the deploy shipped 1. version.txt is emitted at
// build time with the same id baked into __ENGINE_VER__; a newer value there
// means THIS bundle is stale. Auto-refresh once per newer version (the URL
// gains &fresh=<id>, which also busts the index.html cache entry); a
// sessionStorage guard prevents reload loops while the CDN itself still
// serves the old files — then it just warns in the diag.
(async () => {
  if (typeof __ENGINE_VER__ === "undefined") return;
  try {
    const base = (import.meta.env && import.meta.env.BASE_URL) || "/";
    const r = await fetch(base + "version.txt", { cache: "no-store" });
    if (!r.ok) return;                                   // dev server / missing
    const latest = (await r.text()).trim();
    if (!/^\d{10,}$/.test(latest) || Number(latest) <= Number(__ENGINE_VER__)) return;
    const stamp = new Date(Number(latest)).toISOString().slice(5, 16).replace("T", " ");
    const key = "d3_fresh_" + latest;
    if (sessionStorage.getItem(key)) {
      diag(`⚠ STALE BUILD: running ${BUILD_STAMP}, latest is ${stamp} UTC — refresh didn't take; CDN may need a few minutes`);
      return;
    }
    sessionStorage.setItem(key, "1");
    diag(`⚠ newer build ${stamp} UTC available — refreshing…`);
    const u = new URL(location.href);
    u.searchParams.set("fresh", latest);
    location.replace(u.toString());
  } catch {}
})();
(() => {
  let frames = 0;
  let last = performance.now();
  const tick = () => {
    frames++;
    const now = performance.now();
    if (now - last >= 2000) {
      const mem = (typeof window.__d3HeapMB === "function") ? ` | wasm ${window.__d3HeapMB()}MB` : "";
      // WebGPU texture footprint (set by the backend on every cache insert) —
      // persisted with the rest of the line by crash telemetry, so a dead iOS
      // tab reports how much GPU texture memory it held.
      const wtex = (typeof window.__d3WgpuTexMB === "number")
        ? ` | wgpu-tex ${window.__d3WgpuTexMB.toFixed(0)}MB/${window.__d3WgpuTexN}${window.__d3WgpuTexDrop ? ` (drop ${window.__d3WgpuTexDrop})` : ""}`
        : "";
      // Live stencil-shadow volume count (published by the backend each
      // drain) — "shdw 0" with shadows expected = r_shadows got overridden.
      const shdw = (typeof window.__d3ShadowVols === "number") ? ` | shdw ${window.__d3ShadowVols}` : "";
      fpsLine = `build ${BUILD_STAMP} UTC | fps ${(frames * 1000 / (now - last)).toFixed(1)}${mem}${wtex}${shdw}`;
      // ?fpstitle: mirror the stats line into the tab title — lets tooling
      // read live fps via plain AppleScript (no focus steal / clipboard /
      // accessibility); used for the Safari perf bisect.
      if (/[?&]fpstitle\b/.test(location.search)) { try { document.title = fpsLine; } catch {} }
      try { localStorage.setItem("d3_prev_session", JSON.stringify({ t: Date.now(), line: fpsLine })); } catch {}
      frames = 0;
      last = now;
      renderDiag();
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();
function buildDiagText() {
  const tail = diagProgLine ? diagLines.concat(`▸ ${diagProgLine}`) : diagLines;
  const head = [fpsLine];
  if (glInfo.length) head.push("═══ GL DIAGNOSTICS ═══", ...glInfo);
  if (glProbeLine) head.push(glProbeLine);
  if (framePxLine) head.push(framePxLine);
  const body = head.length ? [...head, "═══ log ═══", ...tail] : tail;
  return body.join("\n");
}
function renderDiag() {
  if (!diagEl || diagHidden) return;
  // Auto-follow the newest lines only when already at the bottom, so a manual
  // scroll-up (to read history) isn't yanked back down by new log lines.
  const atBottom = diagEl.scrollHeight - diagEl.scrollTop - diagEl.clientHeight < 48;
  diagEl.textContent = buildDiagText();
  if (atBottom) diagEl.scrollTop = diagEl.scrollHeight;
}
function diag(line) {
  diagLines.push(line);
  if (diagLines.length > 500) diagLines.shift();
  renderDiag();
}
diagToggle?.addEventListener("click", () => {
  diagHidden = !diagHidden;
  applyDiagVisibility();
  renderDiag();
});
const diagCopy = document.querySelector("#diagCopy");
diagCopy?.addEventListener("click", async () => {
  const text = buildDiagText();
  const restore = (msg) => {
    diagCopy.textContent = msg;
    window.setTimeout(() => {
      diagCopy.textContent = "copy log";
    }, 1600);
  };
  // Preferred path: async Clipboard API (needs HTTPS + a user gesture — both hold
  // here). Falls back to a hidden textarea + execCommand for older iOS WebKit.
  try {
    await navigator.clipboard.writeText(text);
    restore("copied ✓");
    return;
  } catch (_) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.readOnly = true;
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      restore(ok ? "copied ✓" : "copy failed");
    } catch (e) {
      restore("copy failed");
    }
  }
});
applyDiagVisibility();
// Single in-place line for download/load progress (so it doesn't flood the log).
function diagProgress(line) {
  diagProgLine = line;
  renderDiag();
}
diag(`ua: ${navigator.userAgent.slice(0, 80)}`);
diag(`screen ${screen.width}x${screen.height} dpr${window.devicePixelRatio} canvas ${runtimeConfig.width}x${runtimeConfig.height} mode=${runtimeConfig.inputMode}`);
diag(`mem: deviceMemory=${navigator.deviceMemory ?? "?"}GB jsHeapLimit=${(performance.memory?.jsHeapSizeLimit / 1048576 | 0) || "?"}MB`);
diag(`brightness: lightScale=${runtimeConfig.rLightScale} gamma=${runtimeConfig.rGamma} brightness=${runtimeConfig.rBrightness} cssBright=${runtimeConfig.displayBrightness} gammaInShader=1`);
// NOTE: do NOT call canvas.getContext() here — a canvas has a single WebGL
// context, and probing it would steal it from the engine (SDL3 creates its own).
// The engine logs its GL renderer ("OpenGL renderer: ...") to the runtime log.
//
// ── On-device WebGL probe ────────────────────────────────────────────────────
// Desktop WebKit (Apple M-series GPU) renders the lit world fully — even with
// S3TC compression disabled — but the iPhone draws the textured world black
// while emissive glows/sparks still show. That is the signature of the weaker
// mobile GPU failing texture uploads (out of memory) or hitting a shader/texture
// limit the desktop doesn't. The engine log can't surface that, so WRAP
// getContext (SDL/emscripten calls it on #gameCanvas — wrapping the prototype
// instruments the engine's own context instead of stealing it), dump the GPU's
// limits once, and tally texture uploads + GL errors live at the top of the diag.
// ── TBDR (Apple GPU) optimization: invalidate before every clear ─────────────
// Apple GPUs are tile-based deferred renderers. Without explicit invalidation,
// the driver assumes previous-frame depth/stencil/color contents may be needed,
// so it STORES at end-of-frame and LOADS at start-of-frame for every tile.
// Under DOOM 3's many-draws-per-frame additive-blend lit pass this load/store
// pressure can cause adjacent-tile timing inconsistencies producing visible
// blocky brightness variance (the user reports tile-pattern artifacts in the
// rendered floor area). The canonical fix: pair gl.clear() with
// invalidateFramebuffer(), telling the driver "you don't need to load the
// previous tile contents back, just clear." Apple's Metal docs and Khronos's
// WebGL best-practices both call this out as the #1 TBDR optimization.
// Default-on; ?notbdrfix disables for A/B.
(function fixTBDRClears() {
  if (/[?&]notbdrfix\b/.test(location.search)) return;
  const wrap = (proto) => {
    if (!proto || !proto.clear || proto.clear.__d3TBDR) return;
    const origClear = proto.clear;
    const patched = function (mask) {
      // Tell the driver previous-frame attachments don't need loading. Use the
      // right attachment enum based on whether the default framebuffer or a
      // user FBO is bound (different names per WebGL2 spec).
      try {
        if (this.invalidateFramebuffer) {
          const isDefault = this.getParameter(this.FRAMEBUFFER_BINDING) === null;
          const atts = [];
          if (mask & this.COLOR_BUFFER_BIT)
            atts.push(isDefault ? 0x1800 /*COLOR*/    : this.COLOR_ATTACHMENT0);
          if (mask & this.DEPTH_BUFFER_BIT)
            atts.push(isDefault ? 0x1801 /*DEPTH*/    : this.DEPTH_ATTACHMENT);
          if (mask & this.STENCIL_BUFFER_BIT)
            atts.push(isDefault ? 0x1802 /*STENCIL*/  : this.STENCIL_ATTACHMENT);
          if (atts.length) this.invalidateFramebuffer(this.FRAMEBUFFER, atts);
        }
      } catch (_) { /* never break the engine */ }
      return origClear.call(this, mask);
    };
    patched.__d3TBDR = true;
    proto.clear = patched;
  };
  // invalidateFramebuffer is WebGL2-only — WebGL1 doesn't have it
  wrap(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
})();

// Optional ?nomip / ?lodbias=N flags: force GL_LINEAR min filter (kill
// mipmaps) and/or set explicit LOD bias on all sampled textures. Mipmap LOD
// selection picks between two mips per fragment based on a screen-space
// derivative — for pixels near the mip threshold, tiny per-frame precision
// wobble flips the choice, sampling a pre-filtered (mip+1) vs unfiltered
// (mip) texel, producing ~1-2% per-pixel oscillation across the whole scene.
// Disabling mipmaps eliminates that variance source.
(function fixMipmapJitter() {
  const noMip = /[?&]nomip\b/.test(location.search);
  if (!noMip) return;
  const wrap = (proto) => {
    if (!proto) return;
    const orig = proto.texParameteri;
    if (!orig || orig.__d3NoMip) return;
    const patched = function (target, pname, param) {
      if (pname === this.TEXTURE_MIN_FILTER) {
        // Map all mipmap min filters to non-mipmap equivalents
        if (param === this.LINEAR_MIPMAP_LINEAR || param === this.LINEAR_MIPMAP_NEAREST) {
          param = this.LINEAR;
        } else if (param === this.NEAREST_MIPMAP_LINEAR || param === this.NEAREST_MIPMAP_NEAREST) {
          param = this.NEAREST;
        }
      }
      return orig.call(this, target, pname, param);
    };
    patched.__d3NoMip = true;
    proto.texParameteri = patched;
  };
  wrap(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
  wrap(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
})();

// ── WebKit lit-pass fix: splat falloff alpha into RGB ────────────────────────
// On WebKit (iPhone Safari, Mac Safari, anything that isn't Chrome/ANGLE), the
// DOOM 3 lit pass renders the world near-black. Bisected with shader debug
// visualizations: the per-light **falloff** texture (sampler 2 in the interaction
// shader) has its data only in the .w/alpha channel; .xyz reads as 0. The engine
// uploads it as a 1-channel texture and the GL_LUMINANCE → WebGL emulation path
// in GL4ES lands the data in alpha-only on WebKit, while Chrome's ANGLE happens
// to splat it correctly. The interaction shader reads .xyz, so light *= (0,0,0)
// → black walls.
//
// Fix without touching the engine or GL4ES: wrap shaderSource and, when we see
// the GL4ES-translated DOOM 3 interaction shader (identified by its DXT5-NM
// normal swizzle "localNormal.x = localNormal.w"), rewrite the falloff sample
// from `texture2DProj(_gl4es_Sampler2D_2, _gl4es_TexCoord_2)` to a vec4-splat
// of its .w. Walls light up; verified to match the reference render.
// Escape hatch: ?nofalloffix disables it for A/B.
// ── Force opaque, no-MSAA WebGL context to kill "black flicker" on iOS ───────
// Default WebGL context attributes on iOS Safari can produce intermittent
// per-frame black flashes during motion:
//   alpha:true     → if the engine doesn't write alpha=1 on every pixel, the
//                    canvas composites with transparency over the page bg.
//                    Some frames may end up with pixels-with-alpha-0 → black.
//   antialias:true → iOS does an MSAA resolve at swap; under load that blit
//                    can miss the frame, leaving the canvas empty (black).
// We force alpha:false and antialias:false at getContext time, before the
// engine creates its WebGL context. ?noopaque disables the alpha override and
// ?msaa re-enables antialias for A/B testing.
(function fixContextAttrs() {
  if (/[?&]nocontextattrs\b/.test(location.search)) return;
  const forceAlpha = !/[?&]noopaque\b/.test(location.search);
  const forceNoMsaa = !/[?&]msaa\b/.test(location.search);
  // GL_DITHER is ENABLED by default in WebGL2. On Apple's tile-based GPUs the
  // dither pattern can manifest as per-tile blocky brightness variance — the
  // exact symptom of the iPhone "tile flicker" the user reports. Disable it
  // for the engine's context right after creation. ?dither re-enables for A/B.
  const forceNoDither = !/[?&]dither\b/.test(location.search);
  const orig = HTMLCanvasElement.prototype.getContext;
  if (orig.__d3CtxAttrs) return;
  // TAA requires the WebGL backbuffer to remain readable after the engine
  // presents — i.e. preserveDrawingBuffer:true. Without it, drawImage(webgl)
  // from outside the render loop reads transparent on iOS Safari. Force it
  // ONLY when ?taa is active so we don't pay the cost otherwise.
  const forcePreserveBuffer = /[?&]taa\b/.test(location.search);
  const patched = function (type, attrs) {
    if (typeof type === "string" && /webgl/i.test(type)) {
      attrs = Object.assign({}, attrs);
      if (forceAlpha) attrs.alpha = false;
      if (forceNoMsaa) attrs.antialias = false;
      if (forcePreserveBuffer) attrs.preserveDrawingBuffer = true;
    }
    const gl = orig.call(this, type, attrs);
    if (gl && forceNoDither && typeof type === "string" && /webgl/i.test(type)) {
      try { gl.disable(gl.DITHER); } catch (_) {}
    }
    return gl;
  };
  patched.__d3CtxAttrs = true;
  HTMLCanvasElement.prototype.getContext = patched;
})();

// ── Force synchronous shader link to avoid mid-gameplay "black flicker" ───────
// On iOS Safari WebGL, linkProgram() can be asynchronous (KHR_parallel_shader_
// compile-style). DOOM 3 lazily compiles a fresh GLSL program for each
// material × light interaction combo the first time it's seen — when the player
// turns and a new surface comes into view, GL4ES emits a new program. If iOS
// runs the link async, the engine's next draw uses a not-yet-ready program and
// those surfaces render dark for ONE frame, producing the visible "black
// flicker" during motion (engine frames vary in brightness depending on which
// programs are ready that frame). Querying LINK_STATUS / COMPLETION_STATUS_KHR
// immediately after link forces the GL implementation to finish compile/link
// synchronously before returning, eliminating the flicker. Cost: a one-time
// per-program stall the first time it's seen (the user already had this cost
// distributed as flicker; concentrating it as a brief stutter is much better).
// ?noflickerfix disables it for A/B.
// ── iOS 18 immutable-texture workaround ────────────────────────────────────
// iOS 18 introduced a regression: offscreen rendering with MUTABLE textures
// (created via glTexImage2D) breaks unpredictably — produces undefined frame
// contents that manifest as "fixed dotted pixel-grid pattern" / per-tile
// brightness variance / our tile flicker. Documented in bgfx#3352 (2024-09-11);
// also matches the unsolved threejs forum #89164 (2026-01-16) symptom EXACTLY.
// Workaround: allocate texture storage via IMMUTABLE glTexStorage2D, then
// upload pixel data via glTexSubImage2D. Wraps gl.texImage2D so the engine
// never has to know.
// ?nottexstorage disables for A/B. Opt-IN to start (default off) until we
// confirm the unsized→sized format mapping is complete.
const FORMAT_TO_SIZED = {
  // base-format → sized internal format mappings (WebGL2 spec table)
  [0x1908 /*RGBA*/]:   0x8058 /*RGBA8*/,
  [0x1907 /*RGB*/]:    0x8051 /*RGB8*/,
  [0x1906 /*ALPHA*/]:  0x803C /*ALPHA8 (gl ext)*/, // may not be valid in WebGL2 — fallback to R8
  [0x1909 /*LUMINANCE*/]: 0x8229 /*R8*/, // approximated
  [0x190A /*LUMINANCE_ALPHA*/]: 0x822B /*RG8*/,
  [0x1902 /*DEPTH_COMPONENT*/]: 0x81A6 /*DEPTH_COMPONENT24*/,
  [0x84F9 /*DEPTH_STENCIL*/]:   0x88F0 /*DEPTH24_STENCIL8*/,
};
const __d3ImmutableTextures = new WeakSet();
window.__d3TexStorageStats = { upgraded: 0, skipped_remap: 0, skipped_immutable: 0, fallthrough: 0, errors: 0 };
(function fixIOS18TextureStorage() {
  if (!/[?&]immutable\b/.test(location.search)) return;  // opt-in for safety
  const wrap = (proto) => {
    if (!proto || !proto.texImage2D || proto.texImage2D.__d3Immutable) return;
    const orig = proto.texImage2D;
    const patched = function (target, level, internalformat, widthOrFormat, heightOrType, borderOrSource, format, type, pixels) {
      // Only intercept the 9-arg variant for level-0 TEXTURE_2D — the form used
      // for FBO render-target allocation. The 6-arg DOM-source variant + non-zero
      // mip levels we pass through untouched.
      const is9arg = arguments.length >= 7;
      try {
        if (is9arg && target === this.TEXTURE_2D && level === 0) {
          const tex = this.getParameter(this.TEXTURE_BINDING_2D);
          if (!tex) {
            window.__d3TexStorageStats.fallthrough += 1;
            return orig.apply(this, arguments);
          }
          if (__d3ImmutableTextures.has(tex)) {
            // Already immutable — can only update via subImage2D
            window.__d3TexStorageStats.skipped_immutable += 1;
            if (pixels !== null && pixels !== undefined) {
              this.texSubImage2D(target, 0, 0, 0, widthOrFormat, heightOrType, format, type, pixels);
            }
            return;
          }
          const sized = FORMAT_TO_SIZED[internalformat] || internalformat;
          // Only redirect when we know how to map the format
          if (FORMAT_TO_SIZED[internalformat]) {
            this.texStorage2D(target, 1, sized, widthOrFormat, heightOrType);
            __d3ImmutableTextures.add(tex);
            if (pixels !== null && pixels !== undefined) {
              this.texSubImage2D(target, 0, 0, 0, widthOrFormat, heightOrType, format, type, pixels);
            }
            window.__d3TexStorageStats.upgraded += 1;
            return;
          }
          window.__d3TexStorageStats.skipped_remap += 1;
        }
      } catch (e) {
        window.__d3TexStorageStats.errors += 1;
        if (window.__d3TexStorageStats.errors <= 3) console.warn("[d3 immutable tex] fallback:", e.message);
      }
      return orig.apply(this, arguments);
    };
    patched.__d3Immutable = true;
    proto.texImage2D = patched;
  };
  wrap(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
})();

// IMPORTANT diagnostic: iPhone Safari throws "useProgram: program not valid"
// every frame in the render loop, meaning the engine binds a program that
// failed to link. Track every linkProgram (with shader source captured) and
// every useProgram, expose via window.__d3LinkErrors / __d3UseProgramErrors.
window.__d3LinkLog = [];
window.__d3UseProgramErrors = [];
window.__d3ShaderSourceByShader = new WeakMap();
window.__d3SourcesByProgram = new Map();
(function fixAsyncShaderLink() {
  if (/[?&]noflickerfix\b/.test(location.search)) return;
  const wrap = (proto) => {
    if (!proto) return;

    // Capture every shader's source so we can dump the failing program's source.
    const origShaderSource = proto.shaderSource;
    if (origShaderSource && !origShaderSource.__d3LogSource) {
      const wrappedSrc = function (shader, source) {
        try { window.__d3ShaderSourceByShader.set(shader, String(source)); } catch (_) {}
        return origShaderSource.call(this, shader, source);
      };
      wrappedSrc.__d3LogSource = true;
      proto.shaderSource = wrappedSrc;
    }

    // Attach: collect attached shaders per program for later dump.
    const origAttach = proto.attachShader;
    if (origAttach && !origAttach.__d3LogAttach) {
      const wrappedAttach = function (program, shader) {
        try {
          let arr = window.__d3SourcesByProgram.get(program);
          if (!arr) { arr = []; window.__d3SourcesByProgram.set(program, arr); }
          arr.push({ shader, source: window.__d3ShaderSourceByShader.get(shader) || "(no source captured)" });
        } catch (_) {}
        return origAttach.call(this, program, shader);
      };
      wrappedAttach.__d3LogAttach = true;
      proto.attachShader = wrappedAttach;
    }

    // Link: force sync via LINK_STATUS, and log failures with full info.
    const orig = proto.linkProgram;
    if (orig && !orig.__d3SyncLink) {
      const patched = function (program) {
        const r = orig.call(this, program);
        try {
          const ok = this.getProgramParameter(program, this.LINK_STATUS);
          if (!ok) {
            const log = this.getProgramInfoLog(program);
            const sources = window.__d3SourcesByProgram.get(program) || [];
            const entry = { ok: false, log: String(log || ""), shaderCount: sources.length };
            // also include shader compile statuses + infologs
            entry.shaders = sources.map((s) => {
              const shaderOk = this.getShaderParameter(s.shader, this.COMPILE_STATUS);
              return {
                ok: !!shaderOk,
                infoLog: String(this.getShaderInfoLog(s.shader) || ""),
                sourcePreview: (s.source || "").slice(0, 400),
              };
            });
            window.__d3LinkLog.push(entry);
            console.error("[d3] linkProgram FAILED", entry);
          } else {
            window.__d3LinkLog.push({ ok: true });
          }
        } catch (e) { console.warn("[d3] link probe threw", e); }
        return r;
      };
      patched.__d3SyncLink = true;
      proto.linkProgram = patched;
    }

    // useProgram: log calls with invalid programs (matches the iPhone error).
    const origUse = proto.useProgram;
    if (origUse && !origUse.__d3UseProbe) {
      const wrappedUse = function (program) {
        try {
          if (program) {
            const validLink = this.getProgramParameter(program, this.LINK_STATUS);
            if (!validLink && window.__d3UseProgramErrors.length < 5) {
              const sources = window.__d3SourcesByProgram.get(program) || [];
              window.__d3UseProgramErrors.push({
                program: program.toString ? program.toString() : String(program),
                link_status: validLink,
                info_log: String(this.getProgramInfoLog(program) || ""),
                shaderCount: sources.length,
                shaders: sources.map((s) => ({
                  compile: !!this.getShaderParameter(s.shader, this.COMPILE_STATUS),
                  info: String(this.getShaderInfoLog(s.shader) || ""),
                  src_head: (s.source || "").slice(0, 600),
                })),
              });
              console.error("[d3] useProgram with INVALID PROGRAM", window.__d3UseProgramErrors[window.__d3UseProgramErrors.length - 1]);
            }
          }
        } catch (_) {}
        return origUse.call(this, program);
      };
      wrappedUse.__d3UseProbe = true;
      proto.useProgram = wrappedUse;
    }
  };
  wrap(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
  wrap(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
})();

// Combined shader source wrap: both the falloff fix and the sampler-precision
// fix run from the same patched shaderSource so they only wrap the prototype
// once.
//   1. falloff fix: see comment in the falloff branch — the per-light falloff
//      texture's data is in .w on WebKit, so splat .w into RGB.
//   2. sampler precision fix: GL4ES emits `uniform sampler2D foo;` without an
//      explicit precision qualifier. `precision highp float;` does NOT cover
//      samplers — GLSL ES 1.00 specifies that samplers have no default
//      precision in the fragment shader. On iOS Apple GPUs that silently
//      becomes `lowp sampler2D`, which quantizes texture coordinates and
//      sampled values. Adjacent frames sampling the same geometry can land on
//      different texels, producing the distributed per-pixel oscillation we
//      observed across the whole frame even with the camera stationary (deep-
//      research finding #5; confirmed by inspection of the captured GLSL).
//      Inject `highp ` before every sampler{2D,Cube,3D} declaration to force
//      full precision. ?noprecisionfix disables it for A/B.
// d3wasm-inspired clean interaction FS body (replaces the GL4ES-translated one).
// The GL4ES-emitted shader has been a moving target for per-frame oscillation —
// many intermediate `vec4(scalar)` broadcasts and a pow() gamma block at the end
// are precision-sensitive on Apple GPUs. This rewrite keeps the GL4ES uniform/
// varying interface unchanged (so the existing binding code Just Works) but
// streamlines the math into a single expression with d3wasm's clamp + pow(NdotH)
// + no in-shader gamma. Same texture-unit bindings GL4ES already does.
//
// Identified by the unique signature of the GL4ES interaction shader (the DXT5-NM
// alpha-to-X swizzle line). ?norewrite disables it for A/B.
const REWRITTEN_INTERACTION_FS = `#version 100
#extension GL_EXT_shader_non_constant_global_initializers : enable
precision highp float;
#define GL4ES
varying lowp  vec4 _gl4es_FrontColor;
varying highp vec4 _gl4es_TexCoord_0;
varying highp vec4 _gl4es_TexCoord_1;
varying highp vec4 _gl4es_TexCoord_2;
varying highp vec4 _gl4es_TexCoord_3;
varying highp vec4 _gl4es_TexCoord_4;
varying highp vec4 _gl4es_TexCoord_5;
varying highp vec4 _gl4es_TexCoord_6;
uniform lowp vec4 _gl4es_Fragment_ProgramEnv_0;
uniform lowp vec4 _gl4es_Fragment_ProgramEnv_1;
uniform vec4 _gl4es_Fragment_ProgramEnv_21;
uniform highp sampler2D   _gl4es_Sampler2D_1;
uniform highp sampler2D   _gl4es_Sampler2D_2;
uniform highp sampler2D   _gl4es_Sampler2D_3;
uniform highp sampler2D   _gl4es_Sampler2D_4;
uniform highp sampler2D   _gl4es_Sampler2D_5;
uniform highp sampler2D   _gl4es_Sampler2D_6;
uniform highp samplerCube _gl4es_SamplerCube_0;
void main(void) {
\t// Light direction (tangent space) from normalization cubemap. We keep the
\t// existing cubemap binding so we don't need a new vertex pipeline.
\thighp vec3 L = normalize(textureCube(_gl4es_SamplerCube_0, _gl4es_TexCoord_0.xyz).xyz * 2.0 - 1.0);
\t// Half-vector (tangent space) — VS produces it un-normalized via TexCoord_6.
\thighp vec3 H = normalize(_gl4es_TexCoord_6.xyz);
\t// Normal: bump map, DXT5-NM swizzle (X in alpha).
\thighp vec3 N = texture2D(_gl4es_Sampler2D_1, _gl4es_TexCoord_1.xy).agb * 2.0 - 1.0;
\thighp float NdotL = clamp(dot(N, L), 0.0, 1.0);
\thighp float NdotH = clamp(dot(N, H), 0.0, 1.0);
\thighp vec3 lightProjection = texture2DProj(_gl4es_Sampler2D_3, _gl4es_TexCoord_3).rgb;
\thighp float lightFalloff = texture2DProj(_gl4es_Sampler2D_2, _gl4es_TexCoord_2).a;
\tlowp vec3 diffuse  = texture2D(_gl4es_Sampler2D_4, _gl4es_TexCoord_4.xy).rgb * _gl4es_Fragment_ProgramEnv_0.rgb;
\tlowp vec3 specular = 2.0 * texture2D(_gl4es_Sampler2D_5, _gl4es_TexCoord_5.xy).rgb * _gl4es_Fragment_ProgramEnv_1.rgb;
\thighp float specFalloff = pow(NdotH, 12.0);
\thighp vec3 color = (diffuse + specFalloff * specular) * NdotL * lightProjection * lightFalloff;
\tgl_FragColor = vec4(color, 1.0) * _gl4es_FrontColor;
}
`;

// Quest-inspired interaction FS — adapted from DrBeef/Doom3Quest's
// renderer/glsl/interactionShaderFP.cpp. Key change from REWRITTEN_INTERACTION_FS
// above: SKIPS the normalization cubemap (textureCube → normalize() of unpacked
// _gl4es_TexCoord_0). Apple's TBDR cubemap sampling has been theorized as a
// per-frame noise source (mipmap LOD on a cube is computed differently than
// on a 2D texture; ANGLE/Metal layer in WebKit). Doom3Quest doesn't use the
// normalization cubemap because modern GPUs have fast normalize() — it was a
// late-90s optimization, and on Apple's compiler the cubemap detour may
// actively cost determinism.
//
// Interface preserved: same _gl4es_* uniform and varying names so GL4ES uniform
// binding still works. The cubemap sampler binding still exists (engine binds
// it via the same texture unit) but our shader doesn't sample it — that's fine,
// it's just an unused uniform.
const QUEST_INTERACTION_FS = `#version 100
precision highp float;
#define GL4ES
varying lowp  vec4 _gl4es_FrontColor;
varying highp vec4 _gl4es_TexCoord_0;
varying highp vec4 _gl4es_TexCoord_1;
varying highp vec4 _gl4es_TexCoord_2;
varying highp vec4 _gl4es_TexCoord_3;
varying highp vec4 _gl4es_TexCoord_4;
varying highp vec4 _gl4es_TexCoord_5;
varying highp vec4 _gl4es_TexCoord_6;
uniform lowp vec4 _gl4es_Fragment_ProgramEnv_0;
uniform lowp vec4 _gl4es_Fragment_ProgramEnv_1;
uniform highp sampler2D   _gl4es_Sampler2D_1;
uniform highp sampler2D   _gl4es_Sampler2D_2;
uniform highp sampler2D   _gl4es_Sampler2D_3;
uniform highp sampler2D   _gl4es_Sampler2D_4;
uniform highp sampler2D   _gl4es_Sampler2D_5;
uniform highp sampler2D   _gl4es_Sampler2D_6;
uniform highp samplerCube _gl4es_SamplerCube_0;
void main(void) {
\t// Light direction — skip the normalization cubemap. _gl4es_TexCoord_0 is
\t// packed in [0,1]; unpack and normalize directly.
\thighp vec3 L = normalize(_gl4es_TexCoord_0.xyz * 2.0 - 1.0);
\t// Half-vector — direct normalize (no precomputed inversesqrt detour).
\thighp vec3 H = normalize(_gl4es_TexCoord_6.xyz);
\t// Normal from bump map (DXT5-NM swizzle: X in alpha). Normalize so the
\t// dot products give clean values; the .agb*2-1 unpack alone leaves the
\t// vector slightly off-unit after texture filtering.
\thighp vec3 N = normalize(texture2D(_gl4es_Sampler2D_1, _gl4es_TexCoord_1.xy).agb * 2.0 - 1.0);
\thighp float NdotL = clamp(dot(N, L), 0.0, 1.0);
\thighp float NdotH = clamp(dot(N, H), 0.0, 1.0);
\thighp vec3 lightProj = texture2DProj(_gl4es_Sampler2D_3, _gl4es_TexCoord_3).rgb;
\t// Falloff lives in .w on WebKit (single-channel emulation quirk, see
\t// existing falloffix). Use it directly.
\thighp float lightFall = texture2DProj(_gl4es_Sampler2D_2, _gl4es_TexCoord_2).w;
\thighp vec3 diffuse  = texture2D(_gl4es_Sampler2D_4, _gl4es_TexCoord_4.xy).rgb * _gl4es_Fragment_ProgramEnv_0.rgb;
\thighp vec3 specCurve = texture2D(_gl4es_Sampler2D_6, vec2(NdotH, 0.5)).rgb * _gl4es_Fragment_ProgramEnv_1.rgb;
\thighp vec3 specMap   = texture2D(_gl4es_Sampler2D_5, _gl4es_TexCoord_5.xy).rgb * 2.0;
\thighp vec3 color = (diffuse + specCurve * specMap) * NdotL * lightProj * lightFall;
\tgl_FragColor = vec4(color, 1.0) * _gl4es_FrontColor;
}
`;

// For each call-site matched by `nameRe` (e.g. /\btexture2DLodEXT\s*\(/g),
// walk to the matching `)` and insert `, 0.0` before it. Handles nested
// parens in the argument list (e.g. `vec2(a, b)` as a coord).
function injectLodArg(src, nameRe) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    nameRe.lastIndex = i;
    const m = nameRe.exec(src);
    if (!m) { out += src.substring(i); break; }
    out += src.substring(i, m.index + m[0].length);
    let depth = 1, j = m.index + m[0].length;
    while (j < src.length && depth > 0) {
      const c = src[j];
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) {
          out += src.substring(m.index + m[0].length, j) + ", 0.0)";
          j++;
          break;
        }
      }
      j++;
    }
    if (depth !== 0) {
      // unbalanced; bail to safe passthrough
      out += src.substring(m.index + m[0].length);
      break;
    }
    i = j;
  }
  return out;
}

(function fixShaderSources() {
  const enableFalloff   = !/[?&]nofalloffix\b/.test(location.search);
  const enablePrecision = !/[?&]noprecisionfix\b/.test(location.search);
  // DEFAULT OFF: the rewrite uses individual `_gl4es_TexCoord_5` varying names
  // but GL4ES emits the matching vertex shader with array form
  // `_gl4es_TexCoord[5]`. iOS Safari (strict) treats these as different names
  // and the program fails to link — the engine then calls glUseProgram with an
  // invalid program every frame, render fails for those surfaces, and we get
  // the iPhone "tile flicker" we've been chasing. Mac WebKit (Playwright)
  // apparently bridges them silently. ?rewrite to opt-in for diagnostic use.
  const enableRewrite   = /[?&]rewrite\b/.test(location.search);
  // Quest-inspired FS body rewrite (adapted from DrBeef/Doom3Quest
  // renderer/glsl/interactionShaderFP.cpp). Body-only — keeps GL4ES's
  // emitted header. ?questfs to enable.
  const enableQuestFS   = /[?&]questfs\b/.test(location.search);
  // No-cubemap variant of the Quest body. Drops the textureCube() call
  // for L-vector normalization (a known [SPIRV-Cross commit 7ef52b0,
  // MoltenVK #2068] Apple-Silicon bug where one partial derivative of
  // cubemap gradients is silently ignored — manifests as per-pixel
  // intensity drift). Uses `normalize(_gl4es_TexCoord_0.xyz * 2 - 1)`
  // directly. Same shader-link risk as ?questfs but bigger upside.
  // ?nocubefs to enable.
  const enableNoCubeFS  = /[?&]nocubefs\b/.test(location.search);
  // Quantize the interaction FS output to 8-bit before additive blending.
  // Theory: iPhone tile flicker is FP non-determinism in lit-pass accumulation
  // across many additive draws (bisect confirmed: r_skipInteractions cuts the
  // per-frame diff by 88%, r_skipDiffuse by 64%; engine-level cvars do nothing).
  // Snapping each per-light contribution to a discrete 8-bit value before the
  // blend collapses the FP noise that otherwise oscillates the framebuffer.
  // Gated via ?quantize for safety; ?noquantize forces off.
  const enableQuantize  = /[?&]quantize\b/.test(location.search) && !/[?&]noquantize\b/.test(location.search);
  // Strip the in-shader gamma pow() that GL4ES emits at the end of the
  // interaction FS:
  //   gl_FragColor.x = pow(dhewm3tmpres.x, ProgramEnv_21.w);
  //   gl_FragColor.y = pow(dhewm3tmpres.y, ProgramEnv_21.w);
  //   gl_FragColor.z = pow(dhewm3tmpres.z, ProgramEnv_21.w);
  //   gl_FragColor.w = dhewm3tmpres.w;
  // pow() with a non-integer exponent compiles to exp(log(x)*y) on Apple's
  // shader compiler, and log/exp are noisy on TBDR — different invocations of
  // the same fragment produce slightly different results, manifesting as
  // per-frame intensity drift. The gamma is already a no-op on this build
  // (SDL3 dropped SDL_SetWindowGammaRamp; CLAUDE.md confirms). Default ON;
  // disable with ?nopowfix for A/B.
  const enablePowFix    = !/[?&]nopowfix\b/.test(location.search);
  // Also strip the per-frame gamma color modulator `_gl4es_Fragment_ProgramEnv_21.xyz`
  // multiplied with the lit output. That uniform is DOOM 3's brightness/lightScale
  // RGB; if it drifts even sub-LSB per frame, every interaction draw multiplies the
  // whole framebuffer by a slightly different vec3 → whole-scene flicker. ?nogammuni
  // disables. Independent of pow fix (which kills the gamma exponent on .w).
  const enableGammaUniFix = !/[?&]nogammuni\b/.test(location.search);
  // Diagnostic: replace the entire interaction FS body with a constant output.
  // If per-frame variance still ~47%, bug is upstream (VS, varying interp,
  // texture-binding state) or downstream (blend hardware, draw scheduling).
  // If variance drops to ~6% (the r_skipInteractions floor), bug is in the
  // per-pixel math. Strictly diagnostic, off unless ?constfs requested.
  const enableConstFS   = /[?&]constfs\b/.test(location.search);
  // Force LOD 0 on every texture sample in the interaction FS. Apple TBDR
  // computes mip LOD from implicit derivatives (this fragment's UV minus its
  // neighbors), and neighbors are shaded in tile-dependent order — across
  // frames the LOD value drifts for the SAME geometric fragment. Pinning to
  // LOD 0 eliminates that noise path at the cost of some distant-surface
  // aliasing (acceptable for the wearable form factor). ?nolod0 disables.
  const enableLOD0      = /[?&]lod0\b/.test(location.search) && !/[?&]nolod0\b/.test(location.search);
  // Note on LOD0: tried adding `#extension GL_EXT_shader_texture_lod : enable`
  // + textureLodEXT calls — fails because WebKit doesn't expose that extension
  // on WebGL1 GLSL 100 shaders (even on a WebGL2 context). Kept for future.
  const GAMMA_UNI_RE = /clamp\(\s*_gl4es_Fragment_ProgramEnv_21\.xyz\s*\*\s*dhewm3tmpres\.xyz\s*,\s*0\.00000\s*,\s*1\.00000\s*\)/;
  if (!enableFalloff && !enablePrecision && !enableRewrite && !enableQuantize && !enablePowFix && !enableGammaUniFix && !enableConstFS && !enableLOD0 && !enableQuestFS && !enableNoCubeFS) return;
  window.__d3InteractionFSPatched = 0;
  window.__d3PowGammaStripped = 0;
  window.__d3GammaUniStripped = 0;
  window.__d3ConstFSReplaced = 0;
  window.__d3LOD0Applied = 0;
  window.__d3QuestFSReplaced = 0;
  window.__d3NoCubeFSReplaced = 0;
  const FALLOFF_RE = /texture2DProj\(\s*_gl4es_Sampler2D_2\s*,\s*_gl4es_TexCoord_2\s*\)/g;
  const SAMPLER_RE = /\b(uniform\s+)(sampler(?:2D|Cube|3D))\b/g;
  const wrap = (proto) => {
    if (!proto) return;
    const orig = proto.shaderSource;
    if (!orig || orig.__d3ShaderPatched) return;
    const patched = function (shader, source) {
      let s = source == null ? source : String(source);
      try {
        if (typeof s === "string") {
          const isInteractionFS = s.includes("localNormal.x = localNormal.w");
          // (1) Full rewrite of the interaction fragment shader body. Same
          // uniform/varying interface so GL4ES binding still works; cleaner math
          // (d3wasm-style clamp + pow specular + no in-shader gamma) eliminates
          // many precision-sensitive intermediate steps. Takes precedence over
          // the per-line patches below for this specific shader.
          if (enableConstFS && isInteractionFS) {
            const header = s.substring(0, s.indexOf("void main"));
            s = header + "void main() { gl_FragColor = vec4(0.5, 0.5, 0.5, 1.0); }\n";
            window.__d3ConstFSReplaced += 1;
          } else if ((enableQuestFS || enableNoCubeFS) && isInteractionFS) {
            // Body-only replacement. GL4ES emits many FS variants that all
            // contain "localNormal.x = localNormal.w" (any DXT5-NM unpack).
            // Only rewrite when the FS declares ALL of the varyings and
            // samplers our new body references. Otherwise leave the original
            // FS untouched — it'll keep the upstream noise but won't fail to
            // compile.
            const mainStart = s.indexOf("void main");
            // Full-spec interaction: bump + diffuse + specular + (cubemap or
            // not — for ?nocubefs we don't require the cubemap sampler).
            const isFullSpec =
              s.includes("_gl4es_TexCoord_0") && s.includes("_gl4es_TexCoord_1") &&
              s.includes("_gl4es_TexCoord_2") && s.includes("_gl4es_TexCoord_3") &&
              s.includes("_gl4es_TexCoord_4") && s.includes("_gl4es_TexCoord_5") &&
              s.includes("_gl4es_TexCoord_6") && s.includes("_gl4es_Sampler2D_1") &&
              s.includes("_gl4es_Sampler2D_2") && s.includes("_gl4es_Sampler2D_3") &&
              s.includes("_gl4es_Sampler2D_4") && s.includes("_gl4es_Sampler2D_5") &&
              s.includes("_gl4es_Sampler2D_6") &&
              (enableNoCubeFS || s.includes("_gl4es_SamplerCube_0"));
            const hasFrontColor = s.includes("_gl4es_FrontColor");
            const frontColorMul = hasFrontColor ? " * _gl4es_FrontColor" : "";
            // The L-vector path is the bug we're chasing: Apple Silicon GPUs
            // ignore one of three partial derivatives in cubemap textureGrad
            // (SPIRV-Cross commit 7ef52b0, MoltenVK #2068). textureCube uses
            // implicit derivatives but the same bug class manifests as
            // per-pixel intensity drift across frames. Quest-style direct
            // normalize() of the unpacked light-direction varying avoids the
            // entire cubemap codepath.
            const Lexpr = enableNoCubeFS
              ? "normalize(_gl4es_TexCoord_0.xyz * 2.0 - 1.0)"
              : "normalize(textureCube(_gl4es_SamplerCube_0, _gl4es_TexCoord_0.xyz).xyz * 2.0 - 1.0)";
            if (mainStart !== -1 && isFullSpec) {
              const newMain = `void main(void) {
\thighp vec3 L = ${Lexpr};
\thighp vec3 H = normalize(_gl4es_TexCoord_6.xyz);
\thighp vec3 N = normalize(texture2D(_gl4es_Sampler2D_1, _gl4es_TexCoord_1.xy).agb * 2.0 - 1.0);
\thighp float NdotL = clamp(dot(N, L), 0.0, 1.0);
\thighp float NdotH = clamp(dot(N, H), 0.0, 1.0);
\thighp vec3 lightProj = texture2DProj(_gl4es_Sampler2D_3, _gl4es_TexCoord_3).rgb;
\thighp float lightFall = texture2DProj(_gl4es_Sampler2D_2, _gl4es_TexCoord_2).w;
\thighp vec3 diffuse  = texture2D(_gl4es_Sampler2D_4, _gl4es_TexCoord_4.xy).rgb * _gl4es_Fragment_ProgramEnv_0.rgb;
\thighp vec3 specCurve = texture2D(_gl4es_Sampler2D_6, vec2(NdotH, 0.5)).rgb * _gl4es_Fragment_ProgramEnv_1.rgb;
\thighp vec3 specMap   = texture2D(_gl4es_Sampler2D_5, _gl4es_TexCoord_5.xy).rgb * 2.0;
\thighp vec3 color = (diffuse + specCurve * specMap) * NdotL * lightProj * lightFall;
\tgl_FragColor = vec4(color, 1.0)${frontColorMul};
}
`;
              s = s.substring(0, mainStart) + newMain;
              if (enableNoCubeFS) window.__d3NoCubeFSReplaced += 1;
              else                window.__d3QuestFSReplaced += 1;
            }
          } else if (enableRewrite && isInteractionFS) {
            s = REWRITTEN_INTERACTION_FS;
          } else {
            if (enablePrecision && /\buniform\s+sampler/.test(s) && !/\buniform\s+(?:highp|mediump|lowp)\s+sampler/.test(s)) {
              s = s.replace(SAMPLER_RE, "$1highp $2");
            }
            if (enableFalloff && isInteractionFS && FALLOFF_RE.test(s)) {
              FALLOFF_RE.lastIndex = 0;
              s = s.replace(FALLOFF_RE, "vec4(texture2DProj(_gl4es_Sampler2D_2, _gl4es_TexCoord_2).w)");
            }
            if (enablePowFix && isInteractionFS && POW_GAMMA_RE.test(s)) {
              s = s.replace(POW_GAMMA_RE, "gl_FragColor = dhewm3tmpres;");
              window.__d3PowGammaStripped += 1;
            }
            if (enableGammaUniFix && isInteractionFS && GAMMA_UNI_RE.test(s)) {
              s = s.replace(GAMMA_UNI_RE, "clamp(dhewm3tmpres.xyz, 0.00000, 1.00000)");
              window.__d3GammaUniStripped += 1;
            }
            if (enableLOD0 && isInteractionFS) {
              // Add #extension for texture2DLodEXT if absent
              if (!s.includes("GL_EXT_shader_texture_lod")) {
                s = s.replace(/(#version[^\n]*\n)?/, (m) =>
                  (m || "") + "#extension GL_EXT_shader_texture_lod : enable\n"
                );
              }
              // Rewrite each texture2D / texture2DProj / textureCube call to its
              // LOD-explicit equivalent at LOD 0. textureCube doesn't have a Lod
              // variant in EXT_shader_texture_lod (it's in EXT_shader_texture_lod
              // for cubes too actually — textureCubeLodEXT).
              const before = s.length;
              s = s.replace(/\btexture2DProj\s*\(/g, "texture2DProjLodEXT(LOD0_INSERT_");
              s = s.replace(/\btexture2D\s*\(/g, "texture2DLodEXT(LOD0_INSERT_");
              s = s.replace(/\btextureCube\s*\(/g, "textureCubeLodEXT(LOD0_INSERT_");
              // Now we need to add the `, 0.0` argument at the matching close
              // paren of each LOD0_INSERT_ marker. Walk through manually.
              s = s.replace(/LOD0_INSERT_/g, "");
              // Strategy: find each call site marker and insert `, 0.0` before
              // its matching `)`. Simpler: identify by name and do balanced-paren.
              s = injectLodArg(s, /\btexture2DLodEXT\s*\(/g);
              s = injectLodArg(s, /\btexture2DProjLodEXT\s*\(/g);
              s = injectLodArg(s, /\btextureCubeLodEXT\s*\(/g);
              if (s.length !== before) window.__d3LOD0Applied += 1;
            }
          }
          // (2) 8-bit quantization injection. Insert just before the final
          // closing `}` of main() so gl_FragColor (already assigned by the
          // shader's own code or REWRITTEN_INTERACTION_FS above) is snapped
          // to 8-bit precision before the GL pipeline does the additive blend.
          // Only the interaction FS — ambient pass and screenspace passes are
          // not the source of the dither per the bisect.
          if (enableQuantize && isInteractionFS) {
            const lastBrace = s.lastIndexOf("}");
            if (lastBrace > -1) {
              const inject = "  gl_FragColor.rgb = floor(gl_FragColor.rgb * 255.0 + 0.5) / 255.0;\n";
              s = s.substring(0, lastBrace) + inject + s.substring(lastBrace);
              window.__d3InteractionFSPatched += 1;
            }
          }
        }
      } catch (_) { /* never break the engine */ }
      return orig.call(this, shader, s);
    };
    patched.__d3ShaderPatched = true;
    proto.shaderSource = patched;
  };
  wrap(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
  wrap(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
})();

// JS-side mipmap kill: wrap glTexParameteri to convert any MIPMAP-based min
// filter to plain LINEAR / NEAREST. The engine cvar (image_lodbias etc.)
// didn't actually propagate to WebGL state. Mipmap LOD on Apple TBDR is
// computed from implicit derivatives of neighbor pixels — neighbors are
// tile-ordered, so the LOD value drifts per-frame for the same fragment.
// Opt-in via ?minfix.
(function fixMinFilter() {
  const enableMin = /[?&]minfix\b/.test(location.search);
  const enableAllNearest = /[?&]allnearest\b/.test(location.search);
  // Force min+mag filter to NEAREST on GL_TEXTURE_CUBE_MAP specifically.
  // Targets the Apple-Silicon cubemap-gradient bug (SPIRV-Cross 7ef52b0):
  // one of three partial derivatives is silently ignored. NEAREST sampling
  // bypasses the LINEAR-weighted neighbor averaging that the bug corrupts,
  // and removes the per-frame mip-selection noise on the cubemap. Visual
  // cost: hard-edged cube-face transitions on the normalization cubemap
  // (probably invisible since DOOM 3 reads it for a single texel per
  // fragment). ?cubenearest to enable.
  const enableCubeNearest = /[?&]cubenearest\b/.test(location.search);
  if (!enableMin && !enableAllNearest && !enableCubeNearest) return;
  window.__d3MinFilterStats = { coerced: 0, total: 0, cubeCoerced: 0, cubeSeen: 0 };
  const MIPMAP_FILTERS = new Set([
    0x2700, 0x2701, 0x2702, 0x2703
    // GL_NEAREST_MIPMAP_NEAREST, GL_LINEAR_MIPMAP_NEAREST,
    // GL_NEAREST_MIPMAP_LINEAR, GL_LINEAR_MIPMAP_LINEAR
  ]);
  const LINEAR_FILTERS = new Set([0x2601, ...MIPMAP_FILTERS]);
  const wrap = (proto) => {
    if (!proto || !proto.texParameteri || proto.texParameteri.__d3Min) return;
    const orig = proto.texParameteri;
    proto.texParameteri = function (target, pname, param) {
      window.__d3MinFilterStats.total += 1;
      const isCube = target === 0x8513 /*GL_TEXTURE_CUBE_MAP*/;
      if (isCube) window.__d3MinFilterStats.cubeSeen += 1;
      if (enableCubeNearest && isCube && (pname === 0x2801 /*MIN*/ || pname === 0x2800 /*MAG*/)) {
        window.__d3MinFilterStats.cubeCoerced += 1;
        return orig.call(this, target, pname, 0x2600 /*NEAREST*/);
      }
      if (enableAllNearest && (pname === 0x2801 || pname === 0x2800) && LINEAR_FILTERS.has(param)) {
        window.__d3MinFilterStats.coerced += 1;
        return orig.call(this, target, pname, 0x2600);
      }
      if (enableMin && pname === 0x2801 && MIPMAP_FILTERS.has(param)) {
        const coerced = (param === 0x2701 || param === 0x2703) ? 0x2601 /*LINEAR*/ : 0x2600 /*NEAREST*/;
        window.__d3MinFilterStats.coerced += 1;
        return orig.call(this, target, pname, coerced);
      }
      return orig.call(this, target, pname, param);
    };
    proto.texParameteri.__d3Min = true;
  };
  wrap(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
  wrap(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
})();

const glProbe = { ctx: 0, tex: 0, comp: 0, bytes: 0, maxDim: 0, oom: 0, err: 0, lost: false };
window.__d3GLProbe = glProbe;
(function instrumentWebGL() {
  // Escape hatch: ?noprobe disables the texImage2D wrap entirely (for A/B'ing
  // whether the instrumentation itself affects load/render).
  if (/[?&]noprobe\b/.test(location.search)) return;
  // The frame-px sampler requires preserveDrawingBuffer so the canvas backing
  // store stays readable after the swap. On iOS Safari that flag also changes
  // the WebGL swap path and produces visible ghosting / flicker during camera
  // motion, so it's OPT-IN now: only enabled when ?probe is in the URL. The diag
  // overlay still gets the caps + gpu-tex tally; only the frame-px line goes dark.
  const ENABLE_FRAME_PX = /[?&]probe\b/.test(location.search);
  // Kept in a closure (not on glProbe) so JSON.stringify(__d3GLProbe) stays clean.
  let probeGl = null;
  let probeCanvas = null;
  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (ENABLE_FRAME_PX && typeof type === "string" && /webgl/i.test(type)) {
      attrs = Object.assign({}, attrs, { preserveDrawingBuffer: true });
    }
    const gl = origGetContext.call(this, type, attrs);
    if (gl && typeof type === "string" && /webgl/i.test(type) && !gl.__d3probe) {
      probeCanvas = this;
      try { attach(gl); } catch (_) { /* diagnostics must NEVER break the engine */ }
    }
    return gl;
  };
  function attach(gl) {
    gl.__d3probe = true;
    glProbe.ctx += 1;
    probeGl = gl;
    // One-time GPU caps. A limit the iPhone has but the desktop doesn't would
    // explain a lit/shader path that only collapses on-device.
    try {
      const g = (e) => gl.getParameter(e);
      glInfo.push(
        `caps: maxTex ${g(gl.MAX_TEXTURE_SIZE)} texUnits ${g(gl.MAX_TEXTURE_IMAGE_UNITS)} ` +
          `vtxTex ${g(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS)} varying ${g(gl.MAX_VARYING_VECTORS)} ` +
          `fragU ${g(gl.MAX_FRAGMENT_UNIFORM_VECTORS)}`
      );
    } catch (_) {}
    // Tally only (no getError) in the hot path — getError forces a sync GPU stall
    // and the load issues thousands of uploads. Errors are polled on the timer.
    const origTexImage2D = gl.texImage2D;
    gl.texImage2D = function () {
      glProbe.tex += 1;
      const a = arguments;
      let w = 0;
      let h = 0;
      // texImage2D(target,level,ifmt,width,height,border,fmt,type,pixels) OR
      // texImage2D(target,level,ifmt,fmt,type,source) — read dims when present.
      if (typeof a[3] === "number" && typeof a[4] === "number") {
        w = a[3];
        h = a[4];
      } else {
        const src = a[a.length - 1];
        if (src && src.width) {
          w = src.width;
          h = src.height;
        }
      }
      if (w) {
        if (w > glProbe.maxDim) glProbe.maxDim = w;
        if (h > glProbe.maxDim) glProbe.maxDim = h;
        if (a[1] === 0) glProbe.bytes += w * h * 4; // RGBA8 estimate, base level
      }
      return origTexImage2D.apply(this, a);
    };
    if (gl.compressedTexImage2D) {
      const origCompressed = gl.compressedTexImage2D;
      gl.compressedTexImage2D = function () {
        glProbe.comp += 1;
        return origCompressed.apply(this, arguments);
      };
    }
  }
  let sampleCanvas = null;
  let sampleCtx = null;
  setInterval(() => {
    if (!glProbe.ctx) return;
    // One getError per tick (cheap) catches a persistent out-of-memory state
    // without stalling every upload.
    if (probeGl) {
      try {
        const e = probeGl.getError();
        if (e) {
          glProbe.err += 1;
          if (e === probeGl.OUT_OF_MEMORY) glProbe.oom += 1;
        }
      } catch (_) {}
    }
    glProbeLine =
      `gpu-tex: ${glProbe.tex} uploads ~${(glProbe.bytes / 1048576).toFixed(0)}MB, ` +
      `max ${glProbe.maxDim}px, comp ${glProbe.comp}, OOM ${glProbe.oom}, err ${glProbe.err}` +
      (glProbe.lost ? ", ⚠CTX-LOST" : "");
    // Sample the engine's rendered-frame brightness (the canvas backing store,
    // BEFORE the CSS brightness filter). avg ~ how lit the walls are; max ~ whether
    // the bright lights render. Near-black avg ⇒ the lit shader output is the
    // problem; dim-but-present avg ⇒ exposure/display. Only runs when ?probe is
    // set — preserveDrawingBuffer (required for readback) introduces motion
    // flicker on iOS Safari, so it must be opt-in for normal use.
    if (probeCanvas && ENABLE_FRAME_PX) {
      try {
        if (!sampleCanvas) {
          sampleCanvas = document.createElement("canvas");
          sampleCanvas.width = 24;
          sampleCanvas.height = 24;
          sampleCtx = sampleCanvas.getContext("2d", { willReadFrequently: true });
        }
        sampleCtx.drawImage(probeCanvas, 0, 0, 24, 24);
        const d = sampleCtx.getImageData(0, 0, 24, 24).data;
        let r = 0;
        let g = 0;
        let b = 0;
        let mx = 0;
        for (let i = 0; i < d.length; i += 4) {
          r += d[i];
          g += d[i + 1];
          b += d[i + 2];
          if (d[i] > mx) mx = d[i];
          if (d[i + 1] > mx) mx = d[i + 1];
          if (d[i + 2] > mx) mx = d[i + 2];
        }
        const n = d.length / 4;
        framePxLine = `frame-px: avg(${(r / n) | 0},${(g / n) | 0},${(b / n) | 0}) max ${mx}`;
      } catch (err) {
        framePxLine = `frame-px: (read failed: ${err && err.message ? err.message : err})`;
      }
    }
    renderDiag();
  }, 2000);
})();
refs.canvas.addEventListener("webglcontextlost", (e) => {
  glProbe.lost = true;
  diag("⚠ WEBGL CONTEXT LOST — almost certainly out of GPU memory");
  appendRuntimeLog("[gl] webglcontextlost");
}, false);
refs.canvas.addEventListener("webglcontextrestored", () => diag("gl: context restored"), false);
window.addEventListener("error", (e) => diag(`ERR: ${e.message} @ ${(e.filename || "").split("/").pop()}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => diag(`REJECT: ${(e.reason && (e.reason.message || e.reason)) || e.reason}`));

window.__d3AutoStart = true;
queueMicrotask(() => {
  start();
});

async function start() {
  if (booting || engine) {
    await headTracking?.start();
    return;
  }

  booting = true;
  setLoadingVisible(true);
  setLoadingProgress(4, "Starting");
  refs.statusText.textContent = "Starting engine...";

  try {
    engine = await bootDoom3({
      canvas: refs.canvas,
      output: null,
      status: refs.statusText,
      config: runtimeConfig,
      onProgress: ({ percent, label }) => {
        setLoadingProgress(percent, label);
        if (label) diagProgress(`${Math.round(percent)}% ${label}`);
      },
      onStatus: (text) => {
        refs.statusText.textContent = text;
        diag(`status: ${text}`);
      },
      onEnemyIndicators: setEnemyIndicators,
      onAutoFire: handleAutoFireStarted,
      onLog: handleRuntimeLog
    });

    headTracking = createHeadTracking({
      getEngine: () => engine,
      meter: refs.yawMeter,
      status: refs.imuStatus,
      tickMs: runtimeConfig.headTickMs,
      sensitivity: runtimeConfig.yawSensitivity,
      turnBurstDegrees: runtimeConfig.turnBurstDegrees
    });

    wearableInput = createWearableInput({
      getEngine: () => engine,
      onRecenter: () => headTracking.recenter(),
      onTurnBurst: (direction) => headTracking.addTurnBurst(direction),
      onFlashlightChange: (enabled) => {
        setFlashlightIndicator(enabled);
        // Iter 43: lowering the flashlight returns to the assault rifle
        // explicitly (the engine's own previous-weapon return can land on
        // the pistol/fists depending on what was held when the light was
        // first raised), then tops off the clip — the reload impulse is a
        // no-op on a full clip, so it only acts when ammo was spent.
        if (!enabled) {
          window.setTimeout(() => {
            tapKey(WEAPON_MACHINEGUN_KEY);
            window.setTimeout(() => tapKey(RELOAD_KEY), 800);  // no-op on a full clip
          }, 250);
        }
      }
    });

    wearableInput.install();
    wireMoveControls();
    wireTouchLook();
    wireFxPanel();
    // Show the on-screen movement pad on the touch/wearable profile (desktop has a
    // keyboard). It lives on the left so the right stays clear for head-aiming.
    if (runtimeConfig.inputMode === "wearable" && refs.moveControls) {
      refs.moveControls.hidden = false;
    }
    startEnemyIndicatorPolling();
    await startHeadTracking();
    refs.statusText.textContent = "Running";
    setLoadingProgress(92, "Starting map");
    scheduleLoadingHide(10000);
  } catch (error) {
    refs.statusText.textContent = error.message || String(error);
    appendRuntimeLog(`[app] ${refs.statusText.textContent}`);
    diag(`BOOT FAILED: ${refs.statusText.textContent}`);
    setLoadingProgress(100, "Error");
    setLoadingVisible(false);
  } finally {
    booting = false;
  }
}

async function startHeadTracking() {
  try {
    await headTracking.start();
  } catch (error) {
    const message = error.message || String(error);
    refs.imuStatus.textContent = message;
    appendRuntimeLog(`[imu] ${message}`);
  }
}

function appendRuntimeLog(text) {
  runtimeLogs.push(String(text));

  // Keep a generous scrollback so the full boot log (GL renderer, ARB program
  // load, map spawn, missing-asset warnings) stays inspectable on-device via
  // window.__d3Logs — turns a black phone into a readable diagnostic trace.
  if (runtimeLogs.length > 4000) {
    runtimeLogs.splice(0, runtimeLogs.length - 4000);
  }
}

function handleRuntimeLog(text) {
  appendRuntimeLog(text);

  // Capture the GL/renderer init lines into the pinned GL-diagnostics block (the
  // LIBGL report includes the GPU name and "high precision float in fragment shader
  // available" — the line that tells us if the iPhone GPU is underflowing lighting).
  if (/^LIBGL:|OpenGL (renderer|vendor|version)|ARB2 renderer|Will apply r_gamma|: END not found|program is invalid|shader.*not |Error compiling/i.test(text)) {
    glInfo.push(text.trim().slice(0, 118));
    if (glInfo.length > 60) glInfo.shift();
    updateGlDiag();
    renderDiag();
  }

  // Surface the engine's milestone/error lines on the on-device diagnostic.
  // (The r_gammaInShader gamma warning is intentionally NOT filtered now — it's a
  // real signal: it meant the brightness settings were being ignored.)
  if (/OpenGL renderer|Loaded pk4|gamma|brightness|ERROR|Error:|Warning:|Game [Mm]ap|Map Initialization|spawn|Missing main|context lost|out of memory|Aborted|alloc|memory|Init Game|interaction|shutdown/i.test(text)) {
    diag(text.trim().slice(0, 110));
  }

  if (/Found interface lib|idRenderSystem::Init|OpenGL Window/i.test(text)) {
    setLoadingProgress(82, "Loading renderer");
  } else if (/Loading game DLL|game_api|LoadGame/i.test(text)) {
    setLoadingProgress(88, "Loading game");
  } else if (/--- Common Initialization Complete ---/i.test(text)) {
    setLoadingProgress(94, "Starting map");
  } else if (/spawning server|--- Map Initialization ---/i.test(text)) {
    setLoadingProgress(100, "Ready");
    scheduleLoadingHide(400);
  }

  // "...N entities spawned, M inhibited" is the engine's last big map-load line —
  // the player exists and the game is about to tic. Arm the flashlight just after.
  if (/entities spawned/i.test(text)) {
    armAutoFlashlight();
    armCinematicShadowGuard();
    armSpawnLoadout();
  }
}

// DOOM 3 levels open in a deliberately dark transition room (an airlock/elevator),
// and this WebGL build has no working gamma to lift it (SDL3 dropped hardware gamma;
// the in-shader path is inert through GL4ES). The flashlight is the only way to see,
// so switch it on once shortly after the player spawns — the level opens lit instead
// of pitch black. Fires once; the player long-pinches to toggle it afterward.
function armAutoFlashlight() {
  if (autoFlashlightArmed || runtimeConfig.autoFlashlight === false) {
    return;
  }
  autoFlashlightArmed = true;
  // Small delay so the player has fully spawned and the first frames are ticking
  // before the latched toggle is sent (an impulse sent pre-spawn would be dropped).
  // Iter 34: ALSO wait out any intro cinematic (window.__d3InCinematic is
  // published by the engine's SetCamera) — a flashlight impulse sent during a
  // cinematic is swallowed, and the toggle landing mid-intro left the
  // fast-forwarded boot with a different flashlight state than a played one.
  const tryEnable = (attempt) => {
    if (!wearableInput || wearableInput.getState?.().flashlight) {
      return;
    }
    if (window.__d3InCinematic === 1 && attempt < 120) {
      window.setTimeout(() => tryEnable(attempt + 1), 1000);
      return;
    }
    wearableInput.toggleFlashlight();
    diag("flashlight: auto-enabled for the dark spawn room (long-pinch to toggle)");
  };
  window.setTimeout(() => tryEnable(0), 2600);
}

// Iter 43b: weapon select and reload ride the engine's default key binds
// (default.cfg: `bind 4 "_impulse3"` machinegun, `bind r "_impulse13"`
// reload) through the same synthetic key-event path the move pad uses —
// impulses are bind-layer only, the console rejects "_impulseN" and "use".
const WEAPON_MACHINEGUN_KEY = { key: "4", code: "Digit4", keyCode: 52 };
const RELOAD_KEY = { key: "r", code: "KeyR", keyCode: 82 };
function tapKey(k, holdMs = 90) {
  const fire = (type) => {
    for (const target of [window, document, refs.canvas]) {
      target.dispatchEvent(new KeyboardEvent(type, {
        key: k.key, code: k.code, keyCode: k.keyCode, which: k.keyCode,
        bubbles: true, cancelable: true
      }));
    }
  };
  fire("keydown");
  window.setTimeout(() => fire("keyup"), holdMs);
}

// Iter 43: spawn loadout — start with the assault rifle (machinegun)
// instead of the bare pistol. `give` is a direct console command (not an
// impulse), but the weapon auto-switch lands cleaner after the intro
// cinematic releases the camera, so wait it out like the flashlight does.
let spawnLoadoutArmed = false;
function armSpawnLoadout() {
  if (spawnLoadoutArmed) {
    return;
  }
  spawnLoadoutArmed = true;
  const tryGive = (attempt) => {
    if (typeof window.d3cmd !== "function" && attempt < 60) {
      window.setTimeout(() => tryGive(attempt + 1), 1000);
      return;
    }
    if (window.__d3InCinematic === 1 && attempt < 120) {
      window.setTimeout(() => tryGive(attempt + 1), 1000);
      return;
    }
    // Full classname required — `give machinegun` is "unknown item".
    window.d3cmd("give weapon_machinegun");
    window.setTimeout(() => tapKey(WEAPON_MACHINEGUN_KEY), 600);
    diag("loadout: assault rifle equipped");
  };
  window.setTimeout(() => tryGive(0), 3000);
}

// Iter 40: phone defense-in-depth. Cinematic flythroughs legitimately push
// 100+ shadow volumes per frame with a fast-moving camera, and the delta
// uploader has nothing to exploit while every volume changes — that staging
// spike is what kills the WebKit GPU process on iOS (crash showed shdw 221
// at the 82% boot cinematic). Park r_shadows while a cinematic plays on the
// wearable profile and restore it after; desktop keeps cutscene shadows.
let cinShadowGuardTimer = null;
function armCinematicShadowGuard() {
  if (runtimeConfig.inputMode !== "wearable") return;
  const qs = window.location.search;
  if (!/[?&]backend=webgpu\b/.test(qs) || /[?&]noshadows\b/.test(qs)) return;
  let parked = false;
  window.clearInterval(cinShadowGuardTimer);
  cinShadowGuardTimer = window.setInterval(() => {
    if (typeof window.d3cmd !== "function") return;
    const inCin = window.__d3InCinematic === 1;
    if (inCin && !parked) {
      parked = true;
      window.d3cmd("r_shadows 0");
      diag("shadows: parked during cinematic (wearable GPU budget)");
    } else if (!inCin && parked) {
      parked = false;
      window.d3cmd("r_shadows 1");
      diag("shadows: restored after cinematic");
    }
  }, 100);
}

function startEnemyIndicatorPolling() {
  window.clearInterval(enemyIndicatorTimer);
  enemyIndicatorTimer = window.setInterval(() => {
    setEnemyIndicators(engine?.readEnemyIndicators?.() ?? { left: false, right: false });
  }, 90);
}

function setEnemyIndicators({ left, right }) {
  enemyPresence.left = Boolean(left);
  enemyPresence.right = Boolean(right);
  refs.enemyLeftIndicator.classList.toggle("is-visible", enemyPresence.left);
  refs.enemyRightIndicator.classList.toggle("is-visible", enemyPresence.right);
}

function setFlashlightIndicator(on) {
  refs.flashlightIndicator.classList.toggle("is-on", Boolean(on));
}

// Iter 37: the chip is a tap-toggle (the only flashlight control on touch
// devices now that auto-enable is off — native-parity boots dark-corridor
// correct, and the player lights up on demand like in the native game).
refs.flashlightIndicator.addEventListener("click", (e) => {
  e.preventDefault();
  wearableInput?.toggleFlashlight();
});

function handleAutoFireStarted() {
  wearableInput?.setForward(false);
  headTracking?.setSensitivityScale(AUTO_FIRE_IMU_SENSITIVITY_SCALE);

  window.clearTimeout(autoFireSensitivityTimer);
  autoFireSensitivityTimer = window.setTimeout(() => {
    headTracking?.setSensitivityScale(1);
  }, AUTO_FIRE_SENSITIVITY_HOLD_MS);
}

function setLoadingProgress(percent, label) {
  if (typeof percent === "number") {
    loadingProgress = Math.max(loadingProgress, Math.min(100, Math.max(0, percent)));
    refs.loadingBar.style.width = `${loadingProgress}%`;
    refs.loadingProgress.setAttribute("aria-valuenow", String(Math.round(loadingProgress)));
  }

  if (label) {
    refs.loadingLabel.textContent = label;
  }
}

function setLoadingVisible(visible) {
  window.clearTimeout(loadingHideTimer);

  if (visible) {
    loadingProgress = 0;
    refs.loadingPanel.hidden = false;
    refs.loadingPanel.classList.remove("is-hidden");
    setLoadingProgress(0, "Loading");
    return;
  }

  refs.loadingPanel.classList.add("is-hidden");
}

function scheduleLoadingHide(delayMs) {
  window.clearTimeout(loadingHideTimer);
  loadingHideTimer = window.setTimeout(() => {
    setLoadingVisible(false);
  }, delayMs);
}
