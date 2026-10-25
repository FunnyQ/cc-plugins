import { expect, test } from "claude-code/testing";
import {
  assemble,
  cleanMain,
  CSP,
  explainerPath,
  slugOf,
  writeExplainer,
} from "./html";

const page = { title: "T", main: "<p>m</p>", project: "p", generatedAt: "g" };

test("assemble escapes title, project and generatedAt", () => {
  const out = assemble("{{title}}|{{project}}|{{generatedAt}}", {
    ...page,
    title: `a&<b>"'`,
    project: "<x>",
    generatedAt: "1 & 2",
  });
  expect(out).toBe("a&amp;&lt;b&gt;&quot;&#39;|&lt;x&gt;|1 &amp; 2");
});

test("assemble inserts main raw, keeping $& and placeholders it carries", () => {
  const main = '<p class="answer">$& $1 {{ message }} {{title}}</p>';
  expect(assemble("{{main}}", { ...page, main })).toBe(main);
});

// the kit loads only code files, so this is the template's placeholder lines; the Verification greps check the real file
const template = `<meta http-equiv="Content-Security-Policy" content="{{csp}}" />
<title>{{title}}</title>
<span>{{project}} · explained</span><time>{{generatedAt}}</time>
<h1>{{title}}</h1>
<main>{{main}}</main>`;

test("every placeholder of the template is replaced and the CSP lands", () => {
  const out = assemble(template, { ...page, title: "Twice" });
  for (const p of [
    "{{csp}}",
    "{{title}}",
    "{{project}}",
    "{{generatedAt}}",
    "{{main}}",
  ]) {
    expect(out.includes(p)).toBe(false);
  }
  expect(out.split("Twice").length - 1).toBe(2);
  expect(
    out.includes(
      `content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"`,
    ),
  ).toBe(true);
});

test("cleanMain drops a meta refresh", () => {
  expect(
    cleanMain(
      '<p class="answer">hi</p><meta http-equiv="refresh" content="0;url=https://example.com/">',
    ),
  ).toBe('<p class="answer">hi</p>');
});

test("cleanMain drops a meta refresh spliced across a removed tag", () => {
  expect(
    cleanMain(
      '<me<base>ta http-equiv="refresh" content="0;url=https://example.com/"><p>hi</p>',
    ),
  ).toBe("<p>hi</p>");
});

test("cleanMain strips scripts, handlers, styles, base and external links", () => {
  const out = cleanMain(
    '<script>alert(1)</script><p onclick="x()" style="color:red">a</p><base href="https://e.com/"><a href="https://e.com">b</a><a href="#part-a">c</a>',
  );
  expect(out).toBe('<p>a</p><a>b</a><a href="#part-a">c</a>');
});

test("cleanMain keeps inline svg and every component class", () => {
  const main = [
    '<p class="answer">a</p>',
    '<p class="analogy">b</p>',
    '<section class="spread"><figure class="plate"><svg viewBox="0 0 10 10"><title>t</title><rect class="wash-warm part" data-part="a"/></svg><figcaption>Plate 1.</figcaption></figure><div class="text"><h2>h</h2></div></section>',
    '<dl class="parts"><div data-part="a"><dt>A</dt><dd><b>x</b>y</dd></div></dl>',
    '<ol class="steps"><li>s</li></ol>',
    '<div class="compare"><div><h3>Before</h3>x</div><div><h3>After</h3>y</div></div>',
    '<ol class="timeline"><li><time>09:40</time><b>i</b>z</li></ol>',
    '<p class="takeaway">t</p>',
  ].join("");
  expect(cleanMain(main)).toBe(main);
});

test("slugOf", () => {
  expect(slugOf("Fork vs Jev: who routes?")).toBe("fork-vs-jev-who-routes");
  expect(slugOf("為什麼用 fork")).toBe("為什麼用-fork");
  expect(slugOf("?!")).toBe("explainer");
  expect(slugOf("")).toBe("explainer");
  const long = slugOf(
    "a very long title that keeps going and going and going on",
  );
  expect([...long].length <= 40).toBe(true);
  expect(long.endsWith("-")).toBe(false);
});

test("explainerPath zero-pads and slugs the project", () => {
  expect(
    explainerPath("/h", "My Project", new Date(2026, 0, 5, 7, 3), "Hi there"),
  ).toBe(
    "/h/.local/share/q-lab/runes/explain/my-project/20260105-0703-hi-there.html",
  );
});

const memoryIo = (files: Map<string, string>, dirs: string[]) => ({
  read: async (p: string) => files.get(p) ?? "",
  write: async (p: string, t: string) => void files.set(p, t),
  exists: async (p: string) => files.has(p),
  mkdir: async (d: string) => void dirs.push(d),
});

test("writeExplainer makes the dir, suffixes -2 and -3, never overwrites", async () => {
  const files = new Map([
    ["/r/hooks/explain/template.html", "<time>{{generatedAt}}</time>{{main}}"],
  ]);
  const dirs: string[] = [];
  const io = memoryIo(files, dirs);
  const at = new Date(2026, 9, 5, 14, 2);
  const dir = "/h/.local/share/q-lab/runes/explain/proj";
  const args = [
    "/r",
    "/h",
    { title: "T", main: "<p>x</p>", project: "proj" },
    at,
  ] as const;

  expect(await writeExplainer(io, ...args)).toBe(`${dir}/20261005-1402-t.html`);
  expect(dirs).toEqual([dir]);
  expect(files.get(`${dir}/20261005-1402-t.html`)).toBe(
    "<time>5 Oct 2026 · 14:02</time><p>x</p>",
  );

  files.set(`${dir}/20261005-1402-t.html`, "keep");
  expect(await writeExplainer(io, ...args)).toBe(
    `${dir}/20261005-1402-t-2.html`,
  );
  expect(await writeExplainer(io, ...args)).toBe(
    `${dir}/20261005-1402-t-3.html`,
  );
  expect(files.get(`${dir}/20261005-1402-t.html`)).toBe("keep");
});

test("assemble writes a language tag into {{lang}}, and leaves it empty for a name that is not one", () => {
  expect(assemble('<html lang="{{lang}}">', { ...page, lang: "zh-TW" })).toBe('<html lang="zh-TW">');
  expect(assemble('<html lang="{{lang}}">', { ...page, lang: " ja " })).toBe('<html lang="ja">');
  expect(assemble('<html lang="{{lang}}">', { ...page, lang: "Traditional Chinese" })).toBe('<html lang="">');
  expect(assemble('<html lang="{{lang}}">', { ...page, lang: 'en" onload="x' })).toBe('<html lang="">');
  expect(assemble('<html lang="{{lang}}">', page)).toBe('<html lang="">');
});
