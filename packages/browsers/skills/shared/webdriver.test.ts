import { describe, expect, test } from "bun:test";
import { keyEvent, keyText, parseSize } from "./webdriver";

describe("parseSize", () => {
  test("reads WIDTHxHEIGHT", () => {
    expect(parseSize("1440x900")).toEqual({ width: 1440, height: 900 });
  });

  test("rejects anything else", () => {
    expect(() => parseSize("1440")).toThrow("--size must look like 1440x900");
  });
});

describe("keyText", () => {
  test("maps a named key to its WebDriver code point", () => {
    expect(keyText("Enter")).toBe("");
    expect(keyText("ArrowDown")).toBe("");
  });

  test("passes a single character through", () => {
    expect(keyText("a")).toBe("a");
  });

  test("rejects a key it does not know", () => {
    expect(() => keyText("Hyper")).toThrow("unknown key Hyper");
  });
});

describe("keyEvent", () => {
  test("gives Enter the carriage return Chrome needs to submit a form", () => {
    expect(keyEvent("Enter")).toEqual({
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      text: "\r",
    });
  });

  test("gives an arrow key no text, so it moves instead of typing", () => {
    expect(keyEvent("ArrowDown")).toEqual({
      key: "ArrowDown",
      code: "ArrowDown",
      windowsVirtualKeyCode: 40,
    });
  });

  test("types a single character as itself", () => {
    expect(keyEvent("a")).toEqual({
      key: "a",
      text: "a",
      windowsVirtualKeyCode: 65,
    });
  });

  test("rejects a key it does not know", () => {
    expect(() => keyEvent("Hyper")).toThrow("unknown key Hyper");
  });
});
