// Every page operation, driven straight over CDP. The herdr plugin CLI answers
// each of these with pretty-printed JSON, which is the same fact spread over
// ten lines; going to CDP directly is what lets one line be the answer, and it
// is what makes both backends print identically.

export type CdpSession = {
  send: (method: string, params?: unknown) => Promise<any>;
  onEvent: (handler: (message: any) => void) => void;
  close: () => void;
};

export function formatEvalResult(remote: any): string {
  if (remote?.subtype === "null") {
    return "null";
  }
  if (remote?.type === "undefined") {
    return "undefined";
  }
  if (remote && "value" in remote) {
    return typeof remote.value === "object"
      ? JSON.stringify(remote.value)
      : String(remote.value);
  }
  return remote?.description ?? "";
}

export const MODIFIERS: Record<string, number> = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
};

const NAMED_KEYS: Record<string, { code: string; keyCode: number; text?: string }> =
  {
    Enter: { code: "Enter", keyCode: 13, text: "\r" },
    Tab: { code: "Tab", keyCode: 9 },
    Escape: { code: "Escape", keyCode: 27 },
    Backspace: { code: "Backspace", keyCode: 8 },
    Delete: { code: "Delete", keyCode: 46 },
    ArrowUp: { code: "ArrowUp", keyCode: 38 },
    ArrowDown: { code: "ArrowDown", keyCode: 40 },
    ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
    ArrowRight: { code: "ArrowRight", keyCode: 39 },
    Home: { code: "Home", keyCode: 36 },
    End: { code: "End", keyCode: 35 },
    PageUp: { code: "PageUp", keyCode: 33 },
    PageDown: { code: "PageDown", keyCode: 34 },
    " ": { code: "Space", keyCode: 32, text: " " },
    Space: { code: "Space", keyCode: 32, text: " " },
  };

export type KeyDescriptor = {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  modifiers: number;
  text?: string;
};

// A chord that still carries `text` types its letter as well as firing the
// shortcut, so Control+a would select all and then replace it with "a".
export function keyDescriptor(spec: string): KeyDescriptor {
  const parts = spec.split("+");
  const name = parts.pop() ?? "";
  let modifiers = 0;
  for (const part of parts) {
    const bit = MODIFIERS[part];
    if (bit === undefined) {
      throw new Error(
        `unknown modifier: ${part} (${Object.keys(MODIFIERS).join(", ")})`,
      );
    }
    modifiers += bit;
  }

  const named = NAMED_KEYS[name];
  if (named) {
    return {
      key: name,
      code: named.code,
      windowsVirtualKeyCode: named.keyCode,
      modifiers,
      ...(named.text !== undefined && modifiers === 0 ? { text: named.text } : {}),
    };
  }
  if (name.length === 1) {
    const upper = name.toUpperCase();
    return {
      key: name,
      code: /[a-z]/i.test(name) ? `Key${upper}` : `Digit${name}`,
      windowsVirtualKeyCode: upper.charCodeAt(0),
      modifiers,
      ...(modifiers === 0 ? { text: name } : {}),
    };
  }
  throw new Error(
    `unknown key: ${name} (a single character, or ${Object.keys(NAMED_KEYS)
      .filter((named) => named.trim())
      .join(", ")})`,
  );
}

// Runtime.evaluate reports a thrown expression in the result, not as a protocol
// error, so a silent wrong answer is the default unless this is checked.
export async function evaluate(
  session: CdpSession,
  expression: string,
  awaitPromise = false,
): Promise<any> {
  const response = await session.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise,
  });
  if (response?.exceptionDetails) {
    const details = response.exceptionDetails;
    // The stack belongs to the injected wrapper, never to the caller, so it
    // only costs tokens; the first line already names what went wrong.
    throw new Error(
      (
        details.exception?.description ??
        details.text ??
        "evaluation threw"
      ).split("\n")[0],
    );
  }
  return response?.result;
}

