import { describe, expect, test } from "bun:test";
import { nextCursor, splitCompleteLines } from "./tail";

describe("splitCompleteLines", () => {
  test("returns complete lines", () => {
    expect(splitCompleteLines("one\ntwo\n")).toEqual({
      complete: ["one", "two"],
      partial: "",
    });
  });

  test("holds a trailing partial line", () => {
    expect(splitCompleteLines("one\ntwo")).toEqual({
      complete: ["one"],
      partial: "two",
    });
  });

  test("handles empty input", () => {
    expect(splitCompleteLines("")).toEqual({ complete: [], partial: "" });
  });

  test("handles a single partial line", () => {
    expect(splitCompleteLines("one")).toEqual({
      complete: [],
      partial: "one",
    });
  });

  test("preserves empty complete lines", () => {
    expect(splitCompleteLines("\n\npartial")).toEqual({
      complete: ["", ""],
      partial: "partial",
    });
  });

  test("keeps carriage returns for the parser to trim", () => {
    expect(splitCompleteLines("one\r\ntwo\r\n")).toEqual({
      complete: ["one\r", "two\r"],
      partial: "",
    });
  });
});

describe("nextCursor", () => {
  test("advances from the previous cursor", () => {
    expect(nextCursor(4, 9)).toEqual({ from: 4, reset: false });
  });

  test("resets after truncation", () => {
    expect(nextCursor(9, 4)).toEqual({ from: 0, reset: true });
  });

  test("does not reset when the file is unchanged", () => {
    expect(nextCursor(9, 9)).toEqual({ from: 9, reset: false });
  });
});
