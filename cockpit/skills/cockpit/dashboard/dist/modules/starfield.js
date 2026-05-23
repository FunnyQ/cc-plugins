// Viewport warp starfield — a slow forward-flight star streak field drawn on a
// canvas behind the HUD. Stars emanate from the viewport center (the vanishing
// point) and streak outward as they approach, reading as flying forward through
// deep space. Deliberately WAY slower than a hyperspace jump: this is cruise,
// not a launch sequence. No dependencies; pauses when the tab is hidden and
// renders a single static frame under prefers-reduced-motion.

const COUNT = 560;
// z units travelled per millisecond — the warp speed. Small = slow cruise.
const SPEED = 0.00018;
// Canvas can't be trusted to parse oklch() across engines, so the two star
// tints are pre-resolved to rgb (cool starlight + occasional aurora).
const STARLIGHT = "236, 239, 247";
const AURORA = "125, 224, 228";
const TYPES = [
  {
    name: "dust",
    weight: 0.5,
    size: [0.52, 1.18],
    alpha: [0.2, 0.5],
    stretch: [0.4, 0.92],
  },
  {
    name: "star",
    weight: 0.34,
    size: [0.82, 1.72],
    alpha: [0.3, 0.86],
    stretch: [0.9, 1.58],
  },
  {
    name: "glint",
    weight: 0.11,
    size: [0.95, 2.05],
    alpha: [0.42, 0.96],
    stretch: [1.12, 2.1],
  },
  {
    name: "courier",
    weight: 0.05,
    size: [0.7, 1.5],
    alpha: [0.36, 0.9],
    stretch: [1.7, 3],
  },
];

const rnd = (a, b) => a + Math.random() * (b - a);
function pickType() {
  let n = Math.random();
  for (const type of TYPES) {
    n -= type.weight;
    if (n <= 0) return type;
  }
  return TYPES[0];
}

function makeStar(z) {
  const type = pickType();
  return {
    x: rnd(-1, 1),
    y: rnd(-1, 1),
    z: z ?? rnd(0.05, 1),
    type,
    stretch: rnd(type.stretch[0], type.stretch[1]),
    twinkle: rnd(0.85, 1.15),
    phase: rnd(0, Math.PI * 2),
  };
}

export function initStarfield(canvas) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const viewport = canvas.closest(".viewport");
  const reduce = window.matchMedia?.(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  let w = 0;
  let h = 0;
  let baseCx = 0;
  let baseCy = 0;
  let cx = 0;
  let cy = 0;
  let beaconCx = 0;
  let beaconCy = 0;
  let scale = 1;
  let stars = Array.from({ length: COUNT }, () => makeStar());
  let raf = 0;
  let last = 0;
  let paused = false; // hard pause when the hero is collapsed

  function resize() {
    const r = canvas.getBoundingClientRect();
    w = canvas.width = Math.max(1, Math.round(r.width));
    h = canvas.height = Math.max(1, Math.round(r.height));
    baseCx = w / 2;
    baseCy = h / 2;
    setTurnCenter(0, 1);
    scale = Math.max(w, h) * 0.55;
  }

  function setTurnCenter(t, follow = 0.035) {
    const turnX =
      Math.sin(t * 0.00014) * w * 0.09 + Math.sin(t * 0.00006) * w * 0.035;
    const turnY =
      Math.cos(t * 0.00011) * h * 0.055 + Math.sin(t * 0.00005) * h * 0.025;
    cx = baseCx + turnX;
    cy = baseCy + turnY;
    beaconCx += (cx - beaconCx) * follow;
    beaconCy += (cy - beaconCy) * follow;
    if (viewport) {
      viewport.style.setProperty("--warp-x", `${(cx / w) * 100}%`);
      viewport.style.setProperty("--warp-y", `${(cy / h) * 100}%`);
      viewport.style.setProperty("--beacon-x", `${(beaconCx / w) * 100}%`);
      viewport.style.setProperty("--beacon-y", `${(beaconCy / h) * 100}%`);
      viewport.dispatchEvent(new CustomEvent("cockpit:warp-turn"));
    }
  }

  // Perspective projection: nearer stars (small z) fling far from center.
  const projX = (s) => cx + (s.x / s.z) * scale;
  const projY = (s) => cy + (s.y / s.z) * scale;

  function frame(t) {
    const dt = Math.min(48, t - (last || t));
    last = t;
    setTurnCenter(t);
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
      const shimmer = 0.88 + Math.sin(t * 0.0012 + s.phase) * 0.12;
      const alpha = Math.min(
        s.type.alpha[1],
        (s.type.alpha[0] + depth * (s.type.alpha[1] - s.type.alpha[0])) *
          shimmer,
      );
      const tint = s.type.name === "glint" ? AURORA : STARLIGHT;
      ctx.strokeStyle = `rgba(${tint}, ${alpha})`;
      ctx.lineWidth =
        s.type.size[0] + depth * (s.type.size[1] - s.type.size[0]) * s.twinkle;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px + (nx - px) * s.stretch, py + (ny - py) * s.stretch);
      ctx.stroke();
    }
    raf = requestAnimationFrame(frame);
  }

  function staticFrame() {
    ctx.clearRect(0, 0, w, h);
    for (const s of stars) {
      const depth = 1 - s.z;
      const tint = s.type.name === "glint" ? AURORA : STARLIGHT;
      ctx.fillStyle = `rgba(${tint}, ${s.type.alpha[0] + depth * 0.64})`;
      ctx.beginPath();
      ctx.arc(
        projX(s),
        projY(s),
        s.type.size[0] + depth * (s.type.size[1] - s.type.size[0]),
        0,
        Math.PI * 2,
      );
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
