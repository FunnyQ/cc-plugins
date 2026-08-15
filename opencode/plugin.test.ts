import { describe, expect, test } from "bun:test";

import { QLabPlugin } from "./plugin";

const { guardVerdict, hookPayload, lintVerdict } = QLabPlugin;

describe("guardVerdict", () => {
  test("returns an ask message verbatim", () => {
    const message = "⚠️ Stop here\nConfirm first.";
    const stdout = JSON.stringify({
      hookSpecificOutput: { permissionDecision: "ask" },
      systemMessage: message,
    });

    expect(guardVerdict(0, stdout)).toBe(message);
  });

  test("returns null for a different decision", () => {
    const stdout = JSON.stringify({
      hookSpecificOutput: { permissionDecision: "allow" },
      systemMessage: "ignored",
    });

    expect(guardVerdict(0, stdout)).toBeNull();
  });

  test("returns null for empty stdout", () => {
    expect(guardVerdict(0, "")).toBeNull();
  });

  test("returns null for malformed JSON", () => {
    expect(guardVerdict(0, "not json")).toBeNull();
  });

  test("returns null for a non-zero exit", () => {
    const stdout = JSON.stringify({
      hookSpecificOutput: { permissionDecision: "ask" },
      systemMessage: "ignored",
    });

    expect(guardVerdict(1, stdout)).toBeNull();
  });
});

describe("lintVerdict", () => {
  test("returns stderr for exit code 2", () => {
    expect(lintVerdict(2, "lint failed\n")).toBe("lint failed\n");
  });

  test("returns null for empty stderr", () => {
    expect(lintVerdict(2, "")).toBeNull();
  });

  test("returns null for exit code 0", () => {
    expect(lintVerdict(0, "ignored")).toBeNull();
  });

  test("returns null for another non-zero exit", () => {
    expect(lintVerdict(1, "ignored")).toBeNull();
  });
});

describe("hookPayload", () => {
  test.each([
    ["command", "git status"],
    ["file_path", "/tmp/example.ts"],
  ] as const)("round-trips a %s payload", (kind, value) => {
    expect(JSON.parse(hookPayload(kind, value))).toEqual({
      tool_input: { [kind]: value },
    });
  });

  test("preserves quotes, newlines, and multi-byte characters", () => {
    const command = `printf "double" 'single'\n你好 👋`;

    expect(JSON.parse(hookPayload("command", command))).toEqual({
      tool_input: { command },
    });
  });
});
