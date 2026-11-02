import { describe, expect, test } from "bun:test";
import { springEasing } from "./spring";

const points = (easing: string) =>
  easing
    .slice("linear(".length, -1)
    .split(",")
    .map((s) => Number(s.trim()));

describe("springEasing", () => {
  test("writes a linear() curve from 0 to 1", () => {
    const { easing } = springEasing({ stiffness: 170, damping: 26, mass: 1 });
    const ys = points(easing);
    expect(easing.startsWith("linear(0,")).toBe(true);
    expect(ys.at(-1)).toBe(1);
    expect(ys.length).toBeGreaterThan(10);
  });

  test("a critically damped spring never overshoots", () => {
    const k = 200;
    const ys = points(
      springEasing({ stiffness: k, damping: 2 * Math.sqrt(k), mass: 1 }).easing,
    );
    expect(Math.max(...ys)).toBeLessThanOrEqual(1);
  });

  test("an underdamped spring overshoots", () => {
    const ys = points(
      springEasing({ stiffness: 300, damping: 8, mass: 1 }).easing,
    );
    expect(Math.max(...ys)).toBeGreaterThan(1.1);
  });

  test("more mass settles later", () => {
    const light = springEasing({
      stiffness: 170,
      damping: 26,
      mass: 1,
    }).durationMs;
    const heavy = springEasing({
      stiffness: 170,
      damping: 26,
      mass: 4,
    }).durationMs;
    expect(heavy).toBeGreaterThan(light);
  });

  test("duration is capped for a spring that never settles in time", () => {
    expect(
      springEasing({ stiffness: 1, damping: 0.01, mass: 10 }).durationMs,
    ).toBe(10000);
  });
});
