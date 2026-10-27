import { expect, test } from "claude-code/testing";

import { THEMES } from "../config";

import {
  BRIEF_AXES,
  buildPrompt,
  drawBrief,
  FRAGMENT_RULES,
  parseReply,
  RULES,
} from "./protocol";

test("RULES carries its six items in order", () => {
  const phrases = [
    "UI button",
    "high-school level",
    "recap",
    "`html` when",
    "<mode>text|html|ask</mode>",
    FRAGMENT_RULES,
  ];
  const at = phrases.map((p) => RULES.indexOf(p));
  expect(at.every((i) => i >= 0)).toBe(true);
  expect([...at].sort((a, b) => a - b)).toEqual(at);
  expect(RULES.includes("Q")).toBe(false);
});

test("FRAGMENT_RULES names every class and element", () => {
  const words = [
    "answer",
    "analogy",
    "section",
    "takeaway",
    "spread",
    "plate",
    "figcaption",
    "text",
    "parts",
    "data-part",
    "steps",
    "compare",
    "timeline",
    "ink",
    "ink-accent",
    "dash",
    "wash-warm",
    "wash-cool",
    "wash-sage",
    "label",
    "label-soft",
    "part",
    "viewBox",
    "title",
    "<table>",
    'class="num"',
    '<aside class="note">',
    '<aside class="warn">',
    '<pre class="code" data-lang=',
    '<figure class="diff">',
    '<pre class="before">',
    '<pre class="after">',
    '<pre class="mermaid">',
    "flowchart TD",
    "&lt;/pre&gt;",
  ];
  for (const w of words) expect(FRAGMENT_RULES.includes(w)).toBe(true);
});

test("buildPrompt starts with RULES and carries each kind's paragraph", () => {
  const cases = [
    [{ kind: "press" }, ["Pick the target per rule 3 and explain it."]],
    [
      { kind: "pick", topic: "the rollup DB" },
      ["Explain this topic: the rollup DB"],
    ],
    [
      {
        kind: "follow",
        previous: { title: "Old title", text: "old body" },
        question: "why so?",
      },
      ["your earlier explanation", "Old title", "old body", "why so?"],
    ],
    [
      { kind: "free", question: "what is a fork?" },
      ["The user asks: what is a fork?", "rule 4"],
    ],
  ] as const;
  for (const [ask, wants] of cases) {
    const out = buildPrompt(ask);
    expect(out.startsWith(`${RULES}\n\n`)).toBe(true);
    for (const w of wants) expect(out.includes(w)).toBe(true);
  }
});

test("buildPrompt clips previous.text at 4,000 characters", () => {
  const text = "a".repeat(4000) + "Z" + "b".repeat(999);
  const out = buildPrompt({
    kind: "follow",
    previous: { title: "t", text },
    question: "q",
  });
  expect(out.includes("a".repeat(4000))).toBe(true);
  expect(out.includes("Z")).toBe(false);
});

test("rule 1: first occurrence of each tag, trimmed, lowercase only", () => {
  expect(
    parseReply(
      "<mode>text</mode><title> One </title><title>Two</title><body> b1 </body><body>b2</body>",
    ),
  ).toEqual({ kind: "text", title: "One", body: "b1" });
  const raw = "<Mode>text</Mode><title>T</title><body>b</body>";
  expect(parseReply(raw)).toEqual({ kind: "text", title: "T", body: raw });
});

test("rule 2: missing title becomes Explanation", () => {
  expect(parseReply("<mode>text</mode><body>b</body>")).toEqual({
    kind: "text",
    title: "Explanation",
    body: "b",
  });
});

test("rule 3: a long title is cut to 59 characters plus an ellipsis", () => {
  const r = parseReply(
    `<mode>text</mode><title>${"x".repeat(70)}</title><body>b</body>`,
  );
  expect(r.title).toBe(`${"x".repeat(59)}…`);
  expect(r.title.length).toBe(60);
});

test("rule 4: missing mode falls back to text", () => {
  expect(parseReply("  <title>T</title>hello  ")).toEqual({
    kind: "text",
    title: "T",
    body: "<title>T</title>hello",
  });
});

test("rule 5: unknown mode falls back to text", () => {
  const raw = "<mode>pdf</mode><title>T</title>";
  expect(parseReply(raw)).toEqual({ kind: "text", title: "T", body: raw });
});

test("rule 6: text with empty or missing body falls back", () => {
  const empty = "<mode>text</mode><title>T</title><body>  </body>";
  expect(parseReply(empty)).toEqual({ kind: "text", title: "T", body: empty });
  const missing = "<mode>text</mode><title>T</title>";
  expect(parseReply(missing)).toEqual({
    kind: "text",
    title: "T",
    body: missing,
  });
});

test("rule 7: html with summary and main", () => {
  expect(
    parseReply(
      "<mode>html</mode><title>T</title><summary>S</summary><main>\n<p>M</p>\n</main>",
    ),
  ).toEqual({ kind: "html", title: "T", summary: "S", main: "<p>M</p>" });
});

