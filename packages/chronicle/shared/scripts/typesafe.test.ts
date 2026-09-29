import { describe, expect, test } from "bun:test";

import { askJev, renderJevLine } from "./typesafe";

function fakeFetch(answers: Record<string, unknown>, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ answers }), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const questions = { q: { type: "noul" as const, instructions: "Is it?" } };

describe("askJev", () => {
  test("reports a missing key and never calls fetch", async () => {
    const { impl, calls } = fakeFetch({});
    for (const apiKey of [undefined, ""]) {
      expect(
        await askJev({ state: {}, questions }, { apiKey, fetch: impl }),
      ).toEqual({
        skipped: "TYPESAFE_API_KEY not set",
      });
    }
    expect(calls).toHaveLength(0);
  });

  test("posts with a bearer token and returns answers with the round trip", async () => {
    const { impl, calls } = fakeFetch({ q: { type: "noul", noul: 0.9 } });
    const result = await askJev(
      { state: { a: 1 }, questions },
      { apiKey: "k", fetch: impl },
    );
    expect(calls[0]?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(
      (calls[0]?.init.headers as Record<string, string>).Authorization,
    ).toBe("Bearer k");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      model: "jev-latest",
      state: { a: 1 },
      questions,
    });
    expect(result).toEqual({
      answers: { q: { type: "noul", noul: 0.9 } },
      ms: expect.any(Number),
    });
  });

  test("reports an HTTP failure with its time", async () => {
    const { impl } = fakeFetch({}, 401);
    expect(
      await askJev({ state: {}, questions }, { apiKey: "k", fetch: impl }),
    ).toEqual({
      skipped: "HTTP 401",
      ms: expect.any(Number),
    });
  });

  test("reports answers missing for an asked question", async () => {
    const { impl } = fakeFetch({});
    expect(
      await askJev({ state: {}, questions }, { apiKey: "k", fetch: impl }),
    ).toEqual({
      skipped: "response is missing answers",
      ms: expect.any(Number),
    });
  });

  test("reports a thrown fetch error", async () => {
    const impl = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(
      await askJev({ state: {}, questions }, { apiKey: "k", fetch: impl }),
    ).toEqual({
      skipped: "offline",
      ms: expect.any(Number),
    });
  });
});

describe("renderJevLine", () => {
  test("names the time of a successful call", () => {
    expect(renderJevLine("classify", { answers: {}, ms: 290 })).toBe(
      "[TypeSafe classify: 290 ms]",
    );
  });

  test("names the time and reason of a failed call", () => {
    expect(renderJevLine("classify", { skipped: "HTTP 429", ms: 812 })).toBe(
      "[TypeSafe classify skipped after 812 ms: HTTP 429]",
    );
  });

  test("names the reason when no call was made", () => {
    expect(
      renderJevLine("classify", { skipped: "TYPESAFE_API_KEY not set" }),
    ).toBe("[TypeSafe classify skipped: TYPESAFE_API_KEY not set]");
  });
});
