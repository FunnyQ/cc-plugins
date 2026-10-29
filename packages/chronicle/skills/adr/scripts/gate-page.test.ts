import { describe, expect, test } from "bun:test";
import {
  openerCommands,
  renderGatePage,
  serveGatePage,
  type GatePayload,
} from "./gate-page";

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
  test("omits the send control without a submit endpoint", () => {
    expect(renderGatePage(GATE1)).not.toContain('id="send"');
    expect(renderGatePage(GATE2)).not.toContain('id="send"');
  });

  test("adds the send control for both gates and locales", () => {
    for (const payload of [GATE1, GATE2]) {
      for (const lang of ["en", "zh-TW"] as const) {
        const submitUrl = "http://127.0.0.1:3210/nonce/submit";
        const html = renderGatePage({ ...payload, lang } as any, { submitUrl });
        expect(html).toContain('id="send"');
        expect(html).toContain(submitUrl);
      }
    }
  });

  test("a closing script tag in the submit URL cannot break out", () => {
    const html = renderGatePage(GATE1, {
      submitUrl: "http://127.0.0.1/</script><svg onload=1>",
    });
    expect(html).not.toContain("</script><svg");
  });

  test("a substitution pattern in the submit URL survives verbatim", () => {
    const submitUrl = "http://127.0.0.1/x$&$'y/submit";
    const html = renderGatePage(GATE1, { submitUrl });
    expect(html).toContain(JSON.stringify(submitUrl));
    expect(html).not.toContain("__SUBMIT_HANDLER__");
  });

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
    expect(() =>
      renderGatePage({ gate: 3, lang: "en" } as unknown as GatePayload),
    ).toThrow();
  });
});

describe("serveGatePage", () => {
  test("serves one nonce-scoped page and accepts one JSON response", async () => {
    const gate = serveGatePage({
      nonce: "test-nonce",
      render: (submitUrl) => `page:${submitUrl}`,
    });
    try {
      const page = await fetch(gate.url);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(page.headers.get("cache-control")).toBe("no-store");
      expect(await page.text()).toBe(`page:${gate.submitUrl}`);
      expect((await fetch(`${gate.url}/unknown`)).status).toBe(404);

      const submitted = { verdicts: [{ verdict: "approve" }] };
      const reply = await fetch(gate.submitUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(submitted),
      });
      expect(reply.status).toBe(200);
      expect(await reply.json()).toEqual({ ok: true });
      expect(await gate.response).toEqual(submitted);
    } finally {
      gate.stop();
    }
  });

  test("rejects invalid and oversized bodies without resolving", async () => {
    const gate = serveGatePage({
      nonce: "body-test",
      render: () => "page",
      timeoutMs: 10_000,
    });
    try {
      expect(
        (
          await fetch(gate.submitUrl, {
            method: "POST",
            body: "{broken",
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await fetch(gate.submitUrl, {
            method: "POST",
            body: "x".repeat(2 * 1024 * 1024 + 1),
          })
        ).status,
      ).toBe(413);

      const marker = Symbol("pending");
      expect(await Promise.race([gate.response, Promise.resolve(marker)])).toBe(
        marker,
      );
    } finally {
      gate.stop();
    }
  });

  test("resolves null after the timeout", async () => {
    const gate = serveGatePage({ render: () => "page", timeoutMs: 5 });
    try {
      expect(await gate.response).toBeNull();
    } finally {
      gate.stop();
    }
  });
});

function extractPayload(html: string): any {
  const m = html.match(
    /<script type="application\/json" id="payload">([\s\S]*?)<\/script>/,
  );
  if (!m) throw new Error("payload block not found");
  return JSON.parse(m[1].replace(/\\u003c/g, "<"));
}

describe("openerCommands", () => {
  const url = "http://127.0.0.1:1/";
  const notWsl = () => "Linux version 6.1.0 (gcc)";

  test("darwin uses open", () => {
    expect(openerCommands(url, "darwin", {}, notWsl)).toEqual([["open", url]]);
  });

  test("win32 runs start through cmd with an empty title", () => {
    expect(openerCommands(url, "win32", {}, notWsl)).toEqual([
      ["cmd", "/c", "start", "", url],
    ]);
  });

  const wsl = [
    ["wslview", url],
    ["cmd.exe", "/c", "start", "", url],
  ];

  test("WSL detected by WSL_DISTRO_NAME tries wslview then cmd.exe", () => {
    expect(
      openerCommands(url, "linux", { WSL_DISTRO_NAME: "Ubuntu" }, notWsl),
    ).toEqual(wsl);
  });

  test("WSL detected by /proc/version", () => {
    expect(
      openerCommands(
        url,
        "linux",
        {},
        () => "Linux 5.15-microsoft-standard-WSL2 Microsoft",
      ),
    ).toEqual(wsl);
  });

  test("plain linux uses xdg-open", () => {
    expect(openerCommands(url, "linux", {}, notWsl)).toEqual([
      ["xdg-open", url],
    ]);
  });

  test("an unreadable /proc/version means not WSL", () => {
    const boom = () => {
      throw new Error("ENOENT");
    };
    expect(openerCommands(url, "linux", {}, boom)).toEqual([["xdg-open", url]]);
  });
});
