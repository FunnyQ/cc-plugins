// Viewport warp starfield — a slow forward-flight star streak field drawn on a
// canvas behind the HUD. Stars emanate from the viewport center (the vanishing
// point) and streak outward as they approach, reading as flying forward through
// deep space. Deliberately WAY slower than a hyperspace jump: this is cruise,
// not a launch sequence. No dependencies; pauses when the tab is hidden and
// renders a single static frame under prefers-reduced-motion.

const COUNT = 200;
// z units travelled per millisecond — the warp speed. Small = slow cruise.
const SPEED = 0.00018;
// Canvas can't be trusted to parse oklch() across engines, so the two star
// tints are pre-resolved to rgb (cool starlight + occasional aurora).
const STARLIGHT = "236, 239, 247";
const AURORA = "125, 224, 228";

const rnd = (a, b) => a + Math.random() * (b - a);
const makeStar = (z) => ({
  x: rnd(-1, 1),
  y: rnd(-1, 1),
  z: z ?? rnd(0.05, 1),
  warm: Math.random() < 0.1,
});

export function initStarfield(canvas) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const reduce = window.matchMedia?.(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  let w = 0;
  let h = 0;
  let cx = 0;
  let cy = 0;
  let scale = 1;
  let stars = Array.from({ length: COUNT }, () => makeStar());
  let raf = 0;
  let last = 0;
  let paused = false; // hard pause when the hero is collapsed

  function resize() {
    const r = canvas.getBoundingClientRect();
    w = canvas.width = Math.max(1, Math.round(r.width));
    h = canvas.height = Math.max(1, Math.round(r.height));
    cx = w / 2;
    cy = h / 2;
    scale = Math.max(w, h) * 0.55;
  }

  // Perspective projection: nearer stars (small z) fling far from center.
  const projX = (s) => cx + (s.x / s.z) * scale;
  const projY = (s) => cy + (s.y / s.z) * scale;

  function frame(t) {
    const dt = Math.min(48, t - (last || t));
    last = t;
    ctx.clearRect(0, 0, w, h);
    for (const s of stars) {
      const px = projX(s);
      const py = projY(s);
      s.z -= SPEED * dt;
      if (s.z <= 0.04) {
        Object.assign(s, makeStar(1));
        continue;
      }
      const nx = projX(s);
      const ny = projY(s);
      const depth = 1 - s.z; // 0 far → 1 near
      const alpha = Math.min(0.85, 0.12 + depth * 0.8);
      ctx.strokeStyle = `rgba(${s.warm ? AURORA : STARLIGHT}, ${alpha})`;
      ctx.lineWidth = 0.5 + depth * 1.4;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(nx, ny);
      ctx.stroke();
    }
    raf = requestAnimationFrame(frame);
  }

  function staticFrame() {
    ctx.clearRect(0, 0, w, h);
    for (const s of stars) {
      const depth = 1 - s.z;
      ctx.fillStyle = `rgba(${s.warm ? AURORA : STARLIGHT}, ${0.12 + depth * 0.6})`;
      ctx.beginPath();
      ctx.arc(projX(s), projY(s), 0.5 + depth * 1.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function start() {
    if (!reduce && !paused && !raf) {
      last = 0;
      raf = requestAnimationFrame(frame);
    }
  }
  function stop() {
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  }

  resize();
  if (reduce) {
    staticFrame();
  } else {
    start();
  }

  window.addEventListener("resize", () => {
    resize();
    if (reduce || paused) staticFrame();
  });
  // Don't burn frames behind a hidden tab.
  document.addEventListener("visibilitychange", () => {
    if (reduce) return;
    if (document.hidden) stop();
    else start();
  });

  return {
    pause() {
      paused = true;
      stop();
    },
    resume() {
      paused = false;
      start();
    },
  };
}
