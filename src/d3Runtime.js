import {
  clearCachedUrlPk4,
  readCachedUrlPk4,
  readPk4Bytes,
  saveCachedUrlPk4
} from "./storage.js";

const ENGINE_BASE = `${import.meta.env.BASE_URL}wasm/`;
// Per-build cache-buster for the fixed-name engine artifacts (dhewm3.js/.wasm/.data),
// which iOS Safari otherwise caches across deploys (so engine rebuilds never load).
// Injected by Vite (define); falls back to a constant in dev.
const ENGINE_VER = (typeof __ENGINE_VER__ !== "undefined") ? __ENGINE_VER__ : "dev";
const bustCache = (url) => `${url}${url.includes("?") ? "&" : "?"}v=${ENGINE_VER}`;
const BUNDLED_PK4_PATH = "base/pak-display.pk4";
const BUNDLED_PK4_URL = `${ENGINE_BASE}${BUNDLED_PK4_PATH}`;
const BUNDLED_PK4_GZIP_URL = `${BUNDLED_PK4_URL}.gz`;
const URL_PK4_PARAM = "pk4";
// Boot straight into the level so launch shows the rendered 3D world. The main
// menu currently draws black in the browser build with the reduced pak (the GUI
// device context + cursor render, but the main-menu page windows don't — under
// investigation), whereas an in-game map renders correctly. Override the map
// with ?args=+map <name>, or force the menu with ?args=+disconnect.
const D3_AUTO_MAP = true;
// Boots into DOOM 3's third level (game/admin): the progression is
// mars_city1 → mars_city2 → admin. The bundled pak is reduced for this map.
// Override with ?args=%2Bmap%20game/<name>.
const D3_DEFAULT_MAP = "game/mars_city1";
const TIMEOUTS = {
  probe: 15000,
  script: 20000,
  runtime: 45000,
  pk4: 420000
};
const PK4_FETCH_STALL_TIMEOUT_MS = 45000;
const PK4_FETCH_RETRY_DELAY_MS = 750;
const PK4_MANIFEST_TIMEOUT_MS = 8000;
// The game module is hard-linked into the monolithic wasm binary (HARDLINK_GAME),
// so there is no separate game.wasm to probe for.
const REQUIRED_ENGINE_FILES = [
  "dhewm3.js",
  "dhewm3.wasm",
  "dhewm3.data"
];

// dhewm3's Emscripten target emits files named after the CMake target, so no
// rename map is needed. Kept for parity with the upstream Quake II shell and to
// allow future engine builds that emit generic index.* artifacts.
const GENERATED_FILE_MAP = new Map();
let installedUrlPk4Href = null;

export function createRuntimeConfig() {
  var glassesDetected =
    /Android.*wv/.test(navigator.userAgent)
    || screen.width <= 640;

  // Render-at-Nx perceptual mask (didn't actually take effect — engine resets
  // canvas backing on SDL3 init regardless of our pre-boot setting). Kept as
  // an opt-in to revisit later.
  let renderScale = 1;
  try {
    const qs = window.location.search;
    if (/[?&]render4x\b/.test(qs)) renderScale = 4;
    else if (/[?&]render2x\b/.test(qs)) renderScale = 2;
  } catch {}

  const config = glassesDetected
    ? {
        // Low-memory profile (wearable / phone): smaller framebuffer and, more
        // importantly, a smaller engine texture cap — mobile Safari/WebGL runs
        // out of GPU memory uploading a full level's textures and drops the
        // context (3D goes black while the HUD survives). 448px render + a 128px
        // texture limit quarters the GPU texture memory vs 600/256.
        width: 448,
        height: 448,
        imageDownSizeLimit: 128,
        inputMode: "wearable",
        lowLatencyControls: true,
        audioEnabled: false,
        // Every DOOM 3 level opens in a deliberately dark transition room (an
        // airlock/elevator) and WebGL has no working gamma to lift it, so switch
        // the flashlight on automatically once the player spawns — the level opens
        // lit instead of pitch black. Long-pinch toggles it afterward.
        autoFlashlight: true,
        // With the WebKit lit-pass falloff fix (`main.js` fixFalloffSampling()),
        // the engine now lights the world correctly, so the wearable cvars are
        // reset to ~desktop values (they were cranked way up — lightScale 6, gamma
        // 2, brightness 1.4, CSS 1.35× — to compensate for the dark engine output;
        // with the fix in place those settings overcooked the scene to look washed-
        // out on the actual iPhone). A small CSS multiply (1.15) brings the dim
        // base lighting up for the small phone screen without blowing out fixtures.
        // Live-tune via ?dbright= / ?dcontrast= / ?dsat=.
        displayBrightness: 1.15,
        displayContrast: 1.0,
        displaySaturate: 1.05,
        rLightScale: 2,
        rGamma: 1.1,
        rBrightness: 1.0,
        skill: 1,
        yawSensitivity: 2.4,
        turnBurstDegrees: 42,
        headTickMs: 50
      }
    : {
        width: 600,
        height: 600,
        imageDownSizeLimit: 256,
        inputMode: "desktop",
        lowLatencyControls: false,
        audioEnabled: false,
        autoFlashlight: true,
        displayBrightness: 1,
        displayContrast: 1,
        displaySaturate: 1,
        rLightScale: 2,
        rGamma: 1.1,
        rBrightness: 1,
        skill: 1,
        yawSensitivity: 1.8,
        turnBurstDegrees: 36,
        headTickMs: 50
      };

  // ?audio: opt-in sound (compiled in but disabled since day one — the
  // async sound thread doesn't exist on WASM; com_asyncSound 0 runs the
  // sound update synchronously on the main loop instead).
  try {
    if (/[?&]audio\b/.test(typeof window !== "undefined" ? window.location.search : "")) {
      config.audioEnabled = true;
    }
  } catch {}

  // WebGPU-primary sharpening: the 448px wearable cap dates from GL-era GPU
  // memory pressure. With WebGPU rendering the scene (GL draws skipped),
  // the framebuffer can afford 640px — visibly sharper on the iPhone at
  // negligible GPU cost (the WASM game loop, not the GPU, bounds the fps).
  // ?render2x/?render4x still override; ?lowres keeps the old 448.
  try {
    const qs2 = typeof window !== "undefined" ? window.location.search : "";
    const webgpuPrimary = /[?&]backend=webgpu\b/.test(qs2) && !/[?&]echo\b/.test(qs2);
    if (webgpuPrimary && renderScale === 1 && config.width < 640 && !/[?&]lowres\b/.test(qs2)) {
      config.width = 640;
      config.height = 640;
    }
  } catch {}

  if (renderScale > 1) {
    config.width = Math.round(config.width * renderScale);
    config.height = Math.round(config.height * renderScale);
    config.renderScale = renderScale;
  }

  // Pre-boot override for image_downSizeLimit (texture upload cap). The
  // wearable profile defaults to 128 which on the iPhone produces visibly
  // chunky walls in the Web Inspector GPU trace (draw call #3,183 chunky
  // surface, 128x128 texture stretched over a screen-space ~200px wall).
  // ?dsl=N overrides; matching ?dslbump=N for the bump-map cap. dsl=0
  // disables downsizing entirely. Restart required (URL reload, not
  // vid_restart — runtime cvar change doesn't reload already-uploaded
  // textures in this build).
  try {
    const qs = window.location.search;
    const dslMatch = /[?&]dsl=(\d+)\b/.exec(qs);
    const bumpMatch = /[?&]dslbump=(\d+)\b/.exec(qs);
    if (dslMatch) {
      const v = Number(dslMatch[1]);
      if (Number.isFinite(v) && v >= 0) config.imageDownSizeLimit = v;
    }
    if (bumpMatch) {
      const v = Number(bumpMatch[1]);
      if (Number.isFinite(v) && v >= 0) config.imageDownSizeBumpLimit = v;
    }
  } catch {}

  try { window.__d3RuntimeConfig = config; } catch {}
  return config;
}

