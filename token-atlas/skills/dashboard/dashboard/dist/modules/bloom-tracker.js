// Sunrise Bloom — pointer position is lerped toward target each frame so the
// light glides behind the cursor with natural exponential ease-out (closer to
// target = smaller step). Smoothing happens in JS because CSS transitions on
// custom properties get re-armed every pointermove and never visibly trail.
export function installBloomTracker() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const SELECTOR = ".panel, .card, .budget-panel, .data-health-panel";
  // Per-frame lerp factor. Lower = laggier trail. 0.14 ≈ ~300ms to settle.
  const SMOOTH = 0.14;
  const SNAP_EPSILON = 0.15;

  let activeEl = null;
  let targetX = 50;
  let targetY = 50;
  let currentX = 50;
  let currentY = 50;
  let rafId = 0;

  function tick() {
    rafId = 0;
    if (!activeEl) return;
    currentX += (targetX - currentX) * SMOOTH;
    currentY += (targetY - currentY) * SMOOTH;
    activeEl.style.setProperty("--bloom-x", currentX.toFixed(2) + "%");
    activeEl.style.setProperty("--bloom-y", currentY.toFixed(2) + "%");
    if (
      Math.abs(targetX - currentX) > SNAP_EPSILON ||
      Math.abs(targetY - currentY) > SNAP_EPSILON
    ) {
      rafId = requestAnimationFrame(tick);
    }
  }

  document.addEventListener(
    "pointermove",
    (event) => {
      if (event.pointerType !== "mouse" && event.pointerType !== "pen") return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const el = target.closest(SELECTOR);
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const nextX = ((event.clientX - rect.left) / rect.width) * 100;
      const nextY = ((event.clientY - rect.top) / rect.height) * 100;
      if (el !== activeEl) {
        // Panel switch: jump to cursor so the trail starts from where the
        // user actually entered, not from the previous panel's last point.
        activeEl = el;
        currentX = targetX = nextX;
        currentY = targetY = nextY;
        el.style.setProperty("--bloom-x", currentX.toFixed(2) + "%");
        el.style.setProperty("--bloom-y", currentY.toFixed(2) + "%");
        return;
      }
      targetX = nextX;
      targetY = nextY;
      if (!rafId) rafId = requestAnimationFrame(tick);
    },
    { passive: true },
  );
}
