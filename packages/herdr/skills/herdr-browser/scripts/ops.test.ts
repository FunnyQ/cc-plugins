import { afterAll, describe, expect, test } from "bun:test";

import {
  attach,
  type CdpSession,
  cookieSetParams,
  evaluate,
  formatCookies,
  formatEvalResult,
  keyDescriptor,
  MODIFIERS,
  selectorClick,
} from "./ops";

describe("formatEvalResult", () => {
  test("prints a string bare, so the agent reads a value not a quote", () => {
    expect(formatEvalResult({ type: "string", value: "hello" })).toBe("hello");
  });

  test("prints numbers and booleans bare", () => {
    expect(formatEvalResult({ type: "number", value: 42 })).toBe("42");
    expect(formatEvalResult({ type: "boolean", value: false })).toBe("false");
  });

  test("prints undefined and null as themselves", () => {
    expect(formatEvalResult({ type: "undefined" })).toBe("undefined");
    expect(
      formatEvalResult({ type: "object", subtype: "null", value: null }),
    ).toBe("null");
  });

  test("compacts an object to one line; pretty JSON is the token leak", () => {
    expect(
      formatEvalResult({ type: "object", value: { a: 1, b: [2, 3] } }),
    ).toBe('{"a":1,"b":[2,3]}');
  });

  test("falls back to the description when there is no value", () => {
    expect(
      formatEvalResult({ type: "function", description: "function f() {}" }),
    ).toBe("function f() {}");
  });

  test("empty string stays empty rather than becoming a quote pair", () => {
    expect(formatEvalResult({ type: "string", value: "" })).toBe("");
  });
});

describe("keyDescriptor", () => {
  test("names Enter with the code the page expects", () => {
    expect(keyDescriptor("Enter")).toMatchObject({
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      text: "\r",
    });
  });

  test("carries no text for a key that inserts nothing", () => {
    expect(keyDescriptor("Tab").text).toBeUndefined();
    expect(keyDescriptor("Escape").text).toBeUndefined();
  });

  test("maps the arrows", () => {
    expect(keyDescriptor("ArrowDown")).toMatchObject({
      code: "ArrowDown",
      windowsVirtualKeyCode: 40,
    });
  });

  test("treats a single character as itself, and types it", () => {
    expect(keyDescriptor("a")).toMatchObject({
      key: "a",
      code: "KeyA",
      text: "a",
    });
  });

  test("splits a chord into modifiers plus the final key", () => {
    expect(keyDescriptor("Control+a")).toMatchObject({
      key: "a",
      modifiers: MODIFIERS.Control,
    });
  });

  test("sums several modifiers", () => {
    expect(keyDescriptor("Control+Shift+Enter").modifiers).toBe(
      MODIFIERS.Control + MODIFIERS.Shift,
    );
  });

  test("a modified key inserts no text, or the chord would type a letter", () => {
    expect(keyDescriptor("Control+a").text).toBeUndefined();
  });

  test("rejects an unknown key name rather than sending a no-op", () => {
    expect(() => keyDescriptor("Wingding")).toThrow(/Wingding/);
  });
});

describe("cookieSetParams", () => {
  test("takes the bare name and value", () => {
    expect(cookieSetParams(["session", "abc123"])).toEqual({
      name: "session",
      value: "abc123",
    });
  });

  test("carries the attributes CDP needs and JS cannot set", () => {
    expect(
      cookieSetParams([
        "session",
        "abc",
        "--url",
        "https://x/",
        "--http-only",
        "--secure",
        "--same-site",
        "Lax",
        "--path",
        "/api",
        "--expires",
        "1750000000",
      ]),
    ).toEqual({
      name: "session",
      value: "abc",
      url: "https://x/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/api",
      expires: 1750000000,
    });
  });

  test("refuses a value it would otherwise drop on the floor", () => {
    expect(() => cookieSetParams(["session"])).toThrow(/value/);
    expect(() => cookieSetParams([])).toThrow(/name/);
    expect(() => cookieSetParams(["a", "b", "--url"])).toThrow(/--url/);
    expect(() => cookieSetParams(["a", "b", "--httpOnly"])).toThrow(
      /--httpOnly/,
    );
    expect(() => cookieSetParams(["a", "b", "--same-site", "Nope"])).toThrow(
      /Strict, Lax, None/,
    );
    expect(() => cookieSetParams(["a", "b", "--expires", "soon"])).toThrow(
      /--expires/,
    );
  });
});

