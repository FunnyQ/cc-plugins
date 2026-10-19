import { describe, expect, test } from "bun:test";

const css = await Bun.file(new URL("./style.css", import.meta.url)).text();

const rules = [
  ...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{};]+)\{([^{}]*)\}/g),
].map(([, selector, body]) => ({ selector: selector.trim(), body }));

const rulesUsing = (name) => rules.filter((rule) => rule.body.includes(name));

describe("token ink", () => {
  test("only the fleet's per-agent figure takes tier ink, since a lane card and a graph berth total several agents", () => {
    for (const tier of ["var(--token-warn)", "var(--token-danger)"]) {
      expect(rulesUsing(tier).map((rule) => rule.selector)).toEqual([
        `.role-tokens.${tier.includes("warn") ? "-warn" : "-danger"}`,
      ]);
    }
    expect(
      rules.find((rule) => rule.selector === ".graph-tokens").body,
    ).not.toContain("--token-ink");
  });

  test("the codex accent inks only the lane card's figure and the model chip, never the tiered fleet figure", () => {
    expect(
      rulesUsing("var(--token-codex)").map((rule) => rule.selector),
    ).toEqual([".role-model.-codex", ".token-figure.-codex"]);
  });

  test("the fleet's codex figure sets no ink, so the tier rules still reach it", () => {
    expect(
      rules.find((rule) => rule.selector === ".role-tokens.-codex").body,
    ).not.toContain("--token-ink");
  });
});