test("an html reply carries the theme the fork picked, and drops one that names no theme", () => {
  expect(
    parseReply(
      "<mode>html</mode><title>T</title><theme> editorial </theme><summary>S</summary><main><p>M</p></main>",
    ),
  ).toEqual({
    kind: "html",
    title: "T",
    summary: "S",
    main: "<p>M</p>",
    theme: "editorial",
  });
  expect(
    parseReply(
      "<mode>html</mode><title>T</title><theme>neon</theme><summary>S</summary><main><p>M</p></main>",
    ),
  ).toEqual({ kind: "html", title: "T", summary: "S", main: "<p>M</p>" });
});

test("the grammar asks for a theme and names each one's fit", () => {
  const prompt = buildPrompt({ kind: "press" });
  for (const theme of THEMES) expect(prompt).toContain(`${theme}: `);
  expect(prompt).toContain("<theme>");
});

test("rule 8: html without main degrades to text with the summary", () => {
  expect(
    parseReply(
      "<mode>html</mode><title>T</title><summary>S</summary><main> </main>",
    ),
  ).toEqual({ kind: "text", title: "T", body: "S" });
  expect(
    parseReply("<mode>html</mode><title>T</title><summary>S</summary>"),
  ).toEqual({ kind: "text", title: "T", body: "S" });
});

test("rule 9: html with neither falls back", () => {
  const raw = "<mode>html</mode><title>T</title>";
  expect(parseReply(raw)).toEqual({ kind: "text", title: "T", body: raw });
});

test("rule 10: ask with options in reply order", () => {
  expect(
    parseReply(
      "<mode>ask</mode><title>T</title><question>Q?</question><option>b</option><option>\na\n</option>",
    ),
  ).toEqual({ kind: "ask", title: "T", question: "Q?", options: ["b", "a"] });
});

test("rule 11: ask with fewer than two non-empty options falls back", () => {
  const one =
    "<mode>ask</mode><title>T</title><question>Q?</question><option>a</option>";
  expect(parseReply(one)).toEqual({ kind: "text", title: "T", body: one });
  const blank =
    "<mode>ask</mode><title>T</title><question>Q?</question><option>a</option><option> </option>";
  expect(parseReply(blank)).toEqual({ kind: "text", title: "T", body: blank });
});

test("rule 12: ask keeps the first four of five options", () => {
  const opts = ["1", "2", "3", "4", "5"]
    .map((o) => `<option>${o}</option>`)
    .join("");
  expect(
    parseReply(
      `<mode>ask</mode><title>T</title><question>Q?</question>${opts}`,
    ),
  ).toEqual({
    kind: "ask",
    title: "T",
    question: "Q?",
    options: ["1", "2", "3", "4"],
  });
});

test("rule 13: ask without a question falls back", () => {
  const raw =
    "<mode>ask</mode><title>T</title><option>a</option><option>b</option>";
  expect(parseReply(raw)).toEqual({ kind: "text", title: "T", body: raw });
});

test("rule 14: main is returned raw, scripts included", () => {
  const main = "<p>x</p><script>alert(1)</script>";
  expect(
    parseReply(
      `<mode>html</mode><title>T</title><summary>S</summary><main>${main}</main>`,
    ),
  ).toEqual({ kind: "html", title: "T", summary: "S", main });
});

test("buildPrompt names the configured language for the whole reply, and keeps the session's language without one", () => {
  const set = buildPrompt({ kind: "press" }, "zh-TW");
  expect(set.startsWith(RULES)).toBe(true);
  expect(set).toContain("Write the whole reply, the title included, in zh-TW.");
  expect(buildPrompt({ kind: "press" })).not.toContain("Write the whole reply");
  expect(buildPrompt({ kind: "press" }, "  ")).not.toContain(
    "Write the whole reply",
  );
});

test("drawBrief takes one option per axis from the random draw", () => {
  const axes = Object.keys(BRIEF_AXES) as (keyof typeof BRIEF_AXES)[];
  const first = drawBrief(() => 0);
  const last = drawBrief(() => 0.999);
  for (const axis of axes) {
    expect(first[axis]).toBe(BRIEF_AXES[axis][0]);
    expect(last[axis]).toBe(BRIEF_AXES[axis].at(-1)!);
  }
});

test("buildPrompt appends the brief after everything else, scoped to html", () => {
  const brief = drawBrief(() => 0.5);
  const plain = buildPrompt({ kind: "press" }, "zh-TW");
  const out = buildPrompt({ kind: "press" }, "zh-TW", brief);
  expect(out.startsWith(`${plain}\n\n`)).toBe(true);
  const tail = out.slice(plain.length);
  expect(tail).toContain("If you reply in html");
  expect(tail).toContain("never overrides");
  expect(tail).toContain("decides rule 2's analogy choice");
  for (const option of Object.values(brief)) expect(tail).toContain(option);
});
