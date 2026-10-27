import { readdirSync, readFileSync } from "node:fs";

import { expect, test } from "bun:test";

import { THEMES } from "../config";
import { renderMain } from "./html";
import { FRAGMENT_RULES } from "./protocol";

const DIR = `${import.meta.dir}/themes`;
const SLOTS = ["csp", "lang", "title", "project", "generatedAt", "main"];
const read = (theme: string) => readFileSync(`${DIR}/${theme}.html`, "utf8");
const styleOf = (html: string) =>
  /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "";

// the rules' own example markup, rendered, is what a theme receives: a diff figure arrives as pre.diff with del/add lines
const fragmentClasses = [
  ...new Set([
    ...[...renderMain(FRAGMENT_RULES).matchAll(/class="([^"]+)"/g)].flatMap(
      (m) => m[1]!.split(/\s+/),
    ),
    ...FRAGMENT_RULES.match(/(?<=SVG classes only: )[^.]+/)![0].split(/,\s*/),
  ]),
];

// every rule naming the selector, in source order, with the @container or @media it sits in
const rulesFor = (source: string, selector: string) => {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: { at: string; body: string }[] = [];
  let at = "";
  let depth = 0;
  for (const m of css.matchAll(/([^{}]*)\{|\}/g)) {
    if (m[0] === "}") {
      if (--depth === 0) at = "";
      continue;
    }
    const head = m[1]!.trim().replace(/\s+/g, " ");
    depth++;
    if (head.startsWith("@")) {
      at = head;
      continue;
    }
    if (!head.split(/\s*,\s*/).includes(selector)) continue;
    const end = css.indexOf("}", m.index! + m[0].length);
    out.push({ at, body: css.slice(m.index! + m[0].length, end) });
  }
  return out;
};
const fontSizes = (css: string, selector: string) =>
  rulesFor(css, selector).flatMap(({ at, body }) =>
    [...body.matchAll(/font-size:\s*([^;]+);/g)].map((s) => `${at} ${s[1]}`),
  );

// read as text: checker.ts imports the mod runtime, which bun:test cannot load
const [narrowLabel, narrowSoft] = readFileSync(
  `${import.meta.dir}/checker.ts`,
  "utf8",
)
  .match(/grow to (\d+px) \(label\) and (\d+px) \(label-soft\)/)!
  .slice(1);
const [first, last] = FRAGMENT_RULES.match(/letters ([a-z])–([a-z])/)!.slice(1);
const PART_LETTERS = Array.from(
  { length: last!.charCodeAt(0) - first!.charCodeAt(0) + 1 },
  (_, i) => String.fromCharCode(first!.charCodeAt(0) + i),
);

test("the theme files are exactly THEMES", () => {
  expect(
    readdirSync(DIR)
      .filter((f) => f.endsWith(".html"))
      .map((f) => f.replace(/\.html$/, ""))
      .sort(),
  ).toEqual([...THEMES].sort());
});

test("the fragment rules name the classes a theme must style", () => {
  expect(fragmentClasses).toContain("answer");
  expect(fragmentClasses).toContain("wash-sage");
  expect(fragmentClasses).toContain("label-soft");
  expect(fragmentClasses).toContain("del");
  expect(fragmentClasses).toContain("render-note");
  expect(fragmentClasses).not.toContain("before");
});

for (const theme of THEMES) {
  test(`${theme} carries every slot and the CSP meta`, () => {
    const html = read(theme);
    for (const slot of SLOTS) expect(html).toContain(`{{${slot}}}`);
    expect(html).toContain(
      'http-equiv="Content-Security-Policy" content="{{csp}}"',
    );
  });

  test(`${theme} styles every fragment class, pele, and its wash copy`, () => {
    const css = styleOf(read(theme));
    const missing = [...fragmentClasses, "pele", "wash"].filter(
      (c) => !new RegExp(`\\.${c}(?![\\w-])`).test(css),
    );
    expect(missing).toEqual([]);
  });

  test(`${theme} defines every url(#id) it references`, () => {
    const html = read(theme);
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    const used = [...html.matchAll(/url\(#([\w-]+)\)/g)].map((m) => m[1]);
    expect(used.filter((id) => !ids.has(id))).toEqual([]);
    expect(ids.has("wash")).toBe(true);
  });

  // the fork spaces labels and the checker judges them at one set of sizes, so no theme may move them or where they grow
  test(`${theme} sizes SVG labels as every theme does, growing to the checker's sizes`, () => {
    const base = styleOf(read(THEMES[0]));
    const css = styleOf(read(theme));
    for (const selector of [".plate .label", ".plate .label-soft"])
      expect(fontSizes(css, selector)).toEqual(fontSizes(base, selector));
    expect(fontSizes(css, ".plate .label").at(-1)).toEndWith(` ${narrowLabel}`);
    expect(fontSizes(css, ".plate .label-soft").at(-1)).toEndWith(
      ` ${narrowSoft}`,
    );
  });

  test(`${theme} lights a drawing's part for every part letter`, () => {
    const css = styleOf(read(theme));
    const missing = PART_LETTERS.filter(
      (p) =>
        !css.includes(
          `[data-part="${p}"]:hover) .plate .part[data-part="${p}"]`,
        ),
    );
    expect(missing).toEqual([]);
  });
}
