function wrapDegrees(value) {
  let wrapped = value;

  while (wrapped > 180) {
    wrapped -= 360;
  }

  while (wrapped < -180) {
    wrapped += 360;
  }

  return wrapped;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function createHeadTracking({
  getEngine,
  meter,
  status,
  tickMs,
  deadzone = 7.5,
  maxAngle = 30,
  sensitivity = 2,
  turnBurstDegrees = 12
}) {
  let latestAlpha = null;
  let baseAlpha = null;
  let currentYaw = 0;
  let timer = null;
  let burstRemaining = 0;
  let sensitivityScale = 1;

  function onOrientation(event) {
    if (typeof event.alpha !== "number") {
      return;
    }

    latestAlpha = event.alpha;
    if (baseAlpha === null) {
      baseAlpha = latestAlpha;
    }

    currentYaw = wrapDegrees(-(latestAlpha - baseAlpha));
    renderMeter();
  }

  async function start() {
    if (typeof DeviceOrientationEvent === "undefined") {
      setStatus("IMU unavailable");
      return false;
    }

    if (typeof DeviceOrientationEvent.requestPermission === "function") {
      const permission = await DeviceOrientationEvent.requestPermission();
      if (permission !== "granted") {
        setStatus("IMU permission denied");
        return false;
      }
    }

    window.addEventListener("deviceorientation", onOrientation, true);
    if (!timer) {
      timer = window.setInterval(tick, tickMs);
    }
    setStatus("IMU active");
    return true;
  }

  function stop() {
    window.removeEventListener("deviceorientation", onOrientation, true);
    if (timer) {
      window.clearInterval(timer);
      timer = null;
    }
    setStatus("IMU stopped");
  }

  function recenter() {
    if (latestAlpha !== null) {
      baseAlpha = latestAlpha;
    }
    currentYaw = 0;
    renderMeter();
    setStatus("Recentered");
  }

  function addTurnBurst(direction) {
    burstRemaining += direction * turnBurstDegrees;
  }

  function tick() {
    const engine = getEngine();
    const dyaw = calculateYawStep() + drainBurstStep();

    if (engine && Math.abs(dyaw) > 0.001) {
      engine.callAddViewAngles(dyaw, 0);
    }
  }

  function calculateYawStep() {
    const magnitude = Math.abs(currentYaw);

    if (magnitude <= deadzone) {
      return 0;
    }

    const normalized = clamp((magnitude - deadzone) / (maxAngle - deadzone), 0, 1);
    return Math.sign(currentYaw) * normalized * sensitivity * sensitivityScale;
  }

  function setSensitivityScale(scale) {
    const nextScale = Number(scale);
    sensitivityScale = Number.isFinite(nextScale) ? clamp(nextScale, 0.1, 1) : 1;
  }

  function drainBurstStep() {
    if (Math.abs(burstRemaining) < 0.1) {
      burstRemaining = 0;
      return 0;
    }

    const step = clamp(burstRemaining, -12, 12);
    burstRemaining -= step;
    return step;
  }

  function renderMeter() {
    if (!meter) {
      return;
    }

    const meterYaw = -currentYaw;
    const normalized = clamp(meterYaw / maxAngle, -1, 1);
    meter.style.setProperty("--yaw", String(normalized));
    meter.style.setProperty("--yaw-offset", `${normalized * 46}%`);
    meter.dataset.zone =
      Math.abs(meterYaw) <= deadzone
        ? "deadzone"
        : meterYaw > 0
          ? "right"
          : "left";
  }

  function setStatus(text) {
    if (status) {
      status.textContent = text;
    }
  }

  return {
    start,
    stop,
    recenter,
    addTurnBurst,
    setSensitivityScale,
    getYaw: () => currentYaw
  };
}
