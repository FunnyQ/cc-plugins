import { describe, expect, test } from "bun:test";
import {
  buildRequest,
  groupFromAnswers,
  renderSuggestion,
  suggestGroups,
  type GroupInput,
} from "./typesafe-grouping";

const file = (path: string, diff = `+ change in ${path}`): GroupInput => ({
  path,
  status: "modified",
  insertions: 1,
  deletions: 0,
  diff,
});

const noul = (p: number) => ({ type: "noul", noul: p });
const choice = (c: string) => ({ type: "choice", choice: c, confidence: 1 });

function fakeFetch(answers: Record<string, unknown>, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ answers }), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("buildRequest", () => {
  test("asks one type Choice per file and one Noul per pair", () => {
    const body = buildRequest([file("a.ts"), file("b.ts"), file("c.ts")]);
    const keys = Object.keys(body.questions).sort();
    expect(keys).toEqual(
      ["pair:0:1", "pair:0:2", "pair:1:2", "type:0", "type:1", "type:2"].sort(),
    );
    expect(body.questions["type:0"]?.type).toBe("choice");
    expect(body.questions["pair:0:1"]?.type).toBe("noul");
    expect(body.model).toBe("jev-latest");
  });

  test("deduplicates a path listed both staged and unstaged", () => {
    const body = buildRequest([file("a.ts"), file("a.ts"), file("b.ts")]);
    expect(body.state.files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
  });

  test("keeps the state under the budget by shortening excerpts", () => {
    const huge = "+x\n".repeat(50_000);
    const body = buildRequest([file("a.ts", huge), file("b.ts", huge)]);
    expect(JSON.stringify(body.state).length).toBeLessThan(80_000);
  });
});

describe("groupFromAnswers", () => {
  test("joins pairs above the threshold transitively", () => {
    const groups = groupFromAnswers(["a", "b", "c", "d"], {
      "type:0": choice("feat"),
      "type:1": choice("test"),
      "type:2": choice("docs"),
      "type:3": choice("feat"),
      "pair:0:1": noul(0.9),
      "pair:1:3": noul(0.8),
      "pair:0:2": noul(0.2),
      "pair:0:3": noul(0.1),
      "pair:1:2": noul(0.1),
      "pair:2:3": noul(0.1),
    });
    expect(groups).toEqual([
      { files: ["a", "b", "d"], types: ["feat", "test", "feat"] },
      { files: ["c"], types: ["docs"] },
    ]);
  });
});

describe("suggestGroups", () => {
  test("reports a missing API key and never calls fetch", async () => {
    const { impl, calls } = fakeFetch({});
    for (const apiKey of [undefined, ""]) {
      expect(
        await suggestGroups([file("a"), file("b")], { apiKey, fetch: impl }),
      ).toEqual({ skipped: "TYPESAFE_API_KEY not set" });
    }
    expect(calls).toHaveLength(0);
  });

  test("returns null for fewer than two files or more than the cap", async () => {
    const { impl, calls } = fakeFetch({});
    expect(
      await suggestGroups([file("a")], { apiKey: "k", fetch: impl }),
    ).toBeNull();
    const many = Array.from({ length: 21 }, (_, i) => file(`f${i}`));
    expect(await suggestGroups(many, { apiKey: "k", fetch: impl })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("posts to the systemone endpoint with a bearer token", async () => {
    const { impl, calls } = fakeFetch({
      "type:0": choice("fix"),
      "type:1": choice("fix"),
      "pair:0:1": noul(0.95),
    });
    const result = await suggestGroups([file("a"), file("b")], {
      apiKey: "secret",
      fetch: impl,
    });
    expect(calls[0]?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(
      (calls[0]?.init.headers as Record<string, string>).Authorization,
    ).toBe("Bearer secret");
    expect(result).toEqual({
      groups: [{ files: ["a", "b"], types: ["fix", "fix"] }],
      ms: expect.any(Number),
    });
  });

  test("reports a skip instead of throwing when the API fails", async () => {
    const { impl } = fakeFetch({}, 429);
    const result = await suggestGroups([file("a"), file("b")], {
      apiKey: "k",
      fetch: impl,
    });
    expect(result).toEqual({ skipped: "HTTP 429", ms: expect.any(Number) });
  });

  test("reports a skip when the answers are incomplete", async () => {
    const { impl } = fakeFetch({ "type:0": choice("fix") });
    const result = await suggestGroups([file("a"), file("b")], {
      apiKey: "k",
      fetch: impl,
    });
    expect(result).toEqual({
      skipped: "response is missing answers",
      ms: expect.any(Number),
    });
  });
});

describe("renderSuggestion", () => {
  test("renders nothing for null", () => {
    expect(renderSuggestion(null)).toBe("");
  });

  test("renders one line per group", () => {
    const text = renderSuggestion({
      groups: [
        { files: ["a", "b"], types: ["feat", "test"] },
        { files: ["c"], types: ["docs"] },
      ],
      ms: 1,
    });
    expect(text).toContain("## Suggested groups");
    expect(text).toContain("1. a [feat], b [test]");
    expect(text).toContain("2. c [docs]");
  });

  test("names the reason when the call was skipped", () => {
    expect(renderSuggestion({ skipped: "TYPESAFE_API_KEY not set" })).toContain(
      "[TypeSafe grouping skipped: TYPESAFE_API_KEY not set]",
    );
  });

  test("names the time a failed call took", () => {
    expect(renderSuggestion({ skipped: "HTTP 429", ms: 812 })).toContain(
      "[TypeSafe grouping skipped after 812 ms: HTTP 429]",
    );
  });

  test("names the time a successful call took", () => {
    const text = renderSuggestion({
      groups: [{ files: ["a"], types: ["fix"] }],
      ms: 142,
    });
    expect(text).toContain("[TypeSafe grouping: 142 ms]");
  });
});
