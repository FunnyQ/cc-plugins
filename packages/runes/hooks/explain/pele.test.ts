import { expect, test } from "claude-code/testing";
import { prepareBlocks } from "./blocks";
import { upgradeDiagrams } from "./pele";

const withBlocks = (...sources: string[]) => {
  const p = prepareBlocks(
    sources.map((s) => `<pre class="mermaid">${s}</pre>`).join(""),
  );
  return p.splice(p.main);
};

test("a diagram that renders replaces its fallback with the cleaned svg", () => {
  const seen: string[] = [];
  const out = upgradeDiagrams(withBlocks("A --> B"), (source) => {
    seen.push(source);
    return `<svg class="pele" viewBox="0 0 1 1" style="--_fg:red"><a href="https://x"><text>A</text></a></svg>`;
  });
  expect(seen).toEqual(["A --> B"]);
  expect(out).toBe(`<svg class="pele" viewBox="0 0 1 1"><text>A</text></svg>`);
});

test("a diagram that throws keeps its fallback, and the others still render", () => {
  const out = upgradeDiagrams(withBlocks("bad", "good"), (source) => {
    if (source === "bad") throw new Error("Parse error");
    return `<svg class="pele"></svg>`;
  });
  expect(out).toContain(`data-pele><code>bad</code>`);
  expect(out).toContain("could not render");
  expect(out.endsWith(`<svg class="pele"></svg>`)).toBe(true);
});

test("each diagram gets its own id prefix", () => {
  const prefixes: string[] = [];
  upgradeDiagrams(withBlocks("a", "b"), (_, idPrefix) => {
    prefixes.push(idPrefix);
    return "<svg></svg>";
  });
  expect(prefixes).toEqual(["pele-1-", "pele-2-"]);
});

test("a page with no diagram comes back unchanged", () => {
  const html = `<p>x</p><pre class="code" data-lang="ts"><code>a</code></pre>`;
  expect(upgradeDiagrams(html, () => "<svg></svg>")).toBe(html);
});

test("each node gets a wash copy of its shape behind it, and a click link is unwrapped", () => {
  const svg =
    `<svg class="pele"><g class="pele-node pele-shape-rect" data-id="A"><rect x="1" fill="var(--_s)"/><text>A</text></g>` +
    `<g class="pele-node clickable" data-id="B"><a rel="noopener"><path d="M0"/><path d="M1" fill="none"/><text>B</text></a></g></svg>`;
  expect(upgradeDiagrams(withBlocks("x"), () => svg)).toBe(
    `<svg class="pele"><g class="pele-node pele-shape-rect" data-id="A"><rect class="wash" x="1" fill="var(--_s)"/><rect x="1" fill="var(--_s)"/><text>A</text></g>` +
      `<g class="pele-node clickable" data-id="B"><path class="wash" d="M0"/><path d="M0"/><path d="M1" fill="none"/><text>B</text></g></svg>`,
  );
});
