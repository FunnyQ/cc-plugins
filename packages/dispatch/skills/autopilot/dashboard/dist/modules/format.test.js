import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  PER_AGENT_TOKEN_DANGER,
  PER_AGENT_TOKEN_WARN,
  SCORE_MAX,
  allHarnessTokens,
  formatModel,
  formatDuration,
  formatModelList,
  formatTokens,
  freshTokens,
  hasTokenReading,
  percent,
  renderRationale,
  renderRubric,
  tokenTier,
  totalTokens,
  waveHint,
} from "./format.js";

const source = (name) => readFileSync(new URL(name, import.meta.url), "utf8");

describe("formatTokens", () => {
  test("reports missing measurements as unavailable, never zero", () => {
    expect(formatTokens(undefined)).toBe("N/A");
    expect(formatTokens(null)).toBe("N/A");
  });

  test("reports non-finite input as unavailable", () => {
    expect(formatTokens(NaN)).toBe("N/A");
    expect(formatTokens(Infinity)).toBe("N/A");
    expect(formatTokens(-Infinity)).toBe("N/A");
  });

  test("reports a negative count as unavailable", () => {
    expect(formatTokens(-1)).toBe("N/A");
  });

  test("renders a real zero as a measured zero", () => {
    expect(formatTokens(0)).toBe("0");
  });

  test("renders the plain integer under 1,000", () => {
    expect(formatTokens(999)).toBe("999");
  });

  test("renders the worked K and M examples", () => {
    expect(formatTokens(1000)).toBe("1.0K");
    expect(formatTokens(8545)).toBe("8.5K");
    expect(formatTokens(278146)).toBe("278.1K");
    expect(formatTokens(7183857)).toBe("7.2M");
  });
});

describe("tokenTier", () => {
  test("tiers on the documented thresholds, inclusive at each step", () => {
    expect(tokenTier(0)).toBe("-normal");
    expect(tokenTier(PER_AGENT_TOKEN_WARN - 1)).toBe("-normal");
    expect(tokenTier(PER_AGENT_TOKEN_WARN)).toBe("-warn");
    expect(tokenTier(PER_AGENT_TOKEN_DANGER - 1)).toBe("-warn");
    expect(tokenTier(PER_AGENT_TOKEN_DANGER)).toBe("-danger");
    expect(tokenTier(7_183_857)).toBe("-danger");
  });

  test("keeps the thresholds at 60K and 100K", () => {
    expect(PER_AGENT_TOKEN_WARN).toBe(60_000);
    expect(PER_AGENT_TOKEN_DANGER).toBe(100_000);
  });

  test("gives no tier to everything formatTokens calls N/A", () => {
    for (const absent of [undefined, null, NaN, Infinity, -Infinity, -1]) {
      expect(formatTokens(absent)).toBe("N/A");
      expect(tokenTier(absent)).toBe("");
      expect(hasTokenReading(absent)).toBe(false);
    }
  });
});

describe("freshTokens", () => {
  const counts = {
    input: 305,
    output: 4795,
    cacheRead: 1_252_822,
    cacheWrite: 44_920,
  };

  // The real verify:foundation/01#2 row. Claude Code's Execute panel read 44.9k for
  // it, which is cacheWrite alone — the billed total is 1.3M and input+output+cacheWrite
  // is 50,020, and neither renders as 44.9k.
  test("is the cache-creation counter alone, matching the harness panel", () => {
    expect(freshTokens(counts)).toBe(44_920);
    expect(formatTokens(freshTokens(counts))).toBe("44.9K");
  });

  test("ignores cache reads, which carry 94-96% of the billed total", () => {
    expect(freshTokens(counts)).not.toBe(totalTokens(counts));
  });

  test("keeps an absent counts object absent, never a measured zero", () => {
    expect(freshTokens(undefined)).toBe(undefined);
    expect(freshTokens(null)).toBe(undefined);
    expect(formatTokens(freshTokens(undefined))).toBe("N/A");
  });

  test("reads a missing or unusable counter as a measured zero", () => {
    expect(freshTokens({ output: 5 })).toBe(0);
    expect(freshTokens({ cacheWrite: "x" })).toBe(0);
    expect(formatTokens(freshTokens({ output: 5 }))).toBe("0");
  });
});

describe("allHarnessTokens", () => {
  const claude = { input: 0, output: 0, cacheRead: 9_000, cacheWrite: 788_700 };
  const codex = { input: 0, output: 0, cacheRead: 9_000, cacheWrite: 488_500 };

  test("sums every harness into the one figure the header prints, unlike the per-side rows", () => {
    expect(allHarnessTokens(claude, codex)).toBe(1_277_200);
  });

  test("an absent harness contributes zero rather than voiding the total", () => {
    expect(allHarnessTokens(claude, undefined)).toBe(788_700);
    expect(allHarnessTokens(undefined, undefined)).toBe(0);
  });

  test("counts only fresh tokens, never the cache reads beside them", () => {
    expect(allHarnessTokens(claude)).toBe(claude.cacheWrite);
  });
});

