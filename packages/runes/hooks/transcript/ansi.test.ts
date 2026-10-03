import { expect, test } from "claude-code/testing";

import { parseAnsi, xterm256 } from "./ansi";

test("xterm256 maps the cube and the grey ramp to hex", () => {
  expect(xterm256(1)).toBe("#800000");
  expect(xterm256(196)).toBe("#ff0000");
  expect(xterm256(232)).toBe("#080808");
  expect(xterm256(255)).toBe("#eeeeee");
});

test("parseAnsi splits a line into styled runs and merges equal neighbours", () => {
  expect(
    parseAnsi("\x1b[38;5;196;1mhi\x1b[m\x1b[38;5;196;1m!\x1b[m plain"),
  ).toEqual([
    { text: "hi!", color: "#ff0000", bold: true },
    { text: " plain" },
  ]);
});

test("parseAnsi reads truecolor, background and the off codes", () => {
  expect(parseAnsi("\x1b[48;2;1;2;3;3mx\x1b[23my\x1b[0m")).toEqual([
    { text: "x", backgroundColor: "#010203", italic: true },
    { text: "y", backgroundColor: "#010203" },
  ]);
});

test("parseAnsi drops OSC hyperlinks and keeps their text", () => {
  expect(parseAnsi("\x1b]8;;https://a.b\x1b\\link\x1b]8;;\x1b\\")).toEqual([
    { text: "link" },
  ]);
});
