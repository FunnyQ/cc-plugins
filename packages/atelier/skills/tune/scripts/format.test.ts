import { describe, expect, test } from "bun:test";
import { cssVars, fits, outputValue, roundToStep } from "./format";
import { parseSpec } from "./spec";

const [blur, opacity, tint, border, ease, pop] = parseSpec(
  {
    snippet: "x.html",
    params: [
      { id: "blur", type: "range", min: 0, max: 80, default: 24, unit: "px" },
      { id: "opacity", type: "range", min: 0, max: 1, default: 0.62 },
      { id: "tint", type: "color", default: "#ff7a59" },
      { id: "border", type: "toggle", default: true },
      { id: "ease", type: "bezier", default: [0.2, 0.8, 0.2, 1] },
      { id: "pop", type: "spring" },
    ],
  },
  "/s/x.json",
).params;

describe("cssVars", () => {
  test("numbers carry their unit", () => {
    expect(cssVars(blur, 24)).toEqual({ "--blur": "24px" });
    expect(cssVars(opacity, 0.62)).toEqual({ "--opacity": "0.62" });
  });

  test("a toggle is 1 or 0 so calc() can use it", () => {
    expect(cssVars(border, true)).toEqual({ "--border": "1" });
    expect(cssVars(border, false)).toEqual({ "--border": "0" });
  });

  test("a bezier becomes cubic-bezier()", () => {
    expect(cssVars(ease, [0.2, 0.8, 0.2, 1])).toEqual({
      "--ease": "cubic-bezier(0.2, 0.8, 0.2, 1)",
    });
  });

  test("a spring sets its easing and its duration", () => {
    const vars = cssVars(pop, { stiffness: 170, damping: 26, mass: 1 });
    expect(vars["--pop"]).toStartWith("linear(0,");
    expect(vars["--pop-duration"]).toMatch(/^\d+ms$/);
  });
});

describe("outputValue", () => {
  test("is what the agent writes into source", () => {
    expect(outputValue(blur, 24)).toBe("24px");
    expect(outputValue(opacity, 0.62)).toBe(0.62);
    expect(outputValue(tint, "#ff7a59")).toBe("#ff7a59");
    expect(outputValue(border, true)).toBe(true);
    expect(outputValue(ease, [0.2, 0.8, 0.2, 1])).toBe(
      "cubic-bezier(0.2, 0.8, 0.2, 1)",
    );
    expect(
      outputValue(pop, { stiffness: 170, damping: 26, mass: 1 }),
    ).toMatchObject({
      stiffness: 170,
      damping: 26,
      mass: 1,
      easing: expect.stringMatching(/^linear\(/),
      duration: expect.stringMatching(/ms$/),
    });
  });

  test("rounds float noise from a slider to the step", () => {
    expect(outputValue(opacity, 0.6200000000000001)).toBe(0.62);
  });
});

describe("roundToStep", () => {
  test("keeps the decimals a non-decimal step needs", () => {
    expect(roundToStep(0.25, 0.25)).toBe(0.25);
    expect(roundToStep(0.4, 0.125)).toBe(0.375);
    expect(roundToStep(0.6200000000000001, 0.01)).toBe(0.62);
  });
});

describe("fine adjustment", () => {
  test("a value between steps survives into the CSS and the output", () => {
    expect(cssVars(blur, 24.1)).toEqual({ "--blur": "24.1px" });
    expect(outputValue(blur, 24.1)).toBe("24.1px");
  });
});

describe("fits", () => {
  test("accepts a saved value only when the current param can hold it", () => {
    expect(fits(blur, 30)).toBe(true);
    expect(fits(blur, 120)).toBe(false);
    expect(fits(blur, "30px")).toBe(false);
    expect(fits(tint, "#abc")).toBe(true);
    expect(fits(tint, 3)).toBe(false);
    expect(fits(border, false)).toBe(true);
    expect(fits(border, 1)).toBe(false);
    expect(fits(ease, [0.1, 0.2, 0.3, 0.4])).toBe(true);
    expect(fits(ease, 24)).toBe(false);
    expect(fits(pop, { stiffness: 1, damping: 1, mass: 1 })).toBe(true);
    expect(fits(pop, { stiffness: 1 })).toBe(false);
  });
});