describe("formatCookies", () => {
  test("one line each, flags only when set", () => {
    expect(
      formatCookies([
        {
          name: "a",
          value: "1",
          domain: "x.com",
          path: "/",
          httpOnly: true,
          secure: false,
        },
        {
          name: "b",
          value: "2",
          domain: "x.com",
          path: "/api",
          httpOnly: false,
          secure: true,
        },
      ]),
    ).toBe("a=1 x.com/ httpOnly\nb=2 x.com/api secure");
  });

  test("says so rather than printing nothing", () => {
    expect(formatCookies([])).toBe("no cookies");
  });
});

describe("ops.ts boundary", () => {
  test("never reads argv or imports browser.ts, which own the human-facing half", async () => {
    const source = await Bun.file(new URL("./ops.ts", import.meta.url)).text();
    expect(source).not.toContain("process.argv");
    expect(source).not.toMatch(/from ["']\.\/browser["']/);
  });
});

function recordingSession(
  answer: (params: any) => any,
): CdpSession & { calls: { params: any; timeoutMs?: number }[] } {
  const calls: { params: any; timeoutMs?: number }[] = [];
  return {
    calls,
    send: async (_method, params, timeoutMs) => {
      calls.push({ params, timeoutMs });
      return answer(params);
    },
    onEvent: () => {},
    close: () => {},
  };
}

describe("evaluate", () => {
  test("waives the deadline only when awaiting the caller's promise, which may legitimately sleep", async () => {
    const session = recordingSession(() => ({ result: {} }));
    await evaluate(session, "1", true);
    await evaluate(session, "1", false);
    expect(session.calls.map((call) => call.timeoutMs)).toEqual([0, undefined]);
  });

  test("surfaces only the first line of a thrown stack, which belongs to the injected wrapper", async () => {
    const session = recordingSession(() => ({
      exceptionDetails: {
        exception: { description: "Error: boom\n    at <anonymous>:1:7" },
      },
    }));
    await expect(evaluate(session, "x")).rejects.toThrow(/^Error: boom$/);
  });
});

describe("selector ops", () => {
  test("a selector matching nothing throws, so a typo never reads as success", async () => {
    const session = recordingSession(({ expression }) => {
      const document = { querySelector: () => null };
      try {
        return {
          result: {
            value: new Function("document", `return ${expression}`)(document),
          },
        };
      } catch (error) {
        return {
          exceptionDetails: { exception: { description: String(error) } },
        };
      }
    });
    await expect(selectorClick(session, "#nope")).rejects.toThrow(
      /no element matches #nope/,
    );
  });
});

describe("attach transport", () => {
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      return server.upgrade(request)
        ? undefined
        : new Response("expected a websocket", { status: 400 });
    },
    websocket: {
      message(socket, raw) {
        const { id } = JSON.parse(String(raw));
        socket.send(
          JSON.stringify({
            id,
            result: { errorText: "net::ERR", success: false },
          }),
        );
      },
    },
  });
  afterAll(() => server.stop(true));

  test("resolves an op-level failure sentinel unchanged, leaving its check to the op", async () => {
    const session = await attach(`ws://127.0.0.1:${server.port}`);
    expect(await session.send("Page.navigate")).toEqual({
      errorText: "net::ERR",
      success: false,
    });
    session.close();
  });
});
