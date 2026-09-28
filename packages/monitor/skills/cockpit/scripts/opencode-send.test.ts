import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleOpenCodeControlStatus,
  handleSendOpenCodeMessage,
  type OpenCodeSendReport,
} from "./opencode-send";

const SID = "ses_1331e37f0ffeUdVFaTgUqoSGKY";
const TOKEN = "tok";

let dir: string;

function req(body: unknown): Request {
  return new Request("http://127.0.0.1/api/send-opencode-message", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function report(
  overrides: Partial<OpenCodeSendReport> = {},
): OpenCodeSendReport {
  return {
    ok: true,
    ready: true,
    serverUrl: "http://127.0.0.1:9123",
    sessionFound: true,
    delivered: true,
    delivery: "tui",
    warnings: [],
    errors: [],
    ...overrides,
  };
}

// Cleared per test, so neither the shell's OpenCode settings nor a real
// opencode 2.x service on this machine reaches a test.
const ISOLATED_ENV = [
  "COCKPIT_HOME",
  "XDG_STATE_HOME",
  "OPENCODE_SERVER_URL",
  "OPENCODE_TUI_SERVER_URL",
  "OPENCODE_PASSWORD",
  "OPENCODE_SERVER_PASSWORD",
  "OPENCODE_SERVER_USERNAME",
];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(ISOLATED_ENV.map((k) => [k, process.env[k]]));
  for (const k of ISOLATED_ENV) delete process.env[k];
  dir = mkdtempSync(join(tmpdir(), "cockpit-opencode-send-"));
  process.env.COCKPIT_HOME = dir;
  process.env.XDG_STATE_HOME = join(dir, "state");
  writeFileSync(
    join(dir, "daemon.json"),
    JSON.stringify({ pid: process.pid, port: 5858, token: TOKEN }),
  );
});

