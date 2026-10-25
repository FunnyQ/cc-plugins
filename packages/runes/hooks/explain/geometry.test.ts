import { expect, test } from "claude-code/testing";

import { faults } from "./geometry";
import type { Measure } from "./geometry";

const box = (x: number, y: number, w = 40, h = 14) => ({ x, y, w, h });
const page = (
  labels: Measure["svgs"][number]["labels"],
  scrollWidth = 1280,
): Measure => ({
  width: 1280,
  scrollWidth,
  svgs: [{ box: box(0, 0, 600, 200), labels }],
});

test("a clean figure has no faults", () => {
  expect(
    faults({
      1280: page([
        { text: "A", box: box(10, 10), onLine: false },
        { text: "B", box: box(60, 10), onLine: false },
      ]),
    }),
  ).toEqual([]);
});

test("labels that touch by a pixel are not an overlap; labels that cross are", () => {
  expect(
    faults({
      1280: page([
        { text: "A", box: box(10, 10), onLine: false },
        { text: "B", box: box(49, 10), onLine: false },
        { text: "C", box: box(100, 10), onLine: false },
        { text: "D", box: box(120, 15), onLine: false },
      ]),
    }),
  ).toEqual(['1280: figure 1 "C" overlaps "D"']);
});

test("a label past its svg's edge, on a line, or a page wider than its window is a fault", () => {
  expect(
    faults({
      420: page(
        [
          { text: "E", box: box(580, 10), onLine: false },
          { text: "F", box: box(10, 10), onLine: true },
        ],
        1400,
      ),
    }),
  ).toEqual([
    "420: page 1400px wide in a 1280px window",
    '420: figure 1 "E" outside its svg',
    '420: figure 1 "F" sits on a line',
  ]);
});
