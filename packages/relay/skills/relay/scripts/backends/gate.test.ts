import { describe, expect, test } from "bun:test";
import { capabilityGate, getBackend } from "./gate";
import type { Backend, Mode } from "../types";

function fakeBackend(name: string, supports: Mode[]): Backend {
  return {
    name,
    supports: new Set(supports),
    strategy: () => "prompt",
    invoke: () => ({ argv: [] }),
    parseOutput: (raw) => raw,
  };
}

describe("getBackend", () => {
  test("returns undefined for unknown names", () => {
    const registry = {
      x: fakeBackend("x", ["delegate"]),
    };

    expect(getBackend(registry, "nope")).toBeUndefined();
  });

  test("returns the matching backend from the registry", () => {
    const registry = {
      x: fakeBackend("x", ["delegate"]),
    };

    expect(getBackend(registry, "x")).toBe(registry.x);
  });
});

describe("capabilityGate", () => {
  test("returns null for supported pairs", () => {
    const backend = fakeBackend("x", ["delegate"]);

    expect(capabilityGate(backend, "delegate")).toBeNull();
  });

  test("returns a message naming the mode and backend for unsupported pairs", () => {
    const backend = fakeBackend("x", ["delegate"]);
    const result = capabilityGate(backend, "review");

    expect(result).toBeString();
    expect(result).toContain("review");
    expect(result).toContain("x");
    expect(result).not.toBe("");
  });
});
