type Spring = { stiffness: number; damping: number; mass: number };

const MAX_MS = 10000;
const POINTS = 48;

export function springEasing({ stiffness, damping, mass }: Spring): {
  easing: string;
  durationMs: number;
} {
  const dt = 1 / 1000;
  const trace: number[] = [];
  let x = 0;
  let v = 0;
  let settledAt = MAX_MS;
  for (let ms = 0; ms <= MAX_MS; ms++) {
    trace.push(x);
    if (ms > 0 && Math.abs(1 - x) < 0.001 && Math.abs(v) < 0.001) {
      settledAt = ms;
      break;
    }
    const a = (stiffness * (1 - x) - damping * v) / mass;
    v += a * dt;
    x += v * dt;
  }
  const ys: string[] = [];
  for (let i = 0; i < POINTS; i++) {
    const y = trace[Math.round((i / POINTS) * settledAt)] ?? 1;
    ys.push(String(Math.round(y * 10000) / 10000));
  }
  ys.push("1");
  return { easing: `linear(${ys.join(", ")})`, durationMs: settledAt };
}