// One round trip: find the node, act on it, and answer with what it now says.
// A selector that matches nothing has to throw, or a typo reads as success.
async function onSelector(
  session: CdpSession,
  selector: string,
  body: string,
): Promise<string> {
  const result = await evaluate(
    session,
    `(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) throw new Error("no element matches ${selector.replace(/"/g, '\\"')}");
      ${body}
    })()`,
  );
  return formatEvalResult(result);
}

export async function selectorClick(
  session: CdpSession,
  selector: string,
): Promise<string> {
  return await onSelector(
    session,
    selector,
    `node.scrollIntoView({block:'center'});
     node.click();
     return (node.textContent ?? "").trim().slice(0, 80);`,
  );
}

export async function selectorType(
  session: CdpSession,
  selector: string,
  text: string,
): Promise<string> {
  return await onSelector(
    session,
    selector,
    `node.focus();
     node.value = (node.value ?? "") + ${JSON.stringify(text)};
     node.dispatchEvent(new Event("input", {bubbles:true}));
     node.dispatchEvent(new Event("change", {bubbles:true}));
     return node.value;`,
  );
}

export async function selectorPress(
  session: CdpSession,
  selector: string | null,
  key: string,
): Promise<string> {
  if (selector) {
    await onSelector(session, selector, "node.focus(); return true;");
  }
  const descriptor = keyDescriptor(key);
  await session.send("Input.dispatchKeyEvent", {
    type: descriptor.text ? "keyDown" : "rawKeyDown",
    ...descriptor,
  });
  await session.send("Input.dispatchKeyEvent", { type: "keyUp", ...descriptor });
  return key;
}

export async function clickPoint(
  session: CdpSession,
  x: number,
  y: number,
): Promise<void> {
  const common = { x, y, button: "left", clickCount: 1 };
  await session.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...common,
  });
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...common,
  });
}

export async function wheel(
  session: CdpSession,
  x: number,
  y: number,
  deltaY: number,
  deltaX = 0,
): Promise<void> {
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x,
    y,
    deltaX,
    deltaY,
  });
}

// Polling beats a CDP waiter here: the expression is the caller's, and a page
// that never satisfies it has to fail loudly with the time it burned.
export async function waitFor(
  session: CdpSession,
  expression: string,
  timeoutMs: number,
): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const result = await evaluate(session, expression);
      if (result?.value) {
        return `ok ${Date.now() - startedAt}ms`;
      }
    } catch {
      // A page mid-navigation throws on any expression; keep waiting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${expression}`);
}

export async function pageText(session: CdpSession): Promise<string> {
  return formatEvalResult(
    await evaluate(session, "document.body?.innerText ?? ''"),
  );
}

// Navigation answers with where it landed, because a redirect makes the url the
// caller passed the wrong thing to report.
export async function landed(session: CdpSession): Promise<string> {
  const url = formatEvalResult(await evaluate(session, "location.href"));
  const title = formatEvalResult(await evaluate(session, "document.title"));
  return `${url} ${title}`.trimEnd();
}

// Page.navigate reports a refused or unresolvable url in errorText and still
// resolves, so without this check a dead host prints as a successful load.
export async function navigate(
  session: CdpSession,
  url: string,
): Promise<string> {
  const response = await session.send("Page.navigate", { url });
  if (response?.errorText) {
    throw new Error(`${url} failed to load: ${response.errorText}`);
  }
  await settled(session);
  return await landed(session);
}

export async function history(
  session: CdpSession,
  direction: "back" | "forward",
): Promise<string> {
  await evaluate(session, `history.${direction}()`);
  await settled(session);
  return await landed(session);
}

export async function reload(session: CdpSession): Promise<string> {
  await session.send("Page.reload", {});
  await settled(session);
  return await landed(session);
}

// Page.loadEventFired is the honest signal, but a same-document navigation
// never fires it, so the readyState poll is the floor under the wait.
async function settled(session: CdpSession, timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      const state = await evaluate(session, "document.readyState");
      if (state?.value === "complete") {
        return;
      }
    } catch {
      // Mid-navigation the context is gone; that is the wait working.
    }
  }
}

