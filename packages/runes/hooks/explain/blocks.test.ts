import { expect, test } from "claude-code/testing";
import { hasDiagram, lineDiff } from "./blocks";
import { renderMain as finish } from "./html";

test("code keeps attribute-looking text the cleaner would strip", () => {
  const out = finish(
    `<pre class="code" data-lang="html"><a href="https://x" onclick="go()" style="c">hi</a></pre>`,
  );
  expect(out).toBe(
    `<pre class="code" data-lang="html"><code>&lt;a href=&quot;https://x&quot; onclick=&quot;go()&quot; style=&quot;c&quot;&gt;hi&lt;/a&gt;</code></pre>`,
  );
});

test("code a fork pre-escaped renders once, not as entities", () => {
  expect(finish(`<pre class="code">a &lt; b &amp;&amp; c</pre>`)).toBe(
    `<pre class="code" data-lang=""><code>a &lt; b &amp;&amp; c</code></pre>`,
  );
});

test("code drops a wrapping <code> and the blank lines around it", () => {
  expect(
    finish(
      `<pre class="code" data-lang="ts"><code>\n  x = 1;\n\n</code></pre>`,
    ),
  ).toBe(`<pre class="code" data-lang="ts"><code>  x = 1;</code></pre>`);
});

test("data-lang is escaped", () => {
  expect(finish(`<pre class="code" data-lang='"><b'>x</pre>`)).toContain(
    `data-lang="&quot;&gt;&lt;b"`,
  );
});

test("diff marks removed, added and unchanged lines", () => {
  const out = finish(
    `<figure class="diff"><pre class="before">a\nb\nc</pre><pre class="after">a\nB\nc\nd</pre></figure>`,
  );
  expect(out).toBe(
    `<pre class="diff"><code><span>a</span><span class="del">b</span><span class="add">B</span><span>c</span><span class="add">d</span></code></pre>`,
  );
});

test("a figure with a pre before the diff does not swallow it", () => {
  const out = finish(
    `<figure class="plate"><pre class="mermaid">A</pre><figcaption>c</figcaption></figure><figure class="diff"><pre class="before">a</pre><pre class="after">b</pre></figure>`,
  );
  expect(out).toContain(
    `<pre class="diff"><code><span class="del">a</span><span class="add">b</span></code></pre>`,
  );
});

test("diff keeps an empty line visible", () => {
  expect(
    finish(
      `<figure class="diff"><pre class="before">a\n\nb</pre><pre class="after">a\n\nc</pre></figure>`,
    ),
  ).toContain(`<span> </span>`);
});

test("mermaid is written as its source with the fallback note", () => {
  expect(finish(`<pre class="mermaid">flowchart LR\n  A --> B</pre>`)).toBe(
    `<pre class="code" data-lang="mermaid" data-pele><code>flowchart LR\n  A --&gt; B</code></pre><p class="render-note">This diagram could not render; its source is shown.</p>`,
  );
});

test("a placeholder the fork wrote itself splices nothing", () => {
  const out = finish(`<p><!--runes-block:0--></p><pre class="code">real</pre>`);
  expect(out).toBe(
    `<p><!--runes-block:0--></p><pre class="code" data-lang=""><code>real</code></pre>`,
  );
});

test("code that quotes the placeholder keeps it", () => {
  expect(finish(`<pre class="code">x = "<!--runes-block:0-->";</pre>`)).toBe(
    `<pre class="code" data-lang=""><code>x = &quot;&lt;!--runes-block:0--&gt;&quot;;</code></pre>`,
  );
});

test("a closing pre written as &lt;/pre&gt; stays inside the code and the diff", () => {
  expect(finish(`<pre class="code"><pre>a&lt;/pre&gt; b</pre>`)).toBe(
    `<pre class="code" data-lang=""><code>&lt;pre&gt;a&lt;/pre&gt; b</code></pre>`,
  );
  expect(
    finish(
      `<figure class="diff"><pre class="before">&lt;/pre&gt;</pre><pre class="after">x</pre></figure>`,
    ),
  ).toContain(`<span class="del">&lt;/pre&gt;</span>`);
});

test("a table is wrapped so it scrolls inside itself", () => {
  expect(finish(`<table><tr><td class="num">1</td></tr></table>`)).toBe(
    `<div class="table"><table><tr><td class="num">1</td></tr></table></div>`,
  );
});

test("everything else still goes through the cleaner", () => {
  expect(finish(`<p onclick="x">a</p><pre class="code">b</pre>`)).toBe(
    `<p>a</p><pre class="code" data-lang=""><code>b</code></pre>`,
  );
});

test("lineDiff past the cap removes everything, then adds everything", () => {
  const before = Array.from({ length: 300 }, (_, i) => `b${i}`).join("\n");
  const ops = lineDiff(before, "x");
  expect(ops.filter((o) => o.op === "del")).toHaveLength(300);
  expect(ops.at(-1)).toEqual({ op: "add", text: "x" });
});

test("hasDiagram finds a mermaid pre and nothing else", () => {
  expect(hasDiagram(`<pre class="x mermaid">A</pre>`)).toBe(true);
  expect(hasDiagram(`<pre class="code">mermaid</pre><p class="mermaid">x</p>`)).toBe(false);
});
