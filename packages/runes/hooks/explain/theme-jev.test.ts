import { expect, test } from "claude-code/testing";

import { jevTheme, themeInventory } from "./theme-jev";
import type { Post } from "../transcript/jev";

const MAIN = [
  "<section><h2>Why the <em>fork</em> waits</h2><p>prose that must stay home</p>",
  '<ol class="timeline"><li><time>10:00</time><b>start</b> it ran</li></ol></section>',
  "<section><h2>Ask alice@example.com about sk-abcdefghijklmnopqrstu</h2><table><tr><td>1</td></tr></table></section>",
  '<pre class="code" data-lang="html">&lt;h2&gt;not a heading&lt;/h2&gt;<h2>quoted</h2></pre>',
].join("");

test("the inventory carries the scrubbed title, each h2's text and the structure flags, and no prose", () => {
  const inv = themeInventory("Token sk-abcdefghijklmnopqrstu flow", MAIN);
  expect(inv).toEqual({
    title: "Token [key] flow",
    headings: ["Why the fork waits", "Ask [email] about [key]"],
    timeline: true,
    diff: false,
    diagram: false,
    table: true,
    code: true,
  });
  expect(JSON.stringify(inv)).not.toContain("prose");
});

test("the inventory cuts a long heading to 80 characters and sees a diff and a diagram", () => {
  const inv = themeInventory(
    "T",
    `<h2>${"x".repeat(200)}</h2><figure class="diff"><pre class="before">a</pre><pre class="after">b</pre></figure><figure class="plate"><pre class="mermaid">flowchart TD\nA-->B</pre></figure>`,
  );
  expect(inv.headings[0]).toHaveLength(80);
  expect(inv).toEqual(
    expect.objectContaining({
      diff: true,
      diagram: true,
      table: false,
      timeline: false,
    }),
  );
});

test("the inventory decodes character references before it masks, so an encoded secret is still masked", () => {
  const inv = themeInventory(
    "Mail alice&#64;example.com",
    "<h2>Token sk&#45;abcdefghijklmnopqrstu &amp; mail bob&#x40;example.com</h2>",
  );
  expect(inv.title).toBe("Mail [email]");
  expect(inv.headings).toEqual(["Token [key] & mail [email]"]);
});

test("the flags read single-quoted classes and ignore a block quoted inside a code sample", () => {
  const quoted = themeInventory(
    "T",
    "<ol class='timeline'><li>a</li></ol><figure class='diff'><pre class='before'>a</pre><pre class='after'>b</pre></figure><pre class='code'>x</pre>",
  );
  expect(quoted).toEqual(
    expect.objectContaining({ timeline: true, diff: true, code: true }),
  );
  const inCode = themeInventory(
    "T",
    '<pre class="code" data-lang="html">&lt;figure class="diff"&gt;<figure class="diff"></figure><ol class="timeline"></ol><table></table></pre>',
  );
  expect(inCode).toEqual(
    expect.objectContaining({ code: true, diff: false, timeline: false, table: false }),
  );
});

const posting = (answer: () => Promise<{ ok: boolean; text: string }>) => {
  const bodies: Record<string, unknown>[] = [];
  const post: Post = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return answer();
  };
  return { post, bodies };
};

const probs = (p: Record<string, number>) =>
  Promise.resolve({
    ok: true,
    text: JSON.stringify({ answers: { theme: { probabilities: p } } }),
  });

test("jevTheme sends the inventory as state and takes Jev's likeliest theme", async () => {
  const { post, bodies } = posting(() =>
    probs({
      "picture-book": 0.1,
      blueprint: 0.2,
      "lab-notebook": 0.1,
      editorial: 0.6,
    }),
  );
  const inv = themeInventory("Recap", MAIN);
  expect(await jevTheme({ post, apiKey: "k" }, inv)).toBe("editorial");
  expect(bodies[0]!.state).toEqual(inv);
  expect(
    Object.keys(
      (bodies[0]!.questions as { theme: { criteria: object } }).theme.criteria,
    ),
  ).toEqual(["picture-book", "blueprint", "lab-notebook", "editorial"]);
});

test("jevTheme answers nothing when Jev throws, refuses, or names no theme", async () => {
  const inv = themeInventory("T", "<p>x</p>");
  const thrown = posting(() => Promise.reject(new Error("jev timeout")));
  expect(
    await jevTheme({ post: thrown.post, apiKey: "k" }, inv),
  ).toBeUndefined();
  const refused = posting(() => Promise.resolve({ ok: false, text: "" }));
  expect(
    await jevTheme({ post: refused.post, apiKey: "k" }, inv),
  ).toBeUndefined();
  const stray = posting(() => probs({ neon: 0.9 }));
  expect(
    await jevTheme({ post: stray.post, apiKey: "k" }, inv),
  ).toBeUndefined();
});