export async function screenshot(
  session: CdpSession,
  path: string,
): Promise<string> {
  const shot = await session.send("Page.captureScreenshot", { format: "png" });
  if (!shot?.data) {
    throw new Error("the page returned no screenshot data");
  }
  const bytes = Buffer.from(shot.data, "base64");
  await Bun.write(path, bytes);
  return `${path} ${bytes.length}`;
}

export type CookieParams = {
  name: string;
  value: string;
  url?: string;
  domain?: string;
  path?: string;
  httpOnly?: true;
  secure?: true;
  sameSite?: string;
  expires?: number;
};

const SAME_SITE = ["Strict", "Lax", "None"];

// Network.setCookie is the only way in for the attributes document.cookie
// cannot express: httpOnly is unreadable and unwritable from JS, and a cookie
// for a domain the page is not on cannot be written from that page at all.
export function cookieSetParams(args: string[]): CookieParams {
  const name = args[0];
  if (name === undefined || name.startsWith("--")) {
    throw new Error("missing cookie name");
  }
  const value = args[1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`missing value for cookie ${name}`);
  }
  const params: CookieParams = { name, value };
  for (let index = 2; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--http-only") {
      params.httpOnly = true;
      continue;
    }
    if (flag === "--secure") {
      params.secure = true;
      continue;
    }
    const next = args[index + 1];
    if (next === undefined) {
      throw new Error(`missing ${flag} value`);
    }
    index += 1;
    if (flag === "--url") {
      params.url = next;
    } else if (flag === "--domain") {
      params.domain = next;
    } else if (flag === "--path") {
      params.path = next;
    } else if (flag === "--same-site") {
      if (!SAME_SITE.includes(next)) {
        throw new Error(`invalid --same-site ${next} (${SAME_SITE.join(", ")})`);
      }
      params.sameSite = next;
    } else if (flag === "--expires") {
      const seconds = Number(next);
      if (!Number.isFinite(seconds)) {
        throw new Error(`invalid --expires ${next} (unix seconds)`);
      }
      params.expires = seconds;
    } else {
      throw new Error(`unknown cookies flag ${flag}`);
    }
  }
  return params;
}

export function formatCookies(cookies: any[]): string {
  if (cookies.length === 0) {
    return "no cookies";
  }
  return cookies
    .map((cookie) => {
      const flags = [
        cookie.httpOnly ? "httpOnly" : null,
        cookie.secure ? "secure" : null,
        cookie.sameSite ? String(cookie.sameSite) : null,
      ].filter(Boolean);
      const where = `${cookie.domain ?? ""}${cookie.path ?? ""}`;
      return [`${cookie.name}=${cookie.value}`, where, ...flags]
        .filter(Boolean)
        .join(" ");
    })
    .join("\n");
}

export async function cookiesGet(session: CdpSession): Promise<string> {
  const { cookies } = await session.send("Network.getCookies", {});
  return formatCookies(cookies ?? []);
}

export async function cookiesSet(
  session: CdpSession,
  params: CookieParams,
): Promise<string> {
  const result = await session.send("Network.setCookie", params);
  // Chrome answers a rejected cookie with success:false, not an error — a
  // silent no-op is exactly what a wrong domain or a missing secure looks like.
  if (result?.success === false) {
    throw new Error(`the browser rejected cookie ${params.name}`);
  }
  return `${params.name}=${params.value}`;
}

export async function cookiesClear(session: CdpSession): Promise<string> {
  await session.send("Network.clearBrowserCookies", {});
  return "cleared";
}

export async function setHeaders(
  session: CdpSession,
  json: string,
): Promise<string> {
  let headers: Record<string, string>;
  try {
    headers = JSON.parse(json);
  } catch {
    throw new Error(`headers needs JSON, got: ${json.slice(0, 60)}`);
  }
  if (headers === null || typeof headers !== "object" || Array.isArray(headers)) {
    throw new Error("headers needs a JSON object of name to value");
  }
  await session.send("Network.enable", {});
  await session.send("Network.setExtraHTTPHeaders", { headers });
  const names = Object.keys(headers);
  return names.length === 0 ? "cleared" : names.join(" ");
}
