import "./styles.css";
import { createHeadTracking } from "./headTracking.js";
import { createRuntimeConfig, bootDoom3 } from "./d3Runtime.js";
import { createWearableInput } from "./wearableInput.js";

const app = document.querySelector("#app");
const runtimeConfig = createRuntimeConfig();

let engine = null;
let booting = false;
let headTracking = null;
let wearableInput = null;
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
    <div id="enemyLeftIndicator" class="enemy-indicator enemy-indicator-left" aria-hidden="true"></div>
    <div id="enemyRightIndicator" class="enemy-indicator enemy-indicator-right" aria-hidden="true"></div>
    <div id="flashlightIndicator" class="flashlight-indicator" aria-hidden="true">Flashlight</div>
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
    <div id="yawMeter" class="yaw-meter" data-zone="deadzone" aria-hidden="true"></div>
    <span id="statusText" class="runtime-hidden" aria-hidden="true"></span>
    <span id="imuStatus" class="runtime-hidden" aria-hidden="true"></span>
    <pre id="diag" style="position:fixed;left:4px;top:4px;right:4px;margin:0;z-index:9999;font:11px/1.35 ui-monospace,Menlo,monospace;color:#7fff7f;background:rgba(0,0,0,.66);padding:5px 6px;white-space:pre-wrap;word-break:break-word;pointer-events:none;max-height:46vh;overflow:hidden"></pre>
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
  imuStatus: document.querySelector("#imuStatus")
};

refs.canvas.width = runtimeConfig.width;
refs.canvas.height = runtimeConfig.height;
refs.canvas.style.aspectRatio = `${runtimeConfig.width} / ${runtimeConfig.height}`;
refs.canvas.focus({ preventScroll: true });

// On-device diagnostics (the loading panel hides the canvas; this overlay stays
// on top so a black-screened phone still shows WHY). Reports the WebGL renderer
// + limits, any WebGL context loss (the classic iOS out-of-GPU-memory failure),
// and uncaught errors. Add ?nodiag to hide it.
const diagEl = document.querySelector("#diag");
const diagLines = [];
let diagProgLine = "";
const showDiag = !/[?&]nodiag\b/.test(location.search);
function renderDiag() {
  if (!diagEl || !showDiag) return;
  diagEl.textContent = (diagProgLine ? diagLines.concat(`▸ ${diagProgLine}`) : diagLines).join("\n");
  // Keep the newest lines (errors land last) visible when the log overflows.
  diagEl.scrollTop = diagEl.scrollHeight;
}
function diag(line) {
  diagLines.push(line);
  if (diagLines.length > 24) diagLines.shift();
  renderDiag();
}
// Single in-place line for download/load progress (so it doesn't flood the log).
function diagProgress(line) {
  diagProgLine = line;
  renderDiag();
}
diag(`ua: ${navigator.userAgent.slice(0, 80)}`);
diag(`screen ${screen.width}x${screen.height} dpr${window.devicePixelRatio} canvas ${runtimeConfig.width}x${runtimeConfig.height} mode=${runtimeConfig.inputMode}`);
diag(`mem: deviceMemory=${navigator.deviceMemory ?? "?"}GB jsHeapLimit=${(performance.memory?.jsHeapSizeLimit / 1048576 | 0) || "?"}MB`);
// NOTE: do NOT call canvas.getContext() here — a canvas has a single WebGL
// context, and probing it would steal it from the engine (SDL3 creates its own).
// The engine logs its GL renderer ("OpenGL renderer: ...") to the runtime log.
refs.canvas.addEventListener("webglcontextlost", (e) => {
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
      onFlashlightChange: setFlashlightIndicator
    });

    wearableInput.install();
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

  if (runtimeLogs.length > 1500) {
    runtimeLogs.splice(0, runtimeLogs.length - 1500);
  }
}

function handleRuntimeLog(text) {
  appendRuntimeLog(text);

  // Surface the engine's milestone/error lines on the on-device diagnostic.
  // Exclude the repetitive r_gammaInShader warning — it floods the overlay.
  if (/adjust gamma or brightness/i.test(text)) {
    // skip noise
  } else if (/OpenGL renderer|Loaded pk4|ERROR|Error:|Warning:|Game [Mm]ap|Map Initialization|spawn|Missing main|context lost|out of memory|Aborted|alloc|memory|Init Game|interaction|shutdown/i.test(text)) {
    diag(text.trim().slice(0, 110));
  }

  if (/Found interface lib|idRenderSystem::Init|OpenGL Window/i.test(text)) {
    setLoadingProgress(82, "Loading renderer");
  } else if (/Loading game DLL|game_api|LoadGame/i.test(text)) {
    setLoadingProgress(88, "Loading game");
  } else if (/--- Common Initialization Complete ---/i.test(text)) {
    setLoadingProgress(94, "Starting map");
  } else if (/spawning server|mars_city1|--- Map Initialization ---/i.test(text)) {
    setLoadingProgress(100, "Ready");
    scheduleLoadingHide(400);
  }
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
