import type { Bezier, Param, Spring, Value } from "./spec";
import { springEasing } from "./spring";

const clean = (n: number) => Number(n.toPrecision(12));

export function roundToStep(value: number, step: number): number {
  return clean(Math.round(value / step) * step);
}

const bezierCss = (b: Bezier) => `cubic-bezier(${b.join(", ")})`;

export function cssVars(p: Param, value: Value): Record<string, string> {
  const name = `--${p.id}`;
  switch (p.type) {
    case "range":
    case "number":
    case "duration":
      return { [name]: `${clean(value as number)}${p.unit}` };
    case "toggle":
      return { [name]: value ? "1" : "0" };
    case "bezier":
      return { [name]: bezierCss(value as Bezier) };
    case "spring": {
      const { easing, durationMs } = springEasing(value as Spring);
      return { [name]: easing, [`${name}-duration`]: `${durationMs}ms` };
    }
    default:
      return { [name]: value as string };
  }
}

export function outputValue(p: Param, value: Value): unknown {
  switch (p.type) {
    case "range":
    case "number":
    case "duration": {
      const n = clean(value as number);
      return p.unit ? `${n}${p.unit}` : n;
    }
    case "bezier":
      return bezierCss(value as Bezier);
    case "spring": {
      const { easing, durationMs } = springEasing(value as Spring);
      return { ...(value as Spring), easing, duration: `${durationMs}ms` };
    }
    default:
      return value;
  }
}

const isNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

export function fits(p: Param, value: unknown): boolean {
  switch (p.type) {
    case "range":
    case "number":
    case "duration":
      return isNum(value) && value >= p.min && value <= p.max;
    case "color":
      return (
        typeof value === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)
      );
    case "select":
      return typeof value === "string" && p.options.includes(value);
    case "toggle":
      return typeof value === "boolean";
    case "bezier":
      return (
        Array.isArray(value) &&
        value.length === 4 &&
        value.every(isNum) &&
        value[0] >= 0 &&
        value[0] <= 1 &&
        value[2] >= 0 &&
        value[2] <= 1
      );
    case "spring": {
      const v = value as Record<string, unknown> | null;
      return (
        typeof v === "object" &&
        v !== null &&
        ["stiffness", "damping", "mass"].every(
          (k) => isNum(v[k]) && (v[k] as number) > 0,
        )
      );
    }
  }
}