afterEach(() => {
  for (const k of ISOLATED_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("handleSendOpenCodeMessage", () => {
  test("sends text through the OpenCode prompt API", async () => {
    const calls: any[] = [];
    const r = await handleSendOpenCodeMessage(
      req({ session: SID, text: "hello", token: TOKEN }),
      async (opts) => {
        calls.push(opts);
        return report();
      },
    );

    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      delivered: true,
      delivery: "tui",
      serverUrl: "http://127.0.0.1:9123",
      warnings: [],
    });
    expect(calls).toEqual([{ sessionId: SID, text: "hello" }]);
  });

  test("rejects auth, invalid session, and empty text", async () => {
    expect(
      (
        await handleSendOpenCodeMessage(
          req({ session: SID, text: "x", token: "bad" }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await handleSendOpenCodeMessage(
          req({ session: "bad", text: "x", token: TOKEN }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handleSendOpenCodeMessage(
          req({ session: SID, text: " ", token: TOKEN }),
        )
      ).status,
    ).toBe(400);
  });

  test("returns OpenCode errors when prompt delivery fails", async () => {
    const r = await handleSendOpenCodeMessage(
      req({ session: SID, text: "hello", token: TOKEN }),
      async () =>
        report({
          ok: false,
          ready: false,
          delivered: false,
          errors: ["OpenCode session not found"],
        }),
    );

    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({
      error: "OpenCode session not found",
      warnings: [],
    });
  });
});

describe("sendOpenCodePrompt", () => {
  test("uses the official TUI prompt control API", async () => {
    const { sendOpenCodePrompt } = await import("./opencode-send");
    const originalFetch = globalThis.fetch;
    const calls: { url: string; init?: RequestInit }[] = [];
    process.env.OPENCODE_TUI_SERVER_URL = "http://127.0.0.1:4888";
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === "http://127.0.0.1:4888/global/health") {
        return Response.json({ healthy: true, version: "1.17.7" });
      }
      if (url === `http://127.0.0.1:4888/session/${SID}`) {
        return Response.json({
          id: SID,
          directory: "/tmp/project",
        });
      }
      if (
        url ===
        "http://127.0.0.1:4888/tui/append-prompt?directory=%2Ftmp%2Fproject"
      ) {
        return Response.json(true);
      }
      if (
        url ===
        "http://127.0.0.1:4888/tui/submit-prompt?directory=%2Ftmp%2Fproject"
      ) {
        return Response.json(true);
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const result = await sendOpenCodePrompt({
        sessionId: SID,
        text: "hello",
      });

      expect(result.ok).toBe(true);
      expect(result.delivered).toBe(true);
      expect(result.delivery).toBe("tui");
      expect(result.warnings.join(" ")).toContain("opencode upgrade");
      const appendCall = calls.at(-2);
      const submitCall = calls.at(-1);
      expect(appendCall?.url).toBe(
        "http://127.0.0.1:4888/tui/append-prompt?directory=%2Ftmp%2Fproject",
      );
      expect(JSON.parse(String(appendCall?.init?.body))).toEqual({
        text: "hello",
      });
      expect(submitCall?.url).toBe(
        "http://127.0.0.1:4888/tui/submit-prompt?directory=%2Ftmp%2Fproject",
      );
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.OPENCODE_TUI_SERVER_URL;
    }
  });

  test("passes OpenCode server basic auth when configured", async () => {
    const { sendOpenCodePrompt } = await import("./opencode-send");
    const originalFetch = globalThis.fetch;
    const authHeaders: string[] = [];
    process.env.OPENCODE_TUI_SERVER_URL = "http://127.0.0.1:4889";
    process.env.OPENCODE_SERVER_USERNAME = "q";
    process.env.OPENCODE_SERVER_PASSWORD = "secret";
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      authHeaders.push(headers.get("authorization") || "");
      if (url === "http://127.0.0.1:4889/global/health") {
        return Response.json({ healthy: true, version: "1.17.7" });
      }
      if (url === `http://127.0.0.1:4889/session/${SID}`) {
        return Response.json({ id: SID, directory: "/tmp/project" });
      }
      if (url.startsWith("http://127.0.0.1:4889/tui/")) {
        return Response.json(true);
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const result = await sendOpenCodePrompt({
        sessionId: SID,
        text: "hello",
      });

      expect(result.delivered).toBe(true);
      // health, session, upgrade toast, append, submit
      expect(authHeaders).toEqual([
        "Basic cTpzZWNyZXQ=",
        "Basic cTpzZWNyZXQ=",
        "Basic cTpzZWNyZXQ=",
        "Basic cTpzZWNyZXQ=",
        "Basic cTpzZWNyZXQ=",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.OPENCODE_TUI_SERVER_URL;
      delete process.env.OPENCODE_SERVER_USERNAME;
      delete process.env.OPENCODE_SERVER_PASSWORD;
    }
  });
});

describe("opencode 1.x upgrade notice", () => {
  test("toasts the TUI once per server, even across sends", async () => {
    const { sendOpenCodePrompt } = await import("./opencode-send");
    const originalFetch = globalThis.fetch;
    const toasts: any[] = [];
    process.env.OPENCODE_TUI_SERVER_URL = "http://127.0.0.1:4890";
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url.endsWith("/global/health")) {
        return Response.json({ healthy: true, version: "1.17.7" });
      }
      if (url.endsWith(`/session/${SID}`)) {
        return Response.json({ id: SID, directory: "/tmp/project" });
      }
      if (url.endsWith("/tui/show-toast")) {
        toasts.push(JSON.parse(String(init?.body)));
        return Response.json(true);
      }
      if (url.includes("/tui/")) return Response.json(true);
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const first = await sendOpenCodePrompt({ sessionId: SID, text: "a" });
      const second = await sendOpenCodePrompt({ sessionId: SID, text: "b" });
      expect(first.delivered && second.delivered).toBe(true);
      expect(toasts).toHaveLength(1);
      expect(toasts[0].variant).toBe("warning");
      expect(toasts[0].message).toContain("opencode upgrade");
      expect(second.warnings.join(" ")).toContain("opencode upgrade");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a failed toast does not block the send", async () => {
    const { sendOpenCodePrompt } = await import("./opencode-send");
    const originalFetch = globalThis.fetch;
    process.env.OPENCODE_TUI_SERVER_URL = "http://127.0.0.1:4891";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/global/health")) {
        return Response.json({ healthy: true, version: "1.17.7" });
      }
      if (url.endsWith(`/session/${SID}`)) {
        return Response.json({ id: SID, directory: "/tmp/project" });
      }
      if (url.endsWith("/tui/show-toast")) throw new Error("no toast route");
      if (url.includes("/tui/")) return Response.json(true);
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const result = await sendOpenCodePrompt({ sessionId: SID, text: "a" });
      expect(result.delivered).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("sendOpenCodePrompt on an opencode 2.x service", () => {
  const SERVICE = "http://127.0.0.1:49374";
  const PW = "s3cret-sentinel-pw";
  const basic = (password: string) => `Basic ${btoa(`opencode:${password}`)}`;

  function register(entry: Record<string, unknown>) {
    const stateDir = join(dir, "state", "opencode");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "service.json"), JSON.stringify(entry));
  }

  async function withFetch(
    handler: (url: string, init?: RequestInit) => Response,
    run: (calls: { url: string; init?: RequestInit }[]) => Promise<void>,
  ) {
    const originalFetch = globalThis.fetch;
    const calls: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      calls.push({ url, init });
      return handler(url, init);
    }) as typeof fetch;
    try {
      await run(calls);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  const service = (url: string) => {
    if (url === `${SERVICE}/api/info`) {
      return Response.json({ version: "2.0.16", urls: [SERVICE] });
    }
    if (url === `${SERVICE}/api/session/${SID}`) {
      return Response.json({ data: { id: SID, directory: "/tmp/project" } });
    }
    if (url === `${SERVICE}/api/session/${SID}/prompt`) {
      return Response.json({ data: { id: "msg_1" } });
    }
    return new Response("<!doctype html>", { status: 200 });
  };

  test("steers the prompt into the session through the service API", async () => {
    const { sendOpenCodePrompt } = await import("./opencode-send");
    register({ url: SERVICE, password: PW });
    await withFetch(service, async (calls) => {
      const result = await sendOpenCodePrompt({
        sessionId: SID,
        text: "hello",
      });

      expect(result.ok).toBe(true);
      expect(result.delivered).toBe(true);
      expect(result.delivery).toBe("service");
      expect(result.serverUrl).toBe(SERVICE);
      expect(calls.map((c) => c.url)).toEqual([
        `${SERVICE}/api/info`,
        `${SERVICE}/api/session/${SID}`,
        `${SERVICE}/api/session/${SID}/prompt`,
      ]);
      const prompt = calls.at(-1)!;
      expect(prompt.init?.method).toBe("POST");
      expect(JSON.parse(String(prompt.init?.body))).toEqual({
        text: "hello",
        delivery: "steer",
      });
      for (const call of calls) {
        expect(new Headers(call.init?.headers).get("authorization")).toBe(
          basic(PW),
        );
      }
      expect(JSON.stringify(result)).not.toContain(PW);
    });
  });

  test("an env url pairs only with an env password", async () => {
    const { sendOpenCodePrompt } = await import("./opencode-send");
    register({ url: "http://127.0.0.1:1", password: "registered" });
    process.env.OPENCODE_SERVER_URL = `${SERVICE}/`;
    process.env.OPENCODE_PASSWORD = "first";
    process.env.OPENCODE_SERVER_PASSWORD = "second";
    await withFetch(service, async (calls) => {
      const result = await sendOpenCodePrompt({ sessionId: SID, text: "x" });
      expect(result.delivered).toBe(true);
      expect(calls[0].url).toBe(`${SERVICE}/api/info`);
      expect(new Headers(calls[0].init?.headers).get("authorization")).toBe(
        basic("first"),
      );
    });
  });

  test("an env url alone never receives the registration password", async () => {
    const { sendOpenCodePrompt } = await import("./opencode-send");
    register({ url: SERVICE, password: PW });
    process.env.OPENCODE_SERVER_URL = "http://127.0.0.1:4777";
    await withFetch(
      () => new Response("not found", { status: 404 }),
      async (calls) => {
        await sendOpenCodePrompt({ sessionId: SID, text: "x" });
        for (const call of calls) {
          expect(new Headers(call.init?.headers).get("authorization")).not.toBe(
            basic(PW),
          );
        }
      },
    );
  });

  test("an env password alone does not replace the registration's", async () => {
    const { sendOpenCodePrompt } = await import("./opencode-send");
    register({ url: SERVICE, password: PW });
    process.env.OPENCODE_SERVER_PASSWORD = "left-over-1x";
    await withFetch(service, async (calls) => {
      const result = await sendOpenCodePrompt({ sessionId: SID, text: "x" });
      expect(result.delivered).toBe(true);
      expect(new Headers(calls[0].init?.headers).get("authorization")).toBe(
        basic(PW),
      );
    });
  });

  test("a rejected password is reported, not masked by the 1.x fallback", async () => {
    const { sendOpenCodePrompt } = await import("./opencode-send");
    register({ url: SERVICE, password: PW });
    await withFetch(
      (url) =>
        url === `${SERVICE}/api/info`
          ? new Response("{}", { status: 401 })
          : service(url),
      async (calls) => {
        const result = await sendOpenCodePrompt({ sessionId: SID, text: "x" });
        expect(result.ok).toBe(false);
        expect(result.errors[0]).toContain("rejected the password");
        expect(result.errors.join(" ")).not.toContain(PW);
        expect(calls.some((c) => c.url.includes("/global/health"))).toBe(false);
      },
    );
  });

  test("an unreachable service falls back to 1.x and says why", async () => {
    const { sendOpenCodePrompt } = await import("./opencode-send");
    register({ url: SERVICE, password: PW });
    await withFetch(
      (url) => {
        if (url === `${SERVICE}/api/info`) throw new Error("ECONNREFUSED");
        return new Response("not found", { status: 404 });
      },
      async () => {
        const result = await sendOpenCodePrompt({ sessionId: SID, text: "x" });
        expect(result.ok).toBe(false);
        expect(result.warnings.join(" ")).toContain(
          `Could not reach OpenCode service at ${SERVICE}`,
        );
      },
    );
  });

  test("a session route answering with HTML is not a found session", async () => {
    const { sendOpenCodePrompt } = await import("./opencode-send");
    register({ url: SERVICE, password: PW });
    await withFetch(
      (url) =>
        url === `${SERVICE}/api/session/${SID}`
          ? new Response("<!doctype html>", { status: 200 })
          : service(url),
      async (calls) => {
        const result = await sendOpenCodePrompt({ sessionId: SID, text: "x" });
        expect(result.sessionFound).toBe(false);
        expect(result.errors[0]).toContain("unexpected response");
        expect(calls.some((c) => c.url.endsWith("/prompt"))).toBe(false);
      },
    );
  });

  test("credentials in an env url never reach the report", async () => {
    const { sendOpenCodePrompt } = await import("./opencode-send");
    process.env.OPENCODE_SERVER_URL = `http://opencode:${PW}@127.0.0.1:49374`;
    process.env.OPENCODE_PASSWORD = PW;
    await withFetch(service, async () => {
      const result = await sendOpenCodePrompt({ sessionId: SID, text: "x" });
      expect(result.delivered).toBe(true);
      expect(result.serverUrl).toBe(SERVICE);
      expect(JSON.stringify(result)).not.toContain(PW);
    });
  });

  test("the send handler reports a service delivery without the password", async () => {
    register({ url: SERVICE, password: PW });
    await withFetch(service, async () => {
      const r = await handleSendOpenCodeMessage(
        req({ session: SID, text: "hello", token: TOKEN }),
      );
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body.delivery).toBe("service");
      expect(JSON.stringify(body)).not.toContain(PW);
    });
  });

  test("the status handler checks the 2.x session by default", async () => {
    register({ url: SERVICE, password: PW });
    await withFetch(service, async () => {
      const r = await handleOpenCodeControlStatus(
        new Request(
          `http://127.0.0.1/api/opencode-control/status?session=${SID}&token=${TOKEN}`,
        ),
      );
      const body = await r.json();
      expect(body.ready).toBe(true);
      expect(body.serverUrl).toBe(SERVICE);
      expect(JSON.stringify(body)).not.toContain(PW);
    });
  });

  test("a missing 2.x session is reported without trying the 1.x bridge", async () => {
    const { sendOpenCodePrompt } = await import("./opencode-send");
    register({ url: SERVICE, password: PW });
    await withFetch(
      (url) =>
        url === `${SERVICE}/api/session/${SID}`
          ? new Response("{}", { status: 404 })
          : service(url),
      async (calls) => {
        const result = await sendOpenCodePrompt({ sessionId: SID, text: "x" });
        expect(result.ok).toBe(false);
        expect(result.sessionFound).toBe(false);
        expect(result.errors).toEqual(["OpenCode session not found"]);
        expect(calls.some((c) => c.url.includes("/tui/"))).toBe(false);
      },
    );
  });

  test("a registration whose /api/info is not the 2.x API falls back to 1.x", async () => {
    const { sendOpenCodePrompt } = await import("./opencode-send");
    register({ url: SERVICE, password: PW });
    await withFetch(
      () => new Response("<!doctype html>", { status: 200 }),
      async () => {
        const result = await sendOpenCodePrompt({ sessionId: SID, text: "x" });
        expect(result.ok).toBe(false);
        expect(result.errors[0]).toContain("opencode 2.x");
        expect(result.errors[0]).toContain("--port");
      },
    );
  });
});

describe("handleOpenCodeControlStatus", () => {
  test("reports ready when the OpenCode session is reachable", async () => {
    const calls: any[] = [];
    const r = await handleOpenCodeControlStatus(
      new Request(
        `http://127.0.0.1/api/opencode-control/status?session=${SID}&token=${TOKEN}`,
      ),
      async (sessionId) => {
        calls.push(sessionId);
        return report({ delivered: false });
      },
    );

    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      ready: true,
      serverUrl: "http://127.0.0.1:9123",
      warnings: [],
      errors: [],
    });
    expect(calls).toEqual([SID]);
  });

  test("reports not ready when OpenCode server cannot find the session", async () => {
    const r = await handleOpenCodeControlStatus(
      new Request(
        `http://127.0.0.1/api/opencode-control/status?session=${SID}&token=${TOKEN}`,
      ),
      async () =>
        report({
          ok: false,
          ready: false,
          sessionFound: false,
          delivered: false,
          errors: ["OpenCode session not found"],
        }),
    );

    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      ready: false,
      serverUrl: "http://127.0.0.1:9123",
      warnings: [],
      errors: ["OpenCode session not found"],
    });
  });

  test("rejects unauthorized and invalid sessions", async () => {
    expect(
      (
        await handleOpenCodeControlStatus(
          new Request(
            `http://127.0.0.1/api/opencode-control/status?session=${SID}&token=bad`,
          ),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await handleOpenCodeControlStatus(
          new Request(
            `http://127.0.0.1/api/opencode-control/status?session=bad&token=${TOKEN}`,
          ),
        )
      ).status,
    ).toBe(400);
  });
});
