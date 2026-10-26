import { expect, test } from "bun:test";
import { Glob } from "bun";
import { join } from "node:path";

const dist = join(import.meta.dir, "dist");
const files = [
  ...new Glob("styles/*.css").scanSync(dist),
  ...new Glob("modules/*.js").scanSync(dist),
  ...new Glob("partials/**/*.html").scanSync(dist),
  "index.html",
  "app.js",
];

test("every var(--name) in the dashboard is defined somewhere or carries a fallback", async () => {
  const defined = new Set<string>();
  const used: Array<{ name: string; file: string }> = [];
  for (const file of files) {
    const text = await Bun.file(join(dist, file)).text();
    for (const m of text.matchAll(/(?:^|[\s;{"'(,])(--[\w-]+)\s*:/g))
      defined.add(m[1]!);
    for (const m of text.matchAll(/setProperty\(\s*["'`](--[\w-]+)/g))
      defined.add(m[1]!);
    for (const m of text.matchAll(/var\(\s*(--[\w-]+)\s*([,)])/g)) {
      if (m[2] === ")") used.push({ name: m[1]!, file });
    }
  }
  const missing = used
    .filter((u) => !defined.has(u.name))
    .map((u) => `${u.name} (${u.file})`);
  expect(missing).toEqual([]);
});