function applyDisplayTuning(canvas, config) {
  // The iPhone's in-shader gamma is dead, so the lit world renders near-black and a
  // brightness() multiply can't lift it. contrast() BELOW 1 raises the black floor,
  // which reveals the dim walls; brightness() then scales the whole frame. Both are
  // native CSS filters (reliable on iOS, unlike an SVG gamma url()). Each is live-
  // tunable on-device via a query param so brightness can be calibrated without a
  // redeploy: ?dbright= , ?dcontrast= , ?dsat=
  let params = null;
  try {
    params = new URLSearchParams(window.location.search);
  } catch {}
  const tuned = (param, key, fallback) => {
    const override = params && params.get(param);
    if (override !== null && override !== undefined && Number.isFinite(Number(override))) {
      return Number(override);
    }
    return getNumericConfig(config[key], fallback);
  };
  canvas.style.setProperty("--d3-display-brightness", String(tuned("dbright", "displayBrightness", 1)));
  canvas.style.setProperty("--d3-display-contrast", String(tuned("dcontrast", "displayContrast", 1)));
  canvas.style.setProperty("--d3-display-saturate", String(tuned("dsat", "displaySaturate", 1)));
  // Perceptual mask: CSS blur to smooth per-frame FP non-determinism (the iPhone
  // tile flicker in the additive lit pass). Live-tune via ?dblur= (px).
  const blur = params && params.get("dblur");
  if (blur !== null && blur !== undefined && Number.isFinite(Number(blur))) {
    canvas.style.setProperty("--d3-display-blur", `${Number(blur)}px`);
  }
}

