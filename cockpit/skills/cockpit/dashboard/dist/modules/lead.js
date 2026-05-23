// HUD leader line — a horizontal underline beneath the destination text, then a
// connector from that underline's bottom-right corner to the beacon at center.
// The destination box width is dynamic, so the line is measured from the live
// DOM (ResizeObserver) rather than hard-coded, and the SVG uses a pixel-space
// viewBox so 1 user unit == 1 CSS px.

export function initLead({ svg, viewport, dest, beacon, telemetry }) {
  if (!svg || !viewport || !dest || !beacon) return;
  const underline = svg.querySelector(".lead-underline");
  const connector = svg.querySelector(".lead-connector");
  if (!underline || !connector) return;

  function update() {
    const vp = viewport.getBoundingClientRect();
    if (!vp.width || !vp.height) return;
    const d = dest.getBoundingClientRect();
    const b = beacon.getBoundingClientRect();

    svg.setAttribute("viewBox", `0 0 ${vp.width} ${vp.height}`);

    const left = d.left - vp.left;
    const right = d.right - vp.left;
    const y = d.bottom - vp.top + 5; // just beneath the text baseline
    const bx = b.left - vp.left + b.width / 2;
    const by = b.top - vp.top + b.height / 2;

    underline.setAttribute("x1", left);
    underline.setAttribute("y1", y);
    underline.setAttribute("x2", right);
    underline.setAttribute("y2", y);

    connector.setAttribute("x1", right);
    connector.setAttribute("y1", y);
    connector.setAttribute("x2", bx);
    connector.setAttribute("y2", by);

    // Distance the telemetry slides to reach the right edge when the hero
    // collapses — measured (offset* are transform-independent) so the move can
    // animate with translateX instead of flashing from left to right.
    if (telemetry) {
      const shift =
        viewport.clientWidth - telemetry.offsetLeft * 2 - telemetry.offsetWidth;
      telemetry.style.setProperty("--tele-shift", `${Math.max(0, shift)}px`);
    }
  }

  const ro = new ResizeObserver(update);
  ro.observe(viewport);
  ro.observe(dest);
  window.addEventListener("resize", update);
  // Initial pass once layout settles.
  requestAnimationFrame(update);

  return update;
}
