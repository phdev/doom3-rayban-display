const ACTION_IDS = {
  forward: 0,
  attack: 1,
  jump: 2,
  crouch: 3,
  use: 4,
  flashlight: 5
};

const actionState = {
  forward: false,
  attack: false,
  jump: false,
  crouch: false,
  use: false,
  flashlight: false
};

// A pinch held longer than this toggles the DOOM 3 flashlight instead of
// toggling perpetual forward. The flashlight is the signature Ray-Ban Display
// affordance for DOOM 3's dark corridors.
const PINCH_LONG_PRESS_MS = 450;

export function createWearableInput({
  getEngine,
  onForwardChange,
  onActionChange,
  onFlashlightChange,
  onRecenter,
  onTurnBurst
}) {
  let pinchDownAt = 0;
  let pinchActive = false;

  function install() {
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("keyup", onKeyUp, true);
    document.addEventListener("d3gesture", onGestureEvent, true);
  }

  function dispose() {
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("keyup", onKeyUp, true);
    document.removeEventListener("d3gesture", onGestureEvent, true);
  }

  function onKeyDown(event) {
    const gesture = platformKeyToGesture(event);
    if (!gesture || event.repeat) {
      return;
    }

    capture(event);

    if (gesture === "pinchTap") {
      if (!pinchActive) {
        pinchActive = true;
        pinchDownAt = now();
      }
      return;
    }

    handleGesture(gesture, true);
  }

  function onKeyUp(event) {
    const gesture = platformKeyToGesture(event);
    if (!gesture) {
      return;
    }

    capture(event);

    if (gesture === "pinchTap") {
      if (!pinchActive) {
        return;
      }
      pinchActive = false;
      const held = now() - pinchDownAt;
      if (held >= PINCH_LONG_PRESS_MS) {
        handleGesture("pinchHold", true);
      } else {
        handleGesture("pinchTap", true);
      }
      return;
    }

    handleGesture(gesture, false);
  }

  function onGestureEvent(event) {
    const gesture = event.detail?.gesture;
    if (gesture) {
      handleGesture(gesture, event.detail?.active !== false);
    }
  }

  function handleGesture(gesture, active) {
    if (!active) {
      return;
    }

    if (gesture === "pinchTap") {
      setForward(!actionState.forward);
      return;
    }

    if (gesture === "pinchHold") {
      setFlashlight(!actionState.flashlight);
      return;
    }

    if (gesture === "swipeUp") {
      pulseAction("jump", 240);
      return;
    }

    if (gesture === "swipeDown") {
      onRecenter?.();
      return;
    }

    if (gesture === "swipeLeft") {
      onTurnBurst?.(1);
      return;
    }

    if (gesture === "swipeRight") {
      onTurnBurst?.(-1);
    }
  }

  function setAction(action, down) {
    if (actionState[action] === down) {
      return;
    }

    actionState[action] = down;
    onActionChange?.(action, down);

    const engine = getEngine();
    if (engine) {
      engine.setWearableAction(ACTION_IDS[action], down);
    }
  }

  function pulseAction(action, durationMs) {
    setAction(action, true);
    window.setTimeout(() => setAction(action, false), durationMs);
  }

  function setForward(down) {
    const enabled = Boolean(down);

    if (actionState.forward === enabled) {
      return;
    }

    setAction("forward", enabled);
    onForwardChange?.(enabled);
  }

  function setFlashlight(on) {
    const enabled = Boolean(on);

    if (actionState.flashlight === enabled) {
      return;
    }

    // Flashlight is a latched toggle in the engine; pulse the action so the
    // game module flips its torch state once per gesture.
    pulseAction("flashlight", 120);
    actionState.flashlight = enabled;
    onFlashlightChange?.(enabled);
  }

  function toggleForward() {
    handleGesture("pinchTap", true);
  }

  function toggleFlashlight() {
    handleGesture("pinchHold", true);
  }

  function fire() {
    pulseAction("attack", 180);
  }

  function jumpFire() {
    pulseAction("jump", 240);
    pulseAction("attack", 260);
  }

  function recenter() {
    handleGesture("swipeDown", true);
  }

  function turn(direction) {
    onTurnBurst?.(direction);
  }

  return {
    install,
    dispose,
    toggleForward,
    toggleFlashlight,
    fire,
    jumpFire,
    recenter,
    turn,
    setForward,
    getState: () => ({ ...actionState })
  };
}

function now() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function platformKeyToGesture(event) {
  const key = String(event.key || "");

  if (key.startsWith("Arrow")) {
    const direction = key.slice("Arrow".length).toLowerCase();
    if (direction === "up") return "swipeUp";
    if (direction === "down") return "swipeDown";
    if (direction === "left") return "swipeLeft";
    if (direction === "right") return "swipeRight";
  }

  if (key === "Enter" || key === " ") {
    return "pinchTap";
  }

  return null;
}

function capture(event) {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}
