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
  moveControls: document.querySelector("#moveControls")
};

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

refs.canvas.width = runtimeConfig.width;
refs.canvas.height = runtimeConfig.height;
refs.canvas.style.aspectRatio = `${runtimeConfig.width} / ${runtimeConfig.height}`;
refs.canvas.focus({ preventScroll: true });

// On-device diagnostics (the loading panel hides the canvas; this overlay stays
// on top so a black-screened phone still shows WHY). Reports the WebGL renderer
// + limits, any WebGL context loss (the classic iOS out-of-GPU-memory failure),
// and uncaught errors. Add ?nodiag to hide it.
const diagEl = document.querySelector("#diag");
const diagToggle = document.querySelector("#diagToggle");
const diagLines = [];
let diagProgLine = "";
// Lines are always collected so the "show log" button can reveal them even when
// the overlay started hidden (?nodiag). Visibility is just a CSS toggle.
let diagHidden = /[?&]nodiag\b/.test(location.search);
function applyDiagVisibility() {
  if (diagEl) diagEl.style.display = diagHidden ? "none" : "block";
  if (diagToggle) diagToggle.textContent = diagHidden ? "show log" : "hide log";
}
function renderDiag() {
  if (!diagEl || diagHidden) return;
  // Auto-follow the newest lines only when already at the bottom, so a manual
  // scroll-up (to read history) isn't yanked back down by new log lines.
  const atBottom = diagEl.scrollHeight - diagEl.scrollTop - diagEl.clientHeight < 48;
  diagEl.textContent = (diagProgLine ? diagLines.concat(`▸ ${diagProgLine}`) : diagLines).join("\n");
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
    wireMoveControls();
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
  window.setTimeout(() => {
    if (!wearableInput || wearableInput.getState?.().flashlight) {
      return;
    }
    wearableInput.toggleFlashlight();
    diag("flashlight: auto-enabled for the dark spawn room (long-pinch to toggle)");
  }, 2600);
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
