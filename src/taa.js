// Per-pixel temporal accumulation (TAA-style). Mac WebKit + iPhone-UA WebGL
// recorder confirmed the engine's WebGL command stream is deterministic
// across stationary frames (0.4% mismatches are buffer-ring rotation,
// semantically equivalent). The per-frame intensity drift lives in Apple's
// Metal driver — see W3C WebGPU §3.3 non-determinism language. We can mask
// it perceptually by averaging consecutive frames per pixel.
//
// Implementation: a 2D-context overlay canvas. Each rAF, drawImage() the
// engine's WebGL canvas onto it with globalAlpha = (1 - decay). The result
// is exponential moving average: history = history*(1-α) + current*α.
//
// blend factor:
//   α=0.5   2-tap moving average, σ scales ~0.7×  (light smoothing)
//   α=0.33  3-tap, ~0.58×                          (recommended)
//   α=0.2   5-tap, ~0.45×                          (heavy, more ghosting)
//   α=0.1   10-tap, ~0.32×                         (max smoothing, heavy ghost)
//
// Tradeoff: motion produces ghosting since we have no motion vectors. For a
// wearable scenario with mostly head-tracked yaw, ghost trails read as
// motion blur — acceptable. For fast strafing, the ghost is visible.
//
// Gated via ?taa[=α] URL flag (opt-in; default off).
const QS = (typeof window !== "undefined" && window.location && window.location.search) || "";
const TAA_MATCH = /[?&]taa(?:=([\d.]+))?\b/.exec(QS);
const TAA_ENABLED = !!TAA_MATCH;
const TAA_ALPHA = TAA_MATCH && TAA_MATCH[1] !== undefined
  ? Math.max(0.05, Math.min(1.0, Number(TAA_MATCH[1])))
  : 0.33;

export function installTAA(gameCanvas) {
  if (!TAA_ENABLED) return null;
  if (!gameCanvas) return null;

  // Create the overlay canvas, position it identically over the game canvas.
  const taa = document.createElement("canvas");
  taa.id = "taaCanvas";
  taa.width = gameCanvas.width || 600;
  taa.height = gameCanvas.height || 600;
  // Copy CSS sizing rules — game-canvas class brings the layout. Then make
  // the game canvas invisible (we still let the engine render into it; we
  // just don't display it).
  taa.className = gameCanvas.className;
  // Match positioning via the parent's grid/flex; insert immediately after
  // the game canvas so it takes the same slot.
  gameCanvas.parentNode.insertBefore(taa, gameCanvas.nextSibling);
  gameCanvas.style.visibility = "hidden";

  const ctx = taa.getContext("2d", { alpha: false, willReadFrequently: false });
  if (!ctx) {
    console.warn("[TAA] 2D context unavailable; rolling back");
    gameCanvas.style.visibility = "";
    taa.remove();
    return null;
  }

  // Diagnostics
  window.__d3TAA = { enabled: true, alpha: TAA_ALPHA, ticks: 0, blits: 0, skipped: 0 };

  let running = true;
  let lastGameW = 0, lastGameH = 0;

  function tick() {
    if (!running) return;
    window.__d3TAA.ticks += 1;
    // Re-sync backing dimensions if the engine resized its canvas
    if (gameCanvas.width !== lastGameW || gameCanvas.height !== lastGameH) {
      lastGameW = gameCanvas.width;
      lastGameH = gameCanvas.height;
      taa.width = lastGameW;
      taa.height = lastGameH;
      // First blit fills the buffer at full opacity (no history yet)
      ctx.globalAlpha = 1.0;
      try {
        ctx.drawImage(gameCanvas, 0, 0);
        window.__d3TAA.blits += 1;
      } catch (_) {
        window.__d3TAA.skipped += 1;
      }
      ctx.globalAlpha = TAA_ALPHA;
    } else {
      try {
        ctx.drawImage(gameCanvas, 0, 0);
        window.__d3TAA.blits += 1;
      } catch (_) {
        window.__d3TAA.skipped += 1;
      }
    }
    requestAnimationFrame(tick);
  }
  // Start with full opacity for first blit; tick() handles subsequent
  ctx.globalAlpha = TAA_ALPHA;
  requestAnimationFrame(tick);

  console.log(`[TAA] active, α=${TAA_ALPHA}, taaCanvas overlaid on #gameCanvas`);

  return {
    stop() { running = false; gameCanvas.style.visibility = ""; taa.remove(); },
    alpha: TAA_ALPHA
  };
}
