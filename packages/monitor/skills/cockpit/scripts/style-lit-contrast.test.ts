import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(
  join(import.meta.dir, "../dashboard/dist/style.css"),
  "utf8",
);

function token(name: string): [number, number, number] {
  const m = css.match(
    new RegExp(`--${name}:\\s*oklch\\(([\\d.]+)%\\s+([\\d.]+)\\s+([\\d.]+)\\)`),
  );
  if (!m) throw new Error(`--${name} is not a plain oklch() token`);
  return [Number(m[1]) / 100, Number(m[2]), Number(m[3])];
}

function luminance([L, C, h]: [number, number, number]): number {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((v) => Math.min(1, Math.max(0, v)));
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function contrast(fg: string, bg: string): number {
  const [x, y] = [luminance(token(fg)), luminance(token(bg))].sort(
    (p, q) => q - p,
  );
  return (x + 0.05) / (y + 0.05);
}

for (const ink of ["lit-ink", "lit-ink-muted", "lit-ink-faint"]) {
  for (const surface of ["lit", "lit-fill"]) {
    test(`--${ink} clears WCAG AA (4.5:1) on --${surface}`, () => {
      expect(contrast(ink, surface)).toBeGreaterThanOrEqual(4.5);
    });
  }
}
