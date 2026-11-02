import { describe, expect, test } from "bun:test";
import { parseSpec, SpecError } from "./spec";

const SPEC_PATH = "/work/specs/card.json";
const minimal = (params: unknown[], extra: object = {}) => ({
  snippet: "card.html",
  params,
  ...extra,
});

describe("parseSpec", () => {
  test("fills defaults for an isolated spec and resolves the snippet beside the spec", () => {
    const spec = parseSpec(
      minimal([
        { id: "blur", type: "range", min: 0, max: 80, default: 24, unit: "px" },
      ]),
      SPEC_PATH,
    );
    expect(spec.mode).toBe("isolated");
    expect(spec.title).toBe("card");
    expect(spec.snippet).toBe("/work/specs/card.html");
    expect(spec.params[0]).toEqual({
      id: "blur",
      type: "range",
      label: "Blur",
      folder: "Params",
      bind: "css",
      target: ":root",
      min: 0,
      max: 80,
      step: 0.8,
      unit: "px",
      default: 24,
    });
  });

  test("duration defaults to a 0–2000 ms range", () => {
    const [p] = parseSpec(
      minimal([{ id: "enter-time", type: "duration", default: 420 }]),
      SPEC_PATH,
    ).params;
    expect(p).toMatchObject({
      type: "duration",
      min: 0,
      max: 2000,
      step: 10,
      unit: "ms",
      label: "Enter time",
    });
  });

  test("fills defaults for every non-numeric type", () => {
    const params = parseSpec(
      minimal([
        { id: "tint", type: "color" },
        { id: "mode", type: "select", options: ["warm", "cool"] },
        { id: "border", type: "toggle" },
        { id: "ease", type: "bezier" },
        { id: "pop", type: "spring" },
      ]),
      SPEC_PATH,
    ).params;
    expect(params.map((p) => p.default)).toEqual([
      "#000000",
      "warm",
      false,
      [0.25, 0.1, 0.25, 1],
      { stiffness: 170, damping: 26, mass: 1 },
    ]);
  });

  test("in-situ needs no snippet and keeps a spec-level target", () => {
    const spec = parseSpec(
      {
        mode: "in-situ",
        target: ".cta",
        params: [{ id: "glow", type: "range", min: 0, max: 1, default: 0.3 }],
      },
      SPEC_PATH,
    );
    expect(spec.snippet).toBeUndefined();
    expect(spec.params[0].target).toBe(".cta");
  });

  const rejects: [string, unknown, string][] = [
    ["no params", minimal([]), "params"],
    [
      "isolated without snippet",
      { params: [{ id: "a", type: "toggle" }] },
      "snippet",
    ],
    ["unknown type", minimal([{ id: "a", type: "knob" }]), '"a"'],
    [
      "duplicate id",
      minimal([
        { id: "a", type: "toggle" },
        { id: "a", type: "toggle" },
      ]),
      "duplicate",
    ],
    ["bad id", minimal([{ id: "a b", type: "toggle" }]), "id"],
    [
      "min above max",
      minimal([{ id: "blur", type: "range", min: 80, max: 0, default: 1 }]),
      '"blur"',
    ],
    [
      "default out of range",
      minimal([{ id: "blur", type: "range", min: 0, max: 10, default: 24 }]),
      '"blur"',
    ],
    [
      "bad colour",
      minimal([{ id: "c", type: "color", default: "orange" }]),
      '"c"',
    ],
    [
      "select default not an option",
      minimal([{ id: "s", type: "select", options: ["a"], default: "b" }]),
      '"s"',
    ],
    [
      "bezier x outside 0–1",
      minimal([{ id: "e", type: "bezier", default: [1.2, 0, 0.5, 1] }]),
      '"e"',
    ],
    [
      "bad mode",
      { mode: "live", params: [{ id: "a", type: "toggle" }] },
      "mode",
    ],
  ];
  for (const [name, raw, mention] of rejects) {
    test(`rejects ${name}`, () => {
      expect(() => parseSpec(raw, SPEC_PATH)).toThrow(SpecError);
      expect(() => parseSpec(raw, SPEC_PATH)).toThrow(mention);
    });
  }
});
