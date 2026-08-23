// The CDP driver: the transport, every page operation, and the data those
// operations produce. Nothing here formats for a human or reads argv — that is
// browser.ts's half, and the split is the rule, not a habit. The herdr plugin
// CLI answers each of these with pretty-printed JSON, which is the same fact
// spread over ten lines; going to CDP directly is what lets one line be the
// answer.

export type CdpSession = {
  // A rejected send means the call did not happen. timeoutMs 0 waives the
  // transport deadline for a call the caller's own expression bounds.
  send: (method: string, params?: unknown, timeoutMs?: number) => Promise<any>;
  onEvent: (handler: (message: any) => void) => void;
  close: () => void;
};

// The default deadline catches a wedged renderer — one that took the command
// and will never answer, the way a page parked on a modal dialog does.
export const CDP_TIMEOUT_MS = 30_000;

// Some calls are slow because the page is big, not because the renderer is
// sick: a full-page screenshot, a whole AX tree, a multi-megabyte response
// body. CDP promises them no bound, so they get a looser one rather than the
// default — still bounded, because a wedged renderer looks the same from here.
export const CDP_BULK_TIMEOUT_MS = 120_000;

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

const NAMED_KEYS: Record<
  string,
  { code: string; keyCode: number; text?: string }
> = {
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
      ...(named.text !== undefined && modifiers === 0
        ? { text: named.text }
        : {}),
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
  const response = await session.send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise },
    // Awaiting the caller's promise is unbounded by definition — `eval` on an
    // expression that sleeps a minute is a legitimate use, not a wedged page.
    awaitPromise ? 0 : undefined,
  );
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
  await session.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    ...descriptor,
  });
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
): Promise<void> {
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x,
    y,
    // The protocol requires the field; horizontal scrolling is not offered.
    deltaX: 0,
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
    await Bun.sleep(100);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${expression}`);
}

export async function pageText(session: CdpSession): Promise<string> {
  return formatEvalResult(
    await evaluate(session, "document.body?.innerText ?? ''"),
  );
}

// Navigation answers with where it landed, because a redirect makes the url the
// caller passed the wrong thing to report. Both facts ride one round trip.
export async function landed(session: CdpSession): Promise<string> {
  const [url = "", title = ""] =
    (await evaluate(session, "[location.href, document.title]"))?.value ?? [];
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
    // Sleep first: right after Page.navigate the old document can still be
    // there reporting "complete", and checking immediately would believe it.
    await Bun.sleep(100);
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
  full = false,
): Promise<string> {
  const shot = await session.send(
    "Page.captureScreenshot",
    { format: "png", captureBeyondViewport: full },
    CDP_BULK_TIMEOUT_MS,
  );
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
        throw new Error(
          `invalid --same-site ${next} (${SAME_SITE.join(", ")})`,
        );
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
  if (
    headers === null ||
    typeof headers !== "object" ||
    Array.isArray(headers)
  ) {
    throw new Error("headers needs a JSON object of name to value");
  }
  await session.send("Network.enable", {});
  await session.send("Network.setExtraHTTPHeaders", { headers });
  const names = Object.keys(headers);
  return names.length === 0 ? "cleared" : names.join(" ");
}

// --- watch ------------------------------------------------------------------
// CDP only reports while a client is attached, so recording means driving the
// navigation ourselves. A request that never gets a response still matters — a
// blocked or refused fetch is usually the bug — and an uncaught exception never
// reaches the console buffer at all.

export type WatchEvent =
  | {
      kind: "net";
      requestId: string;
      type: string;
      url: string;
      status: number | null;
      failure: string | null;
    }
  | { kind: "console"; level: string; text: string }
  | { kind: "exception"; text: string };

export function renderCallArguments(args: any[] = []): string {
  return args
    .map((arg) =>
      arg?.value !== undefined
        ? String(arg.value)
        : (arg?.description ?? arg?.type ?? ""),
    )
    .join(" ");
}

// Whichever field of exceptionDetails carries the description this time.
export function exceptionText(details: any): string {
  return (
    details?.exception?.description ?? details?.text ?? "uncaught exception"
  );
}

// One CDP message yields at most one event; null means we do not report it.
function watchEvent(message: {
  method?: string;
  params?: any;
}): WatchEvent | null {
  if (message.method === "Network.responseReceived") {
    const { requestId, type, response } = message.params;
    return {
      kind: "net",
      requestId,
      type,
      url: response.url,
      status: response.status,
      failure: null,
    };
  }
  if (message.method === "Network.loadingFailed") {
    const { requestId, type, errorText, blockedReason } = message.params;
    return {
      kind: "net",
      requestId,
      type: type ?? "Other",
      url: "",
      status: null,
      failure: blockedReason ? `${errorText} (${blockedReason})` : errorText,
    };
  }
  if (message.method === "Network.requestWillBeSent") {
    // Only used to give a failed exchange its url once the failure arrives.
    const { requestId, request } = message.params;
    return {
      kind: "net",
      requestId,
      type: "pending",
      url: request.url,
      status: null,
      failure: null,
    };
  }
  if (message.method === "Runtime.consoleAPICalled") {
    return {
      kind: "console",
      level: message.params.type,
      text: renderCallArguments(message.params.args),
    };
  }
  if (message.method === "Runtime.exceptionThrown") {
    return {
      kind: "exception",
      text: exceptionText(message.params.exceptionDetails),
    };
  }
  return null;
}

export function applyWatchMessage(
  events: WatchEvent[],
  message: { method?: string; params?: any },
): WatchEvent[] {
  const event = watchEvent(message);
  return event ? [...events, event] : events;
}

// requestWillBeSent rows exist to name the failures; drop the ones that landed.
export function settleEvents(events: WatchEvent[]): WatchEvent[] {
  const urls = new Map<string, string>();
  for (const event of events) {
    if (event.kind === "net" && event.url) {
      urls.set(event.requestId, event.url);
    }
  }
  const settled = new Set(
    events
      .filter((event) => event.kind === "net" && event.type !== "pending")
      .map(
        (event) => (event as Extract<WatchEvent, { kind: "net" }>).requestId,
      ),
  );
  return events
    .filter(
      (event) =>
        event.kind !== "net" ||
        event.type !== "pending" ||
        !settled.has(event.requestId),
    )
    .map((event) =>
      event.kind === "net"
        ? {
            ...event,
            url: event.url || urls.get(event.requestId) || "",
            type: event.type === "pending" ? "Other" : event.type,
          }
        : event,
    );
}

export async function watchPage(
  session: CdpSession,
  url: string | null,
  bodyNeedle: string | null,
  idleMs = 1_500,
  capMs = 15_000,
): Promise<{ events: WatchEvent[]; body: string | null }> {
  let events: WatchEvent[] = [];
  let lastEventAt = Date.now();

  session.onEvent((message) => {
    const before = events.length;
    events = applyWatchMessage(events, message);
    if (events.length !== before) {
      lastEventAt = Date.now();
    }
  });

  // Three independent domains — enabling them concurrently saves two round trips.
  await Promise.all([
    session.send("Network.enable"),
    session.send("Runtime.enable"),
    session.send("Page.enable"),
  ]);
  // Runtime.enable replays the console messages the page already collected;
  // those belong to the load we are about to replace.
  await session.send("Runtime.discardConsoleEntries");
  events = [];
  lastEventAt = Date.now();
  await session.send(url ? "Page.navigate" : "Page.reload", url ? { url } : {});

  const startedAt = Date.now();
  while (Date.now() - lastEventAt < idleMs && Date.now() - startedAt < capMs) {
    await Bun.sleep(100);
  }

  const settled = settleEvents(events);
  let body: string | null = null;
  if (bodyNeedle) {
    const match = settled.find(
      (event) => event.kind === "net" && event.url.includes(bodyNeedle),
    ) as Extract<WatchEvent, { kind: "net" }> | undefined;
    if (!match) {
      throw new Error(`no request url contains ${bodyNeedle}`);
    }
    body =
      (
        await session.send(
          "Network.getResponseBody",
          { requestId: match.requestId },
          CDP_BULK_TIMEOUT_MS,
        )
      )?.body ?? null;
  }
  return { events: settled, body };
}

// --- console ----------------------------------------------------------------

export type ConsoleEntry = {
  level: string;
  text: string;
  timestamp: number;
};

// Runtime.enable replays the whole buffer, so entries from pages visited earlier
// sit in front of this page's. performance.timeOrigin is the cut.
export function sincePageLoad(
  entries: ConsoleEntry[],
  timeOrigin: number | null,
): ConsoleEntry[] {
  if (timeOrigin === null) {
    return entries;
  }
  return entries.filter((entry) => entry.timestamp >= timeOrigin);
}

// about:blank and error pages can refuse to evaluate; then every entry stands.
export async function pageTimeOrigin(
  session: CdpSession,
): Promise<number | null> {
  try {
    const value = (await evaluate(session, "performance.timeOrigin"))?.value;
    return typeof value === "number" ? value : null;
  } catch {
    return null;
  }
}

// Runtime.enable replays the console the page collected before we attached, so
// a short-lived CLI reads the same buffer a resident daemon would have kept.
export async function collectConsole(
  session: CdpSession,
): Promise<ConsoleEntry[]> {
  const entries: ConsoleEntry[] = [];
  session.onEvent((message) => {
    if (message.method === "Runtime.consoleAPICalled") {
      entries.push({
        level: message.params.type,
        text: renderCallArguments(message.params.args),
        timestamp: message.params.timestamp,
      });
    }
    if (message.method === "Runtime.exceptionThrown") {
      entries.push({
        level: "exception",
        text: exceptionText(message.params.exceptionDetails).split("\n")[0],
        timestamp: message.params.timestamp,
      });
    }
  });
  await session.send("Runtime.enable");
  // The replay arrives as events after the reply, so it needs a moment to land.
  await Bun.sleep(400);
  return entries;
}

// --- accessibility and emulation --------------------------------------------

// The flat array is Chromium's own serialization order, not the document's.
// Putting it back in document order is the caller's job.
export async function axTree(session: CdpSession): Promise<any[]> {
  await session.send("Accessibility.enable");
  const tree = await session.send(
    "Accessibility.getFullAXTree",
    {},
    CDP_BULK_TIMEOUT_MS,
  );
  return tree?.nodes ?? [];
}

// backendDOMNodeId survives a detach but not a navigation or a re-render, so
// snapshot and click-ref belong next to each other in time.
export async function clickRef(
  session: CdpSession,
  ref: string,
): Promise<string> {
  const resolved = await session.send("DOM.resolveNode", {
    backendNodeId: Number.parseInt(ref, 10),
  });
  const objectId = resolved?.object?.objectId;
  if (!objectId) {
    throw new Error(`ref ${ref} is no longer on the page; snapshot again`);
  }
  const clicked = await session.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration:
      "function(){this.scrollIntoView({block:'center'});this.click();return this.textContent?.trim().slice(0,80)??''}",
    returnByValue: true,
  });
  return clicked?.result?.value ?? "";
}

export type DeviceMetrics = {
  width: number;
  height: number;
  scale: number;
  mobile: boolean;
};

// Device metrics are the one override that outlives the session that set it —
// emulated media and network conditions die on detach, so this does not offer
// them. There is no clear either: the way back is another size. Which size the
// flags meant is the CLI's question, so the answer arrives already resolved.
export async function emulate(
  session: CdpSession,
  metrics: DeviceMetrics,
): Promise<string> {
  await session.send("Emulation.setDeviceMetricsOverride", {
    width: metrics.width,
    height: metrics.height,
    deviceScaleFactor: metrics.scale,
    mobile: metrics.mobile,
  });
  return `${metrics.width}x${metrics.height}`;
}

// --- transport ---------------------------------------------------------------

type PendingCall = {
  resolve: (result: any) => void;
  reject: (error: Error) => void;
  method: string;
  timer?: ReturnType<typeof setTimeout>;
};

// The transport decides only whether the call happened. Whether it did what the
// caller meant stays with the ops, which is why their own sentinel checks —
// exceptionDetails, errorText, success:false — remain on top of this.
export async function attach(pageWsUrl: string): Promise<CdpSession> {
  const socket = new WebSocket(pageWsUrl);
  const pending = new Map<number, PendingCall>();
  let handler: ((message: any) => void) | null = null;
  let messageId = 0;

  const settle = (id: number): PendingCall | undefined => {
    const call = pending.get(id);
    if (call) {
      clearTimeout(call.timer);
      pending.delete(id);
    }
    return call;
  };

  // A socket that dies mid-command leaves every call in flight unsettled, and
  // an unsettled call is a CLI that never exits — the hang run()'s timeout
  // exists to prevent on the subprocess path. The reason is remembered because
  // draining what is pending right now is not enough: a send issued after the
  // close would join an empty map that nothing will ever drain again, and a
  // send that waived its deadline would then wait forever.
  let closedReason: string | null = null;
  const drain = (reason: string): void => {
    closedReason = reason;
    for (const id of [...pending.keys()]) {
      settle(id)?.reject(new Error(reason));
    }
  };

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const call = message.id === undefined ? undefined : settle(message.id);
    if (!call) {
      handler?.(message);
      return;
    }
    // Handing message.error back as the result is a silent wrong answer: every
    // op then reads it as data and blames its own sentinel for the failure.
    if (message.error) {
      call.reject(
        new Error(
          `${call.method} failed: ${
            message.error.message ?? JSON.stringify(message.error)
          }`,
        ),
      );
      return;
    }
    call.resolve(message.result);
  });
  socket.addEventListener("close", () =>
    drain("the browser closed the CDP connection"),
  );

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () =>
      reject(new Error(`cannot attach to ${pageWsUrl}`)),
    );
  });

  return {
    // timeoutMs 0 disables the deadline, for a call whose duration is the
    // caller's own expression to decide.
    send: (method, params = {}, timeoutMs = CDP_TIMEOUT_MS) =>
      new Promise((resolve, reject) => {
        if (closedReason) {
          reject(new Error(`${method} failed: ${closedReason}`));
          return;
        }
        messageId += 1;
        const id = messageId;
        const timer = timeoutMs
          ? setTimeout(() => {
              settle(id);
              reject(new Error(`${method} got no answer in ${timeoutMs}ms`));
            }, timeoutMs)
          : undefined;
        pending.set(id, { resolve, reject, method, timer });
        try {
          socket.send(JSON.stringify({ id, method, params }));
        } catch (error) {
          // A synchronous send failure would otherwise leave the entry and its
          // timer behind with nothing left to answer them.
          settle(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }),
    onEvent: (next) => {
      handler = next;
    },
    close: () => socket.close(),
  };
}
