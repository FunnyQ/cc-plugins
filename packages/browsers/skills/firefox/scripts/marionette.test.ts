import { describe, expect, test } from "bun:test";
import {
  encodeFrame,
  FrameReader,
  settle,
} from "./marionette";

describe("encodeFrame", () => {
  test("prefixes the JSON body with its byte length, not its character count", () => {
    const frame = encodeFrame([0, 1, "WebDriver:Navigate", { url: "開" }]);
    const body = JSON.stringify([0, 1, "WebDriver:Navigate", { url: "開" }]);

    expect(frame).toBe(`${Buffer.byteLength(body)}:${body}`);
    expect(Buffer.byteLength(body)).toBeGreaterThan(body.length);
  });
});

describe("FrameReader", () => {
  test("reassembles a frame split across chunks", () => {
    const reader = new FrameReader();
    const frame = encodeFrame([1, 7, null, { value: "ok" }]);

    expect(reader.push(Buffer.from(frame.slice(0, 5)))).toEqual([]);
    expect(reader.push(Buffer.from(frame.slice(5)))).toEqual([
      [1, 7, null, { value: "ok" }],
    ]);
  });

  test("splits two frames delivered in one chunk", () => {
    const reader = new FrameReader();
    const chunk =
      encodeFrame({ applicationType: "gecko" }) + encodeFrame([1, 1, null, {}]);

    expect(reader.push(Buffer.from(chunk))).toEqual([
      { applicationType: "gecko" },
      [1, 1, null, {}],
    ]);
  });

  // Byte length, not string length: a multibyte character must not shift the cut.
  test("cuts on bytes when a body carries multibyte text split mid-character", () => {
    const reader = new FrameReader();
    const bytes = Buffer.from(encodeFrame([1, 2, null, { value: "開始" }]));
    const cut = bytes.length - 4;

    expect(reader.push(bytes.subarray(0, cut))).toEqual([]);
    expect(reader.push(bytes.subarray(cut))).toEqual([
      [1, 2, null, { value: "開始" }],
    ]);
  });
});

describe("settle", () => {
  test("returns the result of a successful response", () => {
    expect(settle([1, 3, null, { value: 42 }])).toEqual({ value: 42 });
  });

  test("throws the browser's error and message on a failed response", () => {
    expect(() =>
      settle([
        1,
        3,
        { error: "no such element", message: "Unable to locate #x" },
        null,
      ]),
    ).toThrow("no such element: Unable to locate #x");
  });
});
