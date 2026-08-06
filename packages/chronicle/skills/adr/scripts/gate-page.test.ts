import { describe, expect, test } from "bun:test";
import { renderGatePage } from "./gate-page";

const GATE1 = {
  gate: 1 as const,
  lang: "en" as const,
  scan: { sessions: 7, entries: 41, clusters: 2, conflicts: 0, tooFresh: 0 },
  nextAdr: 27,
  candidates: [
    {
      entryIds: ["aaaa1111"],
      title: "First decision",
      reason: "Durable and long-lived.",
      disposition: "promote" as const,
    },
    {
      entryIds: ["bbbb2222", "cccc3333"],
      title: "Second decision",
      reason: "Already recorded.",
      disposition: "skip" as const,
      matchesAdr: "ADR-0017",
    },
  ],
};

const GATE2 = {
  gate: 2 as const,
  lang: "en" as const,
  drafts: [
    {
      groupId: "g1",
      adrNumber: 27,
      proposedPath: "/repo/docs/adr/0027-a-thing.md",
      draftText: "# ADR-0027: A thing\n\n- Status: Accepted\n",
    },
  ],
};

describe("renderGatePage", () => {
  test("gate 1 embeds every candidate in the payload", () => {
    const html = renderGatePage(GATE1);
    const payload = extractPayload(html);
    expect(payload.candidates).toHaveLength(2);
    expect(payload.candidates[1].entryIds).toEqual(["bbbb2222", "cccc3333"]);
    expect(payload.nextAdr).toBe(27);
  });

  test("gate 2 embeds every draft verbatim", () => {
    const html = renderGatePage(GATE2);
    const payload = extractPayload(html);
    expect(payload.drafts).toHaveLength(1);
    expect(payload.drafts[0].draftText).toBe(GATE2.drafts[0].draftText);
  });

  test("both gates carry a title and the shared stylesheet", () => {
    for (const p of [GATE1, GATE2]) {
      const html = renderGatePage(p);
      expect(html).toContain("<title>");
      expect(html).toContain("--promote:");
      expect(html).toContain('id="out"');
    }
  });

  // The payload rides inside a <script> block, so an unescaped "</script>" in
  // any candidate title or draft body would close it early and blank the page.
  test("a closing script tag in the content cannot break out", () => {
    const html = renderGatePage({
      ...GATE2,
      drafts: [
        {
          ...GATE2.drafts[0],
          draftText: "before </script><svg onload=1> after",
        },
      ],
    });
    expect(html).not.toContain("</script><svg");
    expect(extractPayload(html).drafts[0].draftText).toBe(
      "before </script><svg onload=1> after",
    );
  });

  test("markup in a candidate title is escaped in the visible ledger", () => {
    const html = renderGatePage({
      ...GATE1,
      candidates: [{ ...GATE1.candidates[0], title: "<svg onload=alert(1)>" }],
    });
    expect(html).not.toContain("<svg onload=");
    expect(html).toContain("&lt;svg onload=");
  });

  test("zh-TW swaps the chrome without touching the data", () => {
    const html = renderGatePage({ ...GATE1, lang: "zh-TW" });
    expect(html).toContain("確認處置");
    expect(extractPayload(html).candidates[0].title).toBe("First decision");
  });

  test("an unknown gate is rejected rather than rendered empty", () => {
    // @ts-expect-error deliberately out of contract
    expect(() => renderGatePage({ gate: 3, lang: "en" })).toThrow();
  });
});

function extractPayload(html: string): any {
  const m = html.match(
    /<script type="application\/json" id="payload">([\s\S]*?)<\/script>/,
  );
  if (!m) throw new Error("payload block not found");
  return JSON.parse(m[1].replace(/\\u003c/g, "<"));
}