function getNumericConfig(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export async function probeEngineArtifacts() {
  const checks = await Promise.all(
    REQUIRED_ENGINE_FILES.map(async (file) => {
      try {
        const response = await fetch(`${ENGINE_BASE}${file}`, {
          method: "HEAD",
          cache: "no-store"
        });
        return [file, response.ok];
      } catch {
        return [file, false];
      }
    })
  );

  return checks
    .filter(([, ok]) => !ok)
    .map(([file]) => file);
}

export async function probeBundledPk4() {
  try {
    const gzipResponse = await fetch(BUNDLED_PK4_GZIP_URL, {
      method: "HEAD",
      cache: "no-store"
    });

    if (gzipResponse.ok) {
      return {
        name: "Compressed display pak-display.pk4",
        size: Number(gzipResponse.headers.get("content-length") || 0),
        url: BUNDLED_PK4_GZIP_URL
      };
    }

    const response = await fetch(BUNDLED_PK4_URL, {
      method: "HEAD",
      cache: "no-store"
    });

    if (!response.ok) {
      return null;
    }

    return {
      name: "Display pak-display.pk4",
      size: Number(response.headers.get("content-length") || 0),
      url: BUNDLED_PK4_URL
    };
  } catch {
    return null;
  }
}

export async function bootDoom3({
  canvas,
  output,
  status,
  config,
  onEnemyIndicators,
  onAutoFire,
  onProgress,
  onStatus,
  onLog
}) {
  const log = (text) => bootLog(output, text, onLog);
  const progress = (percent, label) => onProgress?.({ percent, label });

  try {
    progress(2, "Checking files");
    log("Checking engine artifacts...");
    const missing = await withTimeout(
      probeEngineArtifacts(),
      TIMEOUTS.probe,
      "engine artifact check"
    );

    if (missing.length > 0) {
      throw new Error(`Missing engine artifact: ${missing.join(", ")}`);
    }

    canvas.width = config.width;
    canvas.height = config.height;
    canvas.style.aspectRatio = `${config.width} / ${config.height}`;
    applyDisplayTuning(canvas, config);
    log(`Canvas configured at ${config.width}x${config.height} for ${config.inputMode}`);

    progress(16, "Loading engine");
    const module = createModule({
      canvas,
      output,
      status,
      config,
      progress,
      onEnemyIndicators,
      onAutoFire,
      onStatus,
      onLog
    });
    const runtimeReady = new Promise((resolve, reject) => {
      module.onRuntimeInitialized = () => resolve();
      module.onAbort = (reason) => reject(new Error(String(reason || "DOOM 3 aborted")));
    });
    // Phase 5: pre-acquire a WGPU adapter+device on the JS side and hand it
    // to the WASM via Module.preinitializedWebGPUDevice. The engine's
    // RenderBackend_WebGPU::Init grabs it synchronously via
    // emscripten_webgpu_get_device(). This sidesteps async-device-acquisition
    // architecture changes inside the engine. Failures are silent — engine
    // still boots, just falls back to GL backend if r_backend "webgpu" was
    // requested.
    let webgpuAcquired = false;
    if (navigator.gpu) {
      try {
        const adapter = await navigator.gpu.requestAdapter();
        if (adapter) {
          const device = await adapter.requestDevice();
          module.preinitializedWebGPUDevice = device;
          webgpuAcquired = true;
          log(`WebGPU device pre-acquired (${(device.label || adapter.info?.vendor || "anon")})`);
          // Device loss (iOS backgrounding, GPU reset) is unrecoverable
          // mid-run — the WASM engine holds raw handles. Surface it loudly
          // so a black canvas has an explanation and a fix (reload).
          device.lost.then((info) => {
            log(`WebGPU DEVICE LOST (${info.reason}): ${info.message} — reload the page`);
            console.error("[d3] WebGPU device lost:", info.reason, info.message);
          });
        } else {
          log("WebGPU adapter request returned null; engine will use GL");
        }
      } catch (e) {
        log(`WebGPU pre-acquire failed: ${e.message ?? e}`);
      }
    } else {
      log("navigator.gpu unavailable; engine will use GL");
    }
    // If the URL asked for r_backend=webgpu but we couldn't acquire a device,
    // demote r_backend to "gl" so the engine doesn't call
    // emscripten_webgpu_get_device() and crash on a null device.queue access
    // (emdawnwebgpu's importJsDevice trusts preinitializedWebGPUDevice exists).
    if (!webgpuAcquired && Array.isArray(module.arguments)) {
      for (let i = 0; i + 2 < module.arguments.length; ++i) {
        if (module.arguments[i] === "+set" &&
            module.arguments[i + 1] === "r_backend" &&
            module.arguments[i + 2] === "webgpu") {
          module.arguments[i + 2] = "gl";
          log("Forced r_backend=gl (no WebGPU device available)");
          break;
        }
      }
    }
    window.Module = module;

    log("Loading engine script...");
    await withTimeout(loadScript(bustCache(`${ENGINE_BASE}dhewm3.js`)), TIMEOUTS.script, "engine script load");

    progress(28, "Preparing runtime");
    log("Waiting for WebAssembly runtime...");
    await withTimeout(runtimeReady, TIMEOUTS.runtime, "WebAssembly runtime initialization");
    progress(42, "Runtime ready");
    log("Runtime initialized");

    if (isRuntimeFS(module.FS)) {
      progress(48, "Loading data");
      log("Installing PK4 data...");
      await withTimeout(
        installPk4Data(module.FS, onStatus, {
          writablePath: false,
          progress,
          log
        }),
        TIMEOUTS.pk4,
        "PK4 install"
      );

      progress(72, "Configuring");
      installRuntimeConfig(module.FS, config, log);
    } else {
      progress(72, "Configuring");
      log("Runtime filesystem is not exposed yet; deferring PK4 install");
    }

    if (typeof module.callMain !== "function") {
      throw new Error("DOOM 3 runtime did not expose callMain");
    }

    progress(78, "Starting engine");
    log("Starting DOOM 3 main...");
    module.callMain([...module.arguments]);
    progress(82, "Starting DOOM 3");
    log("DOOM 3 main started");

    // Live console-command hook for on-device renderer tuning, callable from the
    // app or straight from the Safari Web Inspector console, e.g.:
    //   d3cmd("r_lightScale 20"); d3cmd("r_gamma 3"); d3cmd("reloadARBprograms")
    // Backed by the engine's D3_ExecCommand export (runs the command next frame).
    const execCommand = (cmd) => {
      try {
        if (typeof module.ccall === "function") {
          module.ccall("D3_ExecCommand", null, ["string"], [String(cmd)]);
          return true;
        }
      } catch (error) {
        console.warn("d3cmd failed:", error);
      }
      return false;
    };
    window.d3cmd = execCommand;

    return {
      module,
      execCommand,
      callAddViewAngles(dyaw, dpitch) {
        if (typeof module._D3_AddViewAngles === "function") {
          module._D3_AddViewAngles(dyaw, dpitch);
        }
      },
      setWearableAction(action, down) {
        if (typeof module._D3_SetWearableAction === "function") {
          module._D3_SetWearableAction(action, down ? 1 : 0);
        }
      },
      readEnemyIndicators() {
        if (typeof module._D3_GetEnemyIndicators === "function") {
          const mask = module._D3_GetEnemyIndicators();
          return {
            left: Boolean(mask & 1),
            right: Boolean(mask & 2)
          };
        }

        return {
          left: Boolean(module.d3EnemyIndicators?.left),
          right: Boolean(module.d3EnemyIndicators?.right)
        };
      },
      requestEnemyTurn(direction) {
        const normalized = direction < 0 ? -1 : direction > 0 ? 1 : 0;
        if (typeof module._D3_RequestEnemyTurn === "function") {
          module._D3_RequestEnemyTurn(normalized);
          return;
        }

        module.d3EnemyTurnRequest = normalized;
      }
    };
  } catch (error) {
    log(`Error: ${formatError(error)}`);
    // WASM traps (RuntimeError: null function / table index out of bounds)
    // carry the wasm frame list in .stack — with a --profiling-funcs build the
    // frames are NAMED, which is how the ROQ crash was found. Surface it in
    // the boot log so on-device (diag overlay) traps are diagnosable too.
    if (error?.stack && /wasm|RuntimeError/i.test(error.stack)) {
      for (const line of String(error.stack).split("\n").slice(0, 16)) {
        log(`  ${line}`);
      }
    }
    throw error;
  }
}

function createModule({
  canvas,
  output,
  status,
  config,
  progress,
  onEnemyIndicators,
  onAutoFire,
  onStatus,
  onLog
}) {
  return {
    _canLockPointer: false,
    canvas,
    d3EnemyTurnRequest: 0,
    d3EnemyIndicators: { left: false, right: false },
    d3ConsumeEnemyTurn() {
      const direction = this.d3EnemyTurnRequest;
      this.d3EnemyTurnRequest = 0;
      return direction;
    },
    d3SetEnemyIndicators(left, right) {
      this.d3EnemyIndicators = {
        left: Boolean(left),
        right: Boolean(right)
      };
      onEnemyIndicators?.({
        left: Boolean(left),
        right: Boolean(right)
      });
    },
    d3AutoFireStarted() {
      onAutoFire?.();
    },
    d3TurnToEnemyYaw(yaw) {
      if (typeof this._D3_SetViewYaw === "function") {
        this._D3_SetViewYaw(yaw);
      }
    },
    print(text) {
      appendOutput(output, text);
      onLog?.(text);
    },
    printErr(text) {
      appendOutput(output, text);
      onLog?.(text);
    },
    locateFile(path) {
      return bustCache(`${ENGINE_BASE}${GENERATED_FILE_MAP.get(path) ?? path}`);
    },
    setStatus(text) {
      if (status) {
        status.textContent = text || "Running";
      }
      onStatus?.(text || "Running");
    },
    hideConsole() {
      canvas.classList.add("is-running");
    },
    showConsole() {
      canvas.classList.remove("is-running");
    },
    winResized() {},
    setGamma(value) {
      const gamma = getNumericConfig(value, -1);
      const displayBrightness = getNumericConfig(config.displayBrightness, 1);
      const gammaBrightness = gamma < 0 ? 1 : gamma * 2;
      canvas.style.setProperty("--d3-display-brightness", String(displayBrightness * gammaBrightness));
    },
    captureMouse() {},
    d3InstallPendingData: async (FS) => {
      const log = (text) => bootLog(output, text, onLog);
      progress?.(48, "Loading data");
      await installPk4Data(FS, onStatus, { progress, log });
      progress?.(72, "Configuring");
      installRuntimeConfig(FS, config, log, { writablePath: true });
    },
    noInitialRun: true,
    totalDependencies: 0,
    monitorRunDependencies(left) {
      this.totalDependencies = Math.max(this.totalDependencies, left);
      this.setStatus(
        left
          ? `Preparing ${this.totalDependencies - left}/${this.totalDependencies}`
          : "Ready"
      );
    },
    arguments: buildArguments(config)
  };
}

function buildArguments(config) {
  const args = [
    "+set", "r_fullscreen", "0",
    "+set", "r_mode", "-1",
    "+set", "r_customWidth", String(config.width),
    "+set", "r_customHeight", String(config.height),
    "+set", "r_aspectRatio", "0",
    "+set", "r_multiSamples", "0",
    // Phase 5: pick which RenderBackend to instantiate at engine boot.
    // ?backend=webgpu selects the WebGPU backend (requires navigator.gpu).
    // Default "gl" keeps the existing pass-through wrapper.
    "+set", "r_backend",
        /[?&]backend=webgpu\b/.test(typeof window !== "undefined" ? window.location.search : "")
            ? "webgpu" : "gl",
    // Cutover default: when WebGPU is the primary display (i.e. webgpu
    // backend without &echo), skip the GL draw calls entirely (lightgem
    // excepted — see r_skipGLDraw).
    "+set", "r_skipGLDraw",
        (/[?&]backend=webgpu\b/.test(typeof window !== "undefined" ? window.location.search : "")
         && !/[?&]echo\b/.test(typeof window !== "undefined" ? window.location.search : ""))
            ? "1" : "0",
    "+set", "r_gamma", String(getNumericConfig(config.rGamma, 1.1)),
    "+set", "r_brightness", String(getNumericConfig(config.rBrightness, 1)),
    // Multiply every light's intensity (default 2). On a dark, enclosed map like
    // admin's elevator this lifts the dimly-lit walls; it runs in the core
    // interaction path so it works through GL4ES regardless of the gamma shader.
    "+set", "r_lightScale", String(getNumericConfig(config.rLightScale, 2)),
    "+set", "com_skipIntroVideos", "1",
    // Auto fast-forward in-game cinematics (mars_city1 opens with one). There is no
    // ESC key on a touchscreen to skip them and they render poorly with the reduced
    // data set; see the engine patch (idGameLocal::SetCamera, g_skipCinematics).
    "+set", "g_skipCinematics", "1",
    "+set", "com_showFPS", "0",
    "+set", "s_noSound", config.audioEnabled ? "0" : "1",
    // Audio-only cvars. ROOT CAUSE of the 2026-06-10 "null function at boot"
    // (initially blamed on sound state): idTech4's ParseCommandLine had NO
    // bounds check on its 32-slot console-line array, and this list sits at
    // the limit — two extra "+set"s overflowed it and stomped the console
    // object. The engine patch now bounds-checks (and the cap is 64), so
    // extra args are safe; keeping these conditional is just tidiness.
    ...(config.audioEnabled ? ["+set", "com_asyncSound", "0", "+set", "s_useEAXReverb", "0"] : []),

    "+set", "g_skill", String(getNumericConfig(config.skill, 1)),
    // The wearable drives the camera through _D3_AddViewAngles, so disable the
    // engine's own pointer-lock mouse path.
    "+set", "in_mouse", "0",
    // CRITICAL: terminal/stdin console input blocks forever in the browser
    // (Sys_ConsoleInput reads a tty that never delivers). Disable it.
    "+set", "in_tty", "0",
    "+set", "g_showPlayerShadow", "0",
    // The shell mounts PK4 + config under /base in the Emscripten FS; point the
    // engine's base path there (default would be the executable dir).
    "+set", "fs_basepath", "/",
    "+set", "fs_savepath", "/save",
    // Performance defaults for a software/WebGL renderer on a wearable: stencil
    // shadows are the single biggest cost in DOOM 3, so disable them, run the
    // low machine spec, and downsize textures for faster uploads.
    "+set", "com_machineSpec", "0",
    "+set", "r_shadows", "0",
    // Skip ROQ cinematic decoding. The RoQ decoder calls a null function pointer
    // in this WASM build (idCinematicLocal::ImageForTime, reached from
    // RB_BindVariableStageImage when a surface has a video texture), which traps
    // the whole render loop and blacks the screen the moment any cinematic
    // surface is in view. With this set, ImageForTime returns empty early and the
    // renderer binds a black image for those surfaces — the rest of the scene
    // renders. (This is also why the menu's animated logo panel shows a
    // placeholder.) See README "Limitations".
    "+set", "r_skipROQ", "1",
    // Skip the _currentRender postprocess pass (heat-haze, refraction effects).
    // The iPhone Instruments Metal trace showed ~12,564 Blit Command encoders
    // per 7s recording = ~1,800/sec — almost all of them are the per-surface
    // glCopyTexImage2D into _currentRender that heat-haze materials sample.
    // Each blit is its own Metal command buffer in WebKit's WebGL→Metal path
    // (no batching), adding massive submission overhead. r_skipPostProcess 1
    // discards both the framebuffer copy AND the heat-haze surface itself
    // (the surface is auto-sorted to SS_POST_PROCESS when it references
    // _currentRender per Material.cpp:2223). Net effect: massive WebKit GPU
    // pressure drop, slightly-flat-looking heat sources (no waver behind hot
    // pipes/vents). ?heathaze re-enables for A/B.
    "+set", "r_skipPostProcess",
        (/[?&]heathaze\b/.test(typeof window !== "undefined" ? window.location.search : "")) ? "0" : "1",
    // image_downSize=0 disables the downsize pass entirely (full-resolution
    // texture uploads). Set when ?dsl=0 explicitly chosen via runtime config.
    "+set", "image_downSize", config.imageDownSizeLimit === 0 ? "0" : "1",
    "+set", "image_downSizeLimit", String(getNumericConfig(config.imageDownSizeLimit, 256)),
    "+set", "image_downSizeBump", config.imageDownSizeBumpLimit === 0 ? "0" : "1",
    "+set", "image_downSizeBumpLimit", String(getNumericConfig(config.imageDownSizeBumpLimit || config.imageDownSizeLimit, 256)),
    // Load textures synchronously: the single-threaded browser build has no
    // background worker, and the cached path would block forever waiting on it.
    "+set", "image_useCache", "0",
    // Apply r_gamma/r_brightness in the present SHADER. The default path (0) uses
    // the hardware gamma ramp, which does not exist under WebGL/Emscripten (SDL3
    // has no hardware gamma), so r_gamma/r_brightness were silently ignored and
    // dark levels (e.g. admin's elevator) stayed near-black. In-shader gamma works
    // in WebGL, so the brightness settings actually take effect.
    "+set", "r_gammaInShader", "1"
  ];

  const queryArgs = new URLSearchParams(window.location.search).get("args");
  const extraArgs = queryArgs ? queryArgs.trim().split(/\s+/).filter(Boolean) : [];

  args.push(...extraArgs);

  // Boot straight into the level (D3_AUTO_MAP) so launch renders the 3D world.
  // Pass ?args=%2Bmap%20<name> to choose a different map (overrides the default).
  if (!hasStartupCommand(extraArgs) && D3_AUTO_MAP) {
    args.push("+map", D3_DEFAULT_MAP);
  }

  return args;
}

function hasStartupCommand(args) {
  const commands = new Set(["+map", "+devmap", "+connect", "+loadgame"]);
  return args.some((arg) => commands.has(arg.toLowerCase()));
}

function installRuntimeConfig(FS, config, log, options = {}) {
  const autoexecConfig = buildAutoexecConfig(config);

  mkdirTree(FS, "/base");
  FS.writeFile("/base/autoexec.cfg", autoexecConfig);

  // The flashlight view model carries effect surfaces (beam1/flare/flare2/bulb)
  // that the game data never defines a material for, so the engine builds an
  // implicit OPAQUE material from each texture and the light-beam billboard renders
  // as a solid white quad stuck to the flashlight. Ship an explicit material decl
  // for each so the engine uses it instead of the implicit one — additive _black is
  // a no-op blend that hides the cosmetic surface (the real illumination comes from
  // the projected flashlight light, not these view-model surfaces). Loaded as a
  // loose materials/*.mtr the engine's decl scan picks up alongside the pak.
  mkdirTree(FS, "/base/materials");
  FS.writeFile("/base/materials/zz_flashlight_fix.mtr", FLASHLIGHT_FIX_MTR);

  if (options.writablePath) {
    mkdirTree(FS, "/dhewm3/base");
    FS.writeFile("/dhewm3/base/autoexec.cfg", autoexecConfig);
    mkdirTree(FS, "/dhewm3/base/materials");
    FS.writeFile("/dhewm3/base/materials/zz_flashlight_fix.mtr", FLASHLIGHT_FIX_MTR);
  }

  log(`Installed runtime config (${config.width}x${config.height})`);
}

const FLASHLIGHT_FIX_MTR = [
  "// Hide the flashlight view-model effect surfaces that have no material in the",
  "// game data (the engine would otherwise render them as opaque white quads).",
  "models/items/flashlight/beam1  { noShadows noSelfShadow translucent { blend add map _black } }",
  "models/items/flashlight/flare  { noShadows noSelfShadow translucent { blend add map _black } }",
  "models/items/flashlight/flare2 { noShadows noSelfShadow translucent { blend add map _black } }",
  "models/items/flashlight/bulb   { noShadows noSelfShadow translucent { blend add map _black } }",
  ""
].join("\n");

function buildAutoexecConfig(config) {
  return [
    "// DOOM 3 Display runtime configuration (auto-executed by id Tech 4)",
    "seta com_skipIntroVideos \"1\"",
    "seta g_skipCinematics \"1\"",
    "seta sys_lang \"english\"",
    "seta s_volume_dB \"-40\"",
    "seta r_fullscreen \"0\"",
    `seta r_customWidth "${config.width}"`,
    `seta r_customHeight "${config.height}"`,
    "seta r_mode \"-1\"",
    "seta r_aspectRatio \"0\"",
    "seta r_swapInterval \"0\"",
    `seta r_gamma "${getNumericConfig(config.rGamma, 1.1)}"`,
    `seta r_brightness "${getNumericConfig(config.rBrightness, 1)}"`,
    `seta r_lightScale "${getNumericConfig(config.rLightScale, 2)}"`,
    "seta r_skipBump \"0\"",
    "seta image_downSize \"1\"",
    "seta image_useCompression \"1\"",
    `seta g_skill "${getNumericConfig(config.skill, 1)}"`,
    "seta in_mouse \"0\"",
    "seta in_alwaysRun \"0\"",
    // r_gammaInShader is set in buildArguments (default 1), intentionally NOT pinned
    // here so it can be A/B-tested on-device via ?args=%2Bset%20r_gammaInShader%200
    // (autoexec runs after the command line and would otherwise override it).
    // Skip ROQ video decoding — the WASM RoQ decoder traps on a null function
    // pointer and blacks the whole frame; see buildArguments() / README.
    "seta r_skipROQ \"1\"",
    "bind \"w\" \"_forward\"",
    "bind \"s\" \"_back\"",
    "bind \"a\" \"_moveleft\"",
    "bind \"d\" \"_moveright\"",
    // On a touchscreen SDL maps a tap to the left mouse button, so the default
    // MOUSE1 -> _attack bind made every tap swing the fists. Clear the mouse binds
    // on the wearable/mobile profile (attack is the wearable action / on-screen
    // button instead); keep them on desktop where there's a real mouse.
    config.inputMode === "wearable" ? "unbind \"mouse1\"" : "bind \"MOUSE1\" \"_attack\"",
    config.inputMode === "wearable" ? "unbind \"mouse2\"" : "bind \"MOUSE2\" \"_forward\"",
    "bind \"SPACE\" \"_moveup\"",
    "bind \"CTRL\" \"_movedown\"",
    "bind \"e\" \"_use\"",
    "bind \"f\" \"_impulse11\"",
    "echo \"Display runtime config loaded\"",
    ""
  ].join("\n");
}

async function installPk4Data(FS, onStatus, options = {}) {
  const settings = {
    writablePath: true,
    progress: null,
    log: null,
    ...options
  };
  const urlPk4Source = getUrlPk4Source();
  if (urlPk4Source) {
    if (installedUrlPk4Href === urlPk4Source.url && fileExists(FS, "/base/pak-display.pk4")) {
      settings.progress?.(68, "PK4 ready");
      onStatus?.("URL PK4 ready");
      settings.log?.("URL PK4 is already mounted");
      return;
    }

    const cachedUrlBytes = await readCachedUrlPk4Bytes(
      urlPk4Source.url,
      onStatus,
      settings.log,
      settings.progress
    );
    if (cachedUrlBytes) {
      settings.progress?.(64, "Installing PK4");
      settings.log?.(`Installing cached URL PK4 (${formatByteCount(cachedUrlBytes.byteLength)})...`);
      writePk4(FS, cachedUrlBytes, "cached URL", settings);
      installedUrlPk4Href = urlPk4Source.url;
      settings.progress?.(68, "PK4 ready");
      return;
    }

    const urlBytes = await readUrlPk4Bytes(urlPk4Source, onStatus, settings.log, settings.progress);
    settings.progress?.(64, "Installing PK4");
    settings.log?.(`Installing URL PK4 (${formatByteCount(urlBytes.byteLength)})...`);
    writePk4(FS, urlBytes, "URL", settings);
    installedUrlPk4Href = urlPk4Source.url;
    cacheUrlPk4Bytes(urlPk4Source.url, urlBytes, settings.log);
    settings.progress?.(68, "PK4 ready");
    return;
  }

  settings.progress?.(50, "Reading data");
  settings.log?.("Reading imported PK4 storage...");
  const storedBytes = await readPk4Bytes();

  if (storedBytes) {
    settings.progress?.(58, "Installing PK4");
    onStatus?.("Installing imported PK4...");
    settings.log?.(`Installing imported PK4 (${formatByteCount(storedBytes.byteLength)})...`);
    writePk4(FS, storedBytes, "imported", settings);
    settings.progress?.(68, "PK4 ready");
    return;
  }

  if (fileExists(FS, "/base/pak-display.pk4")) {
    settings.progress?.(68, "PK4 ready");
    onStatus?.("Bundled display PK4 ready");
    settings.log?.("Bundled display PK4 is already mounted");
    console.info("Bundled display PK4 is embedded at /base/pak-display.pk4");
    return;
  }

  const bundledBytes = await readBundledPk4Bytes(onStatus, settings.log, settings.progress);
  if (bundledBytes) {
    settings.progress?.(64, "Installing PK4");
    settings.log?.(`Installing bundled PK4 (${formatByteCount(bundledBytes.byteLength)})...`);
    writePk4(FS, bundledBytes, "bundled", settings);
    settings.progress?.(68, "PK4 ready");
  }
}

async function readCachedUrlPk4Bytes(sourceUrl, onStatus, log, progress) {
  progress?.(50, "Checking cache");
  onStatus?.("Checking cached URL PK4...");

  let bytes = null;
  try {
    bytes = await readCachedUrlPk4(sourceUrl);
  } catch (error) {
    log?.(`Could not read cached URL PK4: ${formatError(error)}`);
    return null;
  }

  if (!bytes) {
    return null;
  }

  if (isPk4Payload(bytes)) {
    progress?.(58, "Loading cached PK4");
    onStatus?.("Loading cached URL PK4...");
    log?.(`Using cached URL PK4 (${formatByteCount(bytes.byteLength)})...`);
    return bytes;
  }

  log?.("Cached URL PK4 was invalid; clearing it and fetching again...");
  try {
    await clearCachedUrlPk4(sourceUrl);
  } catch (error) {
    log?.(`Could not clear invalid cached URL PK4: ${formatError(error)}`);
  }

  return null;
}

function cacheUrlPk4Bytes(sourceUrl, pk4Bytes, log) {
  if (!isPk4Payload(pk4Bytes)) {
    return;
  }

  const byteLength = pk4Bytes.byteLength;
  window.setTimeout(() => {
    saveCachedUrlPk4(sourceUrl, pk4Bytes, {
      name: "URL pak-display.pk4"
    })
      .then(() => {
        log?.(`Cached URL PK4 for future launches (${formatByteCount(byteLength)})`);
      })
      .catch((error) => {
        log?.(`Could not cache URL PK4: ${formatError(error)}`);
      });
  }, 0);
}

async function readUrlPk4Bytes(source, onStatus, log, progress) {
  const candidates = getUrlPk4Candidates(source.url);
  let lastError = null;

  for (const candidate of candidates) {
    progress?.(54, "Fetching PK4");
    onStatus?.(candidate.status);
    log?.(candidate.message);

    let bytes = null;
    try {
      bytes = candidate.kind === "chunks"
        ? await fetchChunkedBytes(candidate, progress, log)
        : await fetchBytes(candidate.url, {
            cache: "no-store",
            progress,
            progressBase: 54,
            progressSpan: 6,
            progressLabel: candidate.compressed ? "Fetching compressed PK4" : "Fetching PK4"
          });
    } catch (error) {
      lastError = error;
      log?.(`URL PK4 fetch failed from ${candidate.url || candidate.manifestUrl}: ${formatError(error)}`);
      if (!candidate.optional) {
        break;
      }
      await delay(PK4_FETCH_RETRY_DELAY_MS);
      continue;
    }

    if (!bytes) {
      lastError = new Error(`No PK4 response from ${candidate.url}`);
      if (!candidate.optional) {
        break;
      }
      log?.(`${candidate.fallbackName} was not available; trying next PK4 source...`);
      await delay(PK4_FETCH_RETRY_DELAY_MS);
      continue;
    }

    if (isGzipPayload(bytes)) {
      if (!("DecompressionStream" in globalThis)) {
        lastError = new Error("This browser cannot decompress gzip PK4 files");
        if (!candidate.optional) {
          break;
        }
        log?.("Browser cannot decompress the compressed URL PK4; trying raw URL...");
        continue;
      }

      progress?.(60, "Decompressing PK4");
      onStatus?.("Decompressing URL PK4...");
      log?.(`Decompressing URL PK4 (${formatByteCount(bytes.byteLength)} compressed)...`);
      const decompressed = await decompressGzip(bytes);
      if (isPk4Payload(decompressed)) {
        return decompressed;
      }

      lastError = new Error("Decompressed URL data is not a valid DOOM 3 PK4");
      if (!candidate.optional) {
        break;
      }
      continue;
    }

    if (isPk4Payload(bytes)) {
      progress?.(60, "Loading PK4");
      return bytes;
    }

    lastError = new Error(`${candidate.url} did not return DOOM 3 PK4 data`);
    if (!candidate.optional) {
      break;
    }
    log?.("Compressed URL PK4 candidate was not valid PK4 data; trying raw URL...");
    await delay(PK4_FETCH_RETRY_DELAY_MS);
  }

  throw new Error(
    `Could not fetch PK4 URL. The file must be served over HTTP(S) with browser access enabled. ${formatError(lastError)}`
  );
}

async function readBundledPk4Bytes(onStatus, log, progress) {
  // Cached bundled PK4 (IndexedDB): a 65MB download on flaky cellular only
  // has to succeed ONCE. Freshness: a 4s HEAD compares content-length; if
  // the HEAD fails (offline, flaky), the cache is trusted — better to play
  // a slightly stale pak than to fail the boot.
  try {
    const cached = await readCachedUrlPk4(BUNDLED_PK4_URL);
    if (cached && isPk4Payload(cached)) {
      let fresh = true;
      try {
        const head = await fetch(BUNDLED_PK4_URL, {
          method: "HEAD",
          cache: "no-store",
          signal: AbortSignal.timeout(4000)
        });
        const len = Number(head.headers.get("content-length") || 0);
        if (head.ok && len > 0 && len !== cached.byteLength) {
          fresh = false;
        }
      } catch {
        // offline / flaky — use the cache
      }
      if (fresh) {
        log?.(`Using cached bundled PK4 (${formatByteCount(cached.byteLength)})`);
        progress?.(60, "Loading PK4");
        return cached;
      }
      log?.("Cached bundled PK4 is stale; re-downloading...");
    }
  } catch (error) {
    log?.(`Bundled PK4 cache read failed: ${formatError(error)}`);
  }
  const finish = (bytes) => {
    if (bytes) {
      cacheUrlPk4Bytes(BUNDLED_PK4_URL, bytes, log);
    }
    return bytes;
  };
  // Try the raw chunked manifest first on every runtime (not just the glasses
  // WebView): a bundled PK4 larger than a host's per-file limit (e.g. GitHub's
  // 100 MB) has to ship as raw < 100 MB chunks + a manifest, and raw chunks are
  // cheaper than the gzip path (no decompress copy — easier on mobile memory).
  // Falls through to the compressed/raw single-file paths if the manifest 404s.
  {
    progress?.(54, "Fetching PK4");
    onStatus?.("Loading chunked display PK4...");
    log?.("Fetching chunked display PK4...");
    const chunked = await fetchChunkedBytes({
      manifestUrl: appendPathSuffix(BUNDLED_PK4_URL, ".manifest.json"),
      progressLabel: "Fetching display PK4 chunks"
    }, progress, log);

    if (chunked) {
      progress?.(60, "Loading PK4");
      return finish(chunked);
    }

    log?.("Chunked display PK4 was not found; trying compressed display PK4...");
  }

  if ("DecompressionStream" in globalThis) {
    progress?.(54, "Fetching PK4");
    onStatus?.("Loading compressed chunked display PK4...");
    log?.("Fetching compressed chunked display PK4...");
    const chunkedCompressed = await fetchChunkedBytes({
      manifestUrl: appendPathSuffix(BUNDLED_PK4_GZIP_URL, ".manifest.json"),
      progressLabel: "Fetching compressed display PK4 chunks"
    }, progress, log);

    if (chunkedCompressed && isGzipPayload(chunkedCompressed)) {
      progress?.(60, "Decompressing PK4");
      onStatus?.("Decompressing display PK4...");
      log?.(`Decompressing display PK4 (${formatByteCount(chunkedCompressed.byteLength)} compressed)...`);
      return finish(await decompressGzip(chunkedCompressed));
    }

    if (chunkedCompressed) {
      progress?.(60, "Loading PK4");
      log?.(`Using chunked browser-decoded display PK4 (${formatByteCount(chunkedCompressed.byteLength)})...`);
      return finish(chunkedCompressed);
    }

    progress?.(54, "Fetching PK4");
    onStatus?.("Loading compressed display PK4...");
    log?.("Fetching compressed display PK4...");
    const compressed = await fetchBytes(BUNDLED_PK4_GZIP_URL, {
      progress,
      progressBase: 54,
      progressSpan: 34,
      progressLabel: "Downloading PK4 (gz)"
    });
    if (compressed) {
      if (isGzipPayload(compressed)) {
        progress?.(60, "Decompressing PK4");
        onStatus?.("Decompressing display PK4...");
        log?.(`Decompressing display PK4 (${formatByteCount(compressed.byteLength)} compressed)...`);
        return finish(await decompressGzip(compressed));
      }

      if (isPk4Payload(compressed)) {
        progress?.(60, "Loading PK4");
        log?.(`Using browser-decoded display PK4 (${formatByteCount(compressed.byteLength)})...`);
        return finish(compressed);
      }
    }
    log?.("Compressed display PK4 was not found; trying raw PK4...");
  }

  progress?.(54, "Fetching PK4");
  onStatus?.("Loading display PK4...");
  log?.("Fetching raw display PK4...");
  const bytes = await fetchBytes(BUNDLED_PK4_URL, {
    progress,
    progressBase: 54,
    progressSpan: 34,
    progressLabel: "Downloading PK4"
  });
  // On a static SPA host an absent file may come back as index.html; only
  // accept real PK4 (ZIP) or gzip payloads, otherwise report "no PK4" so the
  // engine still starts (and reports missing game data itself).
  if (!bytes || (!isPk4Payload(bytes) && !isGzipPayload(bytes))) {
    onStatus?.("No PK4 available");
    log?.("No bundled PK4 was available");
    return null;
  }

  return finish(bytes);
}

async function fetchChunkedBytes(candidate, progress, log) {
  const manifest = await fetchChunkManifest(candidate.manifestUrl);
  if (!manifest) {
    return null;
  }

  const chunks = normalizeChunkManifest(manifest, candidate.manifestUrl);
  if (!chunks.length) {
    throw new Error(`Chunk manifest did not include chunks: ${candidate.manifestUrl}`);
  }

  const totalSize = Number(manifest.totalSize || 0);
  const buffers = [];
  let loaded = 0;

  log?.(`Fetching ${chunks.length} PK4 chunks from ${candidate.manifestUrl}...`);

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const expectedSize = Number(chunk.size || 0);
    const base = totalSize > 0 ? 54 + 6 * (loaded / totalSize) : 54;
    const span = totalSize > 0 && expectedSize > 0
      ? 6 * (expectedSize / totalSize)
      : 6 / chunks.length;
    const label = `Fetching chunk ${index + 1}/${chunks.length}`;
    // Cross-reload resume: completed chunks are cached individually, so a
    // boot that dies at chunk 12/16 resumes there on the next reload
    // instead of refetching everything. Cache entries validate by size and
    // are cleared once the assembled pak is cached whole.
    let bytes = null;
    try {
      const cached = await readCachedUrlPk4(chunk.url);
      if (cached && (!expectedSize || cached.byteLength === expectedSize)) {
        bytes = cached;
        log?.(`Chunk ${index + 1}/${chunks.length} from cache`);
      }
    } catch { /* cache miss/fail → network */ }
    if (!bytes) {
      bytes = await fetchBytesWithRetries(chunk.url, {
        cache: "no-store",
        progress,
        progressBase: base,
        progressSpan: span,
        progressLabel: label
      });
      if (bytes && (!expectedSize || bytes.byteLength === expectedSize)) {
        saveCachedUrlPk4(chunk.url, bytes, { name: `chunk ${index}` }).catch(() => {});
      }
    }

    if (!bytes) {
      throw new Error(`Missing PK4 chunk ${index + 1}/${chunks.length}`);
    }

    if (expectedSize > 0 && bytes.byteLength !== expectedSize) {
      throw new Error(
        `PK4 chunk ${index + 1}/${chunks.length} had ${formatByteCount(bytes.byteLength)}, expected ${formatByteCount(expectedSize)}`
      );
    }

    buffers.push(bytes);
    loaded += bytes.byteLength;
    progress?.(
      54 + 6 * Math.min(totalSize > 0 ? loaded / totalSize : (index + 1) / chunks.length, 1),
      `${candidate.progressLabel} ${formatByteCount(loaded)}${totalSize > 0 ? `/${formatByteCount(totalSize)}` : ""}`
    );
  }

  if (totalSize > 0 && loaded !== totalSize) {
    throw new Error(`Chunked PK4 had ${formatByteCount(loaded)}, expected ${formatByteCount(totalSize)}`);
  }

  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const buffer of buffers) {
    bytes.set(buffer, offset);
    offset += buffer.byteLength;
  }

  // Assembly complete — the caller caches the whole pak; drop chunk entries.
  for (const chunk of chunks) {
    clearCachedUrlPk4(chunk.url).catch(() => {});
  }

  return bytes;
}