describe("totalTokens", () => {
  test("sums all four billed counters", () => {
    expect(
      totalTokens({ input: 1, output: 20, cacheRead: 300, cacheWrite: 4000 }),
    ).toBe(4321);
  });

  test("keeps an absent counts object absent, never a measured zero", () => {
    expect(totalTokens(undefined)).toBe(undefined);
    expect(totalTokens(null)).toBe(undefined);
    expect(formatTokens(totalTokens(undefined))).toBe("N/A");
  });

  test("renders a fully zero reading as a measured zero", () => {
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    expect(totalTokens(zero)).toBe(0);
    expect(formatTokens(totalTokens(zero))).toBe("0");
  });

  test("treats a missing or unusable counter as nothing, not as NaN", () => {
    expect(totalTokens({ output: 5 })).toBe(5);
    expect(totalTokens({ input: "x", output: 5 })).toBe(5);
  });
});

describe("hasTokenReading", () => {
  test("accepts every count formatTokens prints a number for, so a measured 0 is not an unknown", () => {
    for (const present of [0, 1, 999, 92_400, 7_183_857]) {
      expect(hasTokenReading(present)).toBe(true);
      expect(formatTokens(present)).not.toBe("N/A");
    }
  });
});

describe("waveHint", () => {
  test("says the count includes the wave in flight", () => {
    expect(
      waveHint({ current: 2, remaining: 2, sizes: [3, 1], unschedulable: [] }),
    ).toBe(
      "Wave 2 in flight · 2 waves left, counting the one in flight: 3 → 1 tasks",
    );
  });

  test("drops the wave number before the first scout", () => {
    expect(
      waveHint({ current: 0, remaining: 1, sizes: [4], unschedulable: [] }),
    ).toBe("1 wave left, counting the one in flight: 4 tasks");
  });

  test("names the tasks no wave can reach", () => {
    expect(
      waveHint({
        current: 1,
        remaining: 0,
        sizes: [],
        unschedulable: ["api/01", "api/02"],
      }),
    ).toBe(
      "Wave 1 in flight · No waves left to fly · 2 task(s) no wave can reach: api/01, api/02",
    );
  });

  test("survives a payload with no wave field at all", () => {
    expect(waveHint(undefined)).toBe("No waves left to fly");
  });
});

describe("renderRationale", () => {
  test("promotes the judge's headings, starting at h3 under the page h1 and panel h2", () => {
    expect(renderRationale("# Verdict\n\n## The blocking defect")).toBe(
      "<h3>Verdict</h3><h4>The blocking defect</h4>",
    );
  });

  test("keeps a paragraph's own line breaks and separates on a blank line", () => {
    expect(renderRationale("one\ntwo\n\nthree")).toBe(
      "<p>one\ntwo</p><p>three</p>",
    );
  });

  test("marks the two inline forms judges actually write", () => {
    expect(renderRationale("**FAIL** at `init.rs:27`")).toBe(
      "<p><strong>FAIL</strong> at <code>init.rs:27</code></p>",
    );
  });

  test("reads single asterisks as emphasis without breaking a bold run", () => {
    expect(renderRationale("**bold** and *soft* alike")).toBe(
      "<p><strong>bold</strong> and <em>soft</em> alike</p>",
    );
  });

  test("leaves emphasis inside backticks literal", () => {
    expect(renderRationale("`**not bold**`")).toBe(
      "<p><code>**not bold**</code></p>",
    );
  });

  test("fences a code block and keeps its language on the element", () => {
    expect(renderRationale("```rust\nlet x = 1;\n```")).toBe(
      '<pre data-lang="rust"><code>let x = 1;</code></pre>',
    );
  });

  test("renders a fence the judge has not closed yet, as a running agent's trail ends half-written", () => {
    expect(renderRationale("```\nhalf a line")).toBe(
      "<pre><code>half a line</code></pre>",
    );
  });

  test("groups consecutive bullets into one list, ordered ones into another", () => {
    expect(renderRationale("- a\n- b\n1. c")).toBe(
      "<ul><li>a</li><li>b</li></ul><ol><li>c</li></ol>",
    );
  });

  test("keeps the judge's own starting number, so a step 0 is never printed as step 1", () => {
    expect(renderRationale("0. zero\n1. one")).toBe(
      '<ol start="0"><li>zero</li><li>one</li></ol>',
    );
    expect(renderRationale("1. one\n2. two")).toBe(
      "<ol><li>one</li><li>two</li></ol>",
    );
  });

  test("folds a hard-wrapped item back into the item it continues, never restarting the numbering", () => {
    expect(renderRationale("1. first line\nwrapped on\n2. second")).toBe(
      "<ol><li>first line\nwrapped on</li><li>second</li></ol>",
    );
  });

  test("a blank line still ends the list, so prose after it is prose", () => {
    expect(renderRationale("- a\n\nafter")).toBe(
      "<ul><li>a</li></ul><p>after</p>",
    );
  });

  test("reads a rule as a rule, not as a bullet", () => {
    expect(renderRationale("a\n\n---\n\nb")).toBe("<p>a</p><hr><p>b</p>");
  });

  test("escapes markup the judge quoted, including inside a fence, since no sanitizer ships", () => {
    expect(renderRationale("<b>x</b> & 'y'")).toBe(
      "<p>&lt;b&gt;x&lt;/b&gt; &amp; &#039;y&#039;</p>",
    );
    expect(renderRationale("```\n<script>alert(1)</script>\n```")).toBe(
      "<pre><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>",
    );
  });

  test("refuses a fence whose info string could reach the attribute", () => {
    expect(renderRationale('```js"onload=alert(1)')).toBe(
      "<p>```js&quot;onload=alert(1)</p>",
    );
  });

  test("renders nothing for an absent rationale", () => {
    expect(renderRationale(undefined)).toBe("");
    expect(renderRationale("")).toBe("");
  });
});

