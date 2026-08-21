import { describe, expect, test } from "bun:test";

import { formatEvalResult, keyDescriptor, MODIFIERS } from "./ops";

describe("formatEvalResult", () => {
  test("prints a string bare, so the agent reads a value not a quote", () => {
    expect(formatEvalResult({ type: "string", value: "hello" })).toBe("hello");
  });

  test("prints numbers and booleans bare", () => {
    expect(formatEvalResult({ type: "number", value: 42 })).toBe("42");
    expect(formatEvalResult({ type: "boolean", value: false })).toBe("false");
  });

  test("prints undefined and null as themselves", () => {
    expect(formatEvalResult({ type: "undefined" })).toBe("undefined");
    expect(formatEvalResult({ type: "object", subtype: "null", value: null })).toBe(
      "null",
    );
  });

  test("compacts an object to one line; pretty JSON is the token leak", () => {
    expect(
      formatEvalResult({ type: "object", value: { a: 1, b: [2, 3] } }),
    ).toBe('{"a":1,"b":[2,3]}');
  });

  test("falls back to the description when there is no value", () => {
    expect(
      formatEvalResult({ type: "function", description: "function f() {}" }),
    ).toBe("function f() {}");
  });

  test("empty string stays empty rather than becoming a quote pair", () => {
    expect(formatEvalResult({ type: "string", value: "" })).toBe("");
  });
});

describe("keyDescriptor", () => {
  test("names Enter with the code the page expects", () => {
    expect(keyDescriptor("Enter")).toMatchObject({
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      text: "\r",
    });
  });

  test("carries no text for a key that inserts nothing", () => {
    expect(keyDescriptor("Tab").text).toBeUndefined();
    expect(keyDescriptor("Escape").text).toBeUndefined();
  });

  test("maps the arrows", () => {
    expect(keyDescriptor("ArrowDown")).toMatchObject({
      code: "ArrowDown",
      windowsVirtualKeyCode: 40,
    });
  });

  test("treats a single character as itself, and types it", () => {
    expect(keyDescriptor("a")).toMatchObject({ key: "a", code: "KeyA", text: "a" });
  });

  test("splits a chord into modifiers plus the final key", () => {
    expect(keyDescriptor("Control+a")).toMatchObject({
      key: "a",
      modifiers: MODIFIERS.Control,
    });
  });

  test("sums several modifiers", () => {
    expect(keyDescriptor("Control+Shift+Enter").modifiers).toBe(
      MODIFIERS.Control + MODIFIERS.Shift,
    );
  });

  test("a modified key inserts no text, or the chord would type a letter", () => {
    expect(keyDescriptor("Control+a").text).toBeUndefined();
  });

  test("rejects an unknown key name rather than sending a no-op", () => {
    expect(() => keyDescriptor("Wingding")).toThrow(/Wingding/);
  });
});