async function fetchChunkManifest(url) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), PK4_MANIFEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal
    });

    if (!response.ok) {
      return null;
    }

    // A static SPA host may answer an absent manifest with index.html (200).
    // Guard against that and await here so a parse failure is caught locally
    // instead of rejecting at the call site.
    const contentType = response.headers.get("content-type") || "";
    if (!/json/i.test(contentType)) {
      return null;
    }

    return await response.json();
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

function normalizeChunkManifest(manifest, manifestUrl) {
  if (!Array.isArray(manifest.chunks)) {
    return [];
  }

  return manifest.chunks
    .map((chunk) => {
      const path = typeof chunk === "string" ? chunk : chunk.path;
      if (!path) {
        return null;
      }

      return {
        url: new URL(path, manifestUrl).href,
        size: typeof chunk === "string" ? 0 : Number(chunk.size || 0)
      };
    })
    .filter(Boolean);
}

async function fetchBytesWithRetries(url, options) {
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const bytes = await fetchBytes(url, options);
      if (bytes) {
        return bytes;
      }
      lastError = new Error(`No response from ${url}`);
    } catch (error) {
      lastError = error;
    }

    if (attempt < 3) {
      await delay(PK4_FETCH_RETRY_DELAY_MS * attempt);
    }
  }

  throw lastError;
}

