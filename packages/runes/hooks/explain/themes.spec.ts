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
}