describe("formatModel", () => {
  test("renders each Claude family as its bare family word", () => {
    expect(formatModel("claude-opus-5")).toBe("opus");
    expect(formatModel("claude-haiku-4-5-20251001")).toBe("haiku");
    expect(formatModel("claude-sonnet-5")).toBe("sonnet");
  });

  test("turns dashes to spaces for any other id", () => {
    expect(formatModel("gpt-6-astra")).toBe("gpt 6 astra");
  });

  test("falls back to dash-to-space for an id matching no known family, never a blank that reads as no model", () => {
    expect(formatModel("mystery-model-9")).toBe("mystery model 9");
  });
});

describe("formatModelList", () => {
  test("formats then dedupes so near-identical ids collapse to one chip", () => {
    expect(formatModelList(["claude-opus-5", "claude-opus-5-1"])).toBe("opus");
  });

  test("joins distinct labels with a slash", () => {
    expect(formatModelList(["claude-opus-5", "claude-sonnet-5"])).toBe(
      "opus / sonnet",
    );
  });

  test("formats a codex id through the same dash-to-space fallback", () => {
    expect(formatModelList(["gpt-6-astra"])).toBe("gpt 6 astra");
  });

  test("renders nothing for an absent or empty list", () => {
    expect(formatModelList(undefined)).toBe("");
    expect(formatModelList(null)).toBe("");
    expect(formatModelList([])).toBe("");
  });
});

describe("shared score rendering", () => {
  test("keeps SCORE_MAX on the 0-5 rubric scale ScoreEntry.weighted uses", () => {
    expect(SCORE_MAX).toBe(5);
    expect(percent(5)).toBe("100%");
  });

  test("fleet and lanes import the score meter from here and define no copy", () => {
    for (const panel of ["./fleet.js", "./lanes.js"]) {
      const text = source(panel);
      const imports = text.match(/import \{([^}]*)\} from "\.\/format\.js"/)?.[1] ?? "";
      for (const name of ["percent", "formatScore", "scoreClass"]) {
        expect(imports).toContain(name);
        expect(text).not.toMatch(new RegExp(`(function|const|let) ${name}\\b`));
      }
      expect(text).not.toMatch(/SCORE_MAX\s*=/);
    }
  });
});

describe("formatDuration", () => {
  test("keeps a decimal under a minute and drops it past one", () => {
    expect(formatDuration(4_200)).toBe("4.2s");
    expect(formatDuration(59_900)).toBe("59.9s");
    expect(formatDuration(61_000)).toBe("1m 1s");
  });

  test("stays within the seven characters a berth plate reserves", () => {
    for (const ms of [0, 59_900, 600_000, 3_599_000]) {
      expect(formatDuration(ms).length).toBeLessThanOrEqual(7);
    }
  });
});

describe("renderRubric", () => {
  const breakdown = [{ name: "tests", weight: 1, score: 4 }];

  test("renders an older verdict with bars and no prose as the bars alone", () => {
    const html = renderRubric({ breakdown });
    expect(html).toContain('class="dimension"');
    expect(html).not.toContain("rationale");
  });

  test("renders nothing for a verdict with neither bars nor prose", () => {
    expect(renderRubric({})).toBe("");
  });
});