async function fetchBytes(url, options = {}) {
  const {
    timeoutMs = TIMEOUTS.pk4,
    stallTimeoutMs = PK4_FETCH_STALL_TIMEOUT_MS,
    progress = null,
    progressBase = 54,
    progressSpan = 6,
    progressLabel = "Fetching",
    ...fetchOptions
  } = options;
  const controller = new AbortController();
  let timeoutReason = "";
  let overallTimer = null;
  let stallTimer = null;

  const abortWith = (reason) => {
    timeoutReason = reason;
    controller.abort();
  };

  const resetStallTimer = () => {
    if (!stallTimeoutMs) {
      return;
    }
    window.clearTimeout(stallTimer);
    stallTimer = window.setTimeout(
      () => abortWith(`${progressLabel} stalled for ${Math.round(stallTimeoutMs / 1000)}s`),
      stallTimeoutMs
    );
  };

  overallTimer = window.setTimeout(
    () => abortWith(`${progressLabel} timed out after ${Math.round(timeoutMs / 1000)}s`),
    timeoutMs
  );

  try {
    resetStallTimer();
    const response = await fetch(url, {
      // Bypass the HTTP cache. With "force-cache" a host that served a file as
      // 404 (e.g. before a deploy) gets that 404 cached, and the stale 404 is
      // then returned forever even after the file goes live — which black-holed
      // the bundled PK4 on iOS Safari ("No PK4 available"). The chunk path always
      // passed no-store, which is why chunks loaded but the single file didn't.
      cache: "no-store",
      ...fetchOptions,
      signal: controller.signal
    });

    if (!response.ok) {
      return null;
    }

    const total = Number(response.headers.get("content-length") || 0);
    if (!response.body?.getReader) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      progress?.(progressBase + progressSpan, progressLabel);
      return bytes;
    }

    const reader = response.body.getReader();
    const chunks = [];
    let loaded = 0;

    while (true) {
      const { done, value } = await reader.read();
      resetStallTimer();
      if (done) {
        break;
      }

      chunks.push(value);
      loaded += value.byteLength;
      if (total > 0) {
        const percent = progressBase + progressSpan * Math.min(loaded / total, 1);
        progress?.(
          percent,
          `${progressLabel} ${formatByteCount(loaded)}/${formatByteCount(total)}`
        );
      } else {
        progress?.(progressBase, `${progressLabel} ${formatByteCount(loaded)}`);
      }
    }

    const bytes = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    progress?.(progressBase + progressSpan, progressLabel);
    return bytes;
  } catch (error) {
    if (timeoutReason) {
      throw new Error(timeoutReason);
    }
    throw error;
  } finally {
    window.clearTimeout(overallTimer);
    window.clearTimeout(stallTimer);
  }
}

