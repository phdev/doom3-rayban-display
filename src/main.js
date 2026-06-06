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
  glDiag: document.querySelector("#glDiag")
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
  refs.glDiag.textContent =
    `GPU: ${renderer}\nhighp FS: ${highp}   floatRT: ${floatRT}   halfRT: ${halfRT}\n` +
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
function buildDiagText() {
  const tail = diagProgLine ? diagLines.concat(`▸ ${diagProgLine}`) : diagLines;
  const head = [];
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
const glProbe = { ctx: 0, tex: 0, comp: 0, bytes: 0, maxDim: 0, oom: 0, err: 0, lost: false };
window.__d3GLProbe = glProbe;
(function instrumentWebGL() {
  // Escape hatch: ?noprobe disables the texImage2D wrap entirely (for A/B'ing
  // whether the instrumentation itself affects load/render).
  if (/[?&]noprobe\b/.test(location.search)) return;
  // Kept in a closure (not on glProbe) so JSON.stringify(__d3GLProbe) stays clean.
  let probeGl = null;
  let probeCanvas = null;
  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (typeof type === "string" && /webgl/i.test(type)) {
      // Force preserveDrawingBuffer so the rendered frame stays readable after the
      // swap — lets us sample the engine's actual output brightness (see interval).
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
    // problem; dim-but-present avg ⇒ exposure/display.
    if (probeCanvas) {
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