function getUrlPk4Candidates(url) {
  const candidates = [];
  const compactRuntime = isCompactWebViewRuntime();

  if (!/\.gz([?#]|$)/i.test(url)) {
    const rawManifestUrl = appendPathSuffix(url, ".manifest.json");
    if (compactRuntime) {
      candidates.push({
        kind: "chunks",
        url,
        manifestUrl: rawManifestUrl,
        compressed: false,
        optional: true,
        status: "Loading chunked URL PK4...",
        message: `Fetching chunked URL PK4 from ${rawManifestUrl}...`,
        fallbackName: "Chunked URL PK4",
        progressLabel: "Fetching chunked PK4"
      });
    }
  }

  if ("DecompressionStream" in globalThis && !/\.gz([?#]|$)/i.test(url)) {
    const gzipUrl = appendPathSuffix(url, ".gz");
    const gzipManifestUrl = appendPathSuffix(gzipUrl, ".manifest.json");
    candidates.push({
      kind: "chunks",
      url: gzipUrl,
      manifestUrl: gzipManifestUrl,
      compressed: true,
      optional: true,
      status: "Loading compressed chunked URL PK4...",
      message: `Fetching compressed chunked URL PK4 from ${gzipManifestUrl}...`,
      fallbackName: "Compressed chunked URL PK4",
      progressLabel: "Fetching compressed chunks"
    });
    candidates.push({
      kind: "file",
      url: gzipUrl,
      compressed: true,
      optional: true,
      status: "Loading compressed URL PK4...",
      message: `Fetching compressed URL PK4 from ${gzipUrl}...`,
      fallbackName: "Compressed URL PK4"
    });
  }

  candidates.push({
    kind: "file",
    url,
    compressed: /\.gz([?#]|$)/i.test(url),
    optional: false,
    status: /\.gz([?#]|$)/i.test(url) ? "Loading compressed URL PK4..." : "Loading URL PK4...",
    message: `Fetching URL PK4 from ${url}...`,
    fallbackName: "URL PK4"
  });

  return candidates;
}

function appendPathSuffix(url, suffix) {
  const nextUrl = new URL(url, window.location.href);
  nextUrl.pathname = `${nextUrl.pathname}${suffix}`;
  return nextUrl.href;
}

function isCompactWebViewRuntime() {
  return /Android.*wv/.test(navigator.userAgent) || screen.width <= 640;
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function getUrlPk4Source() {
  const rawValue = new URLSearchParams(window.location.search).get(URL_PK4_PARAM);
  const value = rawValue?.trim();

  if (!value) {
    return null;
  }

  if (looksLikeLocalPath(value)) {
    throw new Error(
      "The pk4 parameter must be an HTTP(S) URL or a path relative to this page, not a local filesystem path"
    );
  }

  let url = null;
  try {
    url = new URL(value, window.location.href);
  } catch {
    throw new Error(`Invalid pk4 parameter: ${value}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The pk4 parameter must use HTTP or HTTPS");
  }

  return { url: url.href };
}

function looksLikeLocalPath(value) {
  return (
    value.startsWith("file:") ||
    value.startsWith("~/") ||
    /^\/(users|volumes|home|private|tmp)\//i.test(value) ||
    /^[a-z]:[\\/]/i.test(value)
  );
}

async function decompressGzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function writePk4(FS, pk4Bytes, source, options) {
  if (!isPk4Payload(pk4Bytes)) {
    throw new Error(`${source} data is not a valid DOOM 3 PK4`);
  }

  mkdirTree(FS, "/base");
  FS.writeFile("/base/pak-display.pk4", pk4Bytes);

  if (options.writablePath) {
    mkdirTree(FS, "/dhewm3/base");
    FS.writeFile("/dhewm3/base/pak-display.pk4", pk4Bytes);
    console.info(`Installed ${source} PK4 at /base/pak-display.pk4 and /dhewm3/base/pak-display.pk4`);
  } else {
    console.info(`Installed ${source} PK4 at /base/pak-display.pk4`);
  }
}

function withTimeout(promise, ms, label) {
  let timer = null;

  const timeout = new Promise((_, reject) => {
    timer = window.setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`));
    }, ms);
  });

  return Promise.race([promise, timeout]).finally(() => {
    window.clearTimeout(timer);
  });
}

function bootLog(output, text, onLog) {
  const line = `[boot] ${text}`;
  appendOutput(output, line);
  onLog?.(line);
  console.info(line);
}

function formatByteCount(value) {
  if (!value) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  let amount = value;
  let unit = 0;

  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }

  return `${amount.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatError(error) {
  if (error?.message) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function isGzipPayload(bytes) {
  return bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function isPk4Payload(bytes) {
  // PK4 files are ZIP archives: local file header "PK\x03\x04" or, for an empty
  // archive, the end-of-central-directory record "PK\x05\x06".
  return (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07) &&
    (bytes[3] === 0x04 || bytes[3] === 0x06 || bytes[3] === 0x08)
  );
}

function fileExists(FS, path) {
  try {
    return FS.analyzePath(path).exists;
  } catch {
    return false;
  }
}

function mkdirTree(FS, path) {
  const parts = path.split("/").filter(Boolean);
  let current = "";

  for (const part of parts) {
    current += `/${part}`;
    if (fileExists(FS, current)) {
      continue;
    }

    try {
      FS.mkdir(current);
    } catch (error) {
      if (!fileExists(FS, current)) {
        throw error;
      }
    }
  }
}

function isRuntimeFS(FS) {
  return Boolean(
    FS &&
    typeof FS.mkdir === "function" &&
    typeof FS.writeFile === "function" &&
    typeof FS.analyzePath === "function"
  );
}

function appendOutput(output, text) {
  if (!output) {
    return;
  }

  output.value += `${text}\n`;
  output.scrollTop = output.scrollHeight;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.body.appendChild(script);
  });
}
