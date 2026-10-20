import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type Stub = Record<string, any>;
const g = globalThis as Stub;
const dist = `${import.meta.dir}/../dashboard/dist`;

const store: Stub = {
  selectedSessionId: null,
  selectedProject: null,
  selectedProvider: "claude",
  awaitingCall: false,
  heroCollapsed: [] as boolean[],
  subscribe() {},
  setHeroCollapsed(v: boolean) {
    store.heroCollapsed.push(v);
  },
};
mock.module(`${dist}/app.js`, () => ({ store }));
mock.module(`${dist}/modules/attention.js`, () => ({
  raiseAttention() {},
  clearAttention() {},
}));
mock.module(`${dist}/modules/latest-indicator.js`, () => ({
  createLatestIndicator: () => ({
    atBottom: () => true,
    notify() {},
    reset() {},
    setEnabled() {},
    scrollToBottom() {},
  }),
}));
mock.module(`${dist}/vendor/purify.es.mjs`, () => ({
  default: { addHook() {}, sanitize: (s: string) => s },
}));

const { initPermissionModal } = await import(
  `${dist}/modules/permission-modal.js`
);
const { initTranscript } = await import(`${dist}/modules/transcript.js`);
const { createHeroCollapse, formatAnswer, splitAnswer } = await import(
  `${dist}/modules/decision-log.js`
);

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

let eventSources: FakeEventSource[] = [];
let rafQueue: Array<() => void> = [];
let timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
let fetches: string[] = [];
let fetchImpl: (url: string, init?: Stub) => Promise<Stub>;

class FakeEventSource {
  listeners: Record<string, (e: Stub) => void> = {};
  onmessage: ((e: Stub) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    eventSources.push(this);
  }
  addEventListener(type: string, fn: (e: Stub) => void) {
    this.listeners[type] = fn;
  }
  close() {
    this.closed = true;
  }
  send(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

const fakeEl = (): Stub => {
  const el: Stub = {
    hidden: false,
    textContent: "",
    children: [] as Stub[],
    classes: new Set<string>(),
    listeners: {} as Record<string, () => void>,
    scrollTop: 0,
    scrollHeight: 0,
    classList: {
      add: (c: string) => el.classes.add(c),
      remove: (c: string) => el.classes.delete(c),
      toggle: (c: string, on: boolean) =>
        on ? el.classes.add(c) : el.classes.delete(c),
    },
    setAttribute() {},
    addEventListener(type: string, fn: () => void) {
      el.listeners[type] = fn;
    },
    appendChild: (c: Stub) => el.children.push(c),
    querySelectorAll: () => el.children,
  };
  let html = "";
  Object.defineProperty(el, "innerHTML", {
    get: () => html,
    set: (v: string) => {
      html = v;
      if (v === "") el.children = [];
    },
  });
  return el;
};

const fakeRoot = (): Stub => {
  const parts: Record<string, Stub> = {};
  const root = fakeEl();
  root.querySelector = (sel: string) => (parts[sel] ??= fakeEl());
  root.parts = parts;
  return root;
};

const GLOBALS = [
  "EventSource",
  "requestAnimationFrame",
  "setTimeout",
  "clearTimeout",
  "fetch",
  "document",
];
const saved = new Map(GLOBALS.map((k) => [k, g[k]]));
afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
});

beforeEach(() => {
  eventSources = [];
  rafQueue = [];
  timers = [];
  fetches = [];
  store.selectedSessionId = null;
  store.awaitingCall = false;
  store.heroCollapsed = [];
  fetchImpl = async (url) => {
    if (url === "/api/token")
      return { ok: true, json: async () => ({ token: "tok" }) };
    return { ok: true, json: async () => ({}) };
  };
  g.EventSource = FakeEventSource;
  g.requestAnimationFrame = (fn: () => void) => rafQueue.push(fn);
  g.setTimeout = (fn: () => void, ms: number) => {
    timers.push({ fn, ms, live: true });
    return timers.length;
  };
  g.clearTimeout = (id: number) => {
    if (timers[id - 1]) timers[id - 1]!.live = false;
  };
  g.fetch = (url: string, init?: Stub) => {
    fetches.push(url);
    return fetchImpl(url, init);
  };
  g.document = {
    hidden: false,
    addEventListener() {},
    createElement: () => fakeEl(),
  };
});

const fireTimers = () => {
  for (const t of timers.splice(0)) if (t.live) t.fn();
};
const flushRaf = () => {
  for (const fn of rafQueue.splice(0)) fn();
};

describe("permission-modal.js", () => {
  const setup = async (session: string | null = null) => {
    store.selectedSessionId = session;
    const root = fakeRoot();
    const modal = initPermissionModal(root);
    await flush();
    return { root, modal, es: eventSources.at(-1)! };
  };
  const request = (id: string) => ({
    type: "request",
    request_id: id,
    tool_name: "Bash",
  });
  const note = (root: Stub) => root.parts[".perm-modal__note"];

  test("a deep-linked initial selection opens exactly one stream, since subscribe only fires on later changes", async () => {
    const { es } = await setup("sess-1");
    expect(eventSources).toHaveLength(1);
    expect(es.url).toContain("session=sess-1");
    expect(es.url).toContain("token=tok");
  });

  test("a resolved frame for a request the own verdict already closed does not touch the next request", async () => {
    const { root, modal, es } = await setup("sess-1");
    es.send(request("A"));
    const actions = root.parts[".perm-modal__actions"];
    const allow = actions.children.find((b: Stub) => b.textContent === "Allow");
    allow.listeners.click();
    await flush();
    expect(modal.activeRequestId).toBeNull();

    es.send(request("B"));
    es.send({ type: "resolved", request_id: "A", source: "elsewhere" });
    expect(modal.activeRequestId).toBe("B");
    expect(modal.overlay.isOpen).toBe(true);
    expect(root.classes.has("is-dimmed")).toBe(false);
    expect(note(root).hidden).toBe(true);
  });

  test("a resolved frame from elsewhere dims the card and closes it after the linger; a ui one closes at once; a stranger's is ignored", async () => {
    const { root, modal, es } = await setup("sess-1");

    es.send(request("A"));
    es.send({ type: "resolved", request_id: "other", source: "ui" });
    expect(modal.overlay.isOpen).toBe(true);

    es.send({ type: "resolved", request_id: "A", source: "elsewhere" });
    expect(root.classes.has("is-dimmed")).toBe(true);
    expect(note(root).textContent).toBe("已在別處處理");
    expect(modal.overlay.isOpen).toBe(true);
    const linger = timers.filter((t) => t.live).at(-1)!;
    expect(linger.ms).toBe(1_800);
    linger.fn();
    expect(modal.overlay.isOpen).toBe(false);

    es.send(request("B"));
    es.send({ type: "resolved", request_id: "B", source: "ui" });
    expect(modal.overlay.isOpen).toBe(false);
  });
});

describe("transcript.js", () => {
  test("loadingOlder clears one frame after the anchor-restore scroll, so that scroll cannot start a second fetch", async () => {
    store.selectedSessionId = "sess-1";
    const root = fakeRoot();
    root.scrollTop = 0;
    root.scrollHeight = 1000;
    let release = () => {};
    fetchImpl = async (url) => {
      if (url.startsWith("/api/transcript/history")) {
        await new Promise<void>((r) => (release = r));
        return {
          ok: true,
          json: async () => ({
            entries: [{ uuid: `u${fetches.length}`, type: "user" }],
            historyStart: 50,
            hasMore: true,
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    };
    initTranscript(root);
    eventSources[0]!.listeners["backlog-done"]!({
      data: JSON.stringify({ historyStart: 100, hasMore: true }),
    });
    const history = () => fetches.filter((u) => u.includes("/history")).length;

    root.listeners.scroll!();
    expect(history()).toBe(1);
    root.listeners.scroll!();
    expect(history()).toBe(1);

    release();
    await flush();
    root.listeners.scroll!();
    expect(history()).toBe(1);

    flushRaf();
    root.listeners.scroll!();
    expect(history()).toBe(2);
  });
});

describe("decision-log.js", () => {
  test("a call arriving during the grace period keeps the hero raised", () => {
    const hero = createHeroCollapse(store, 60_000);
    hero.schedule();
    store.awaitingCall = true;
    fireTimers();
    expect(store.heroCollapsed).toEqual([]);

    hero.schedule();
    store.awaitingCall = false;
    fireTimers();
    expect(store.heroCollapsed).toEqual([true]);
  });

  test("raising the hero cancels a pending collapse", () => {
    const hero = createHeroCollapse(store, 60_000);
    hero.schedule();
    hero.raise();
    fireTimers();
    expect(store.heroCollapsed).toEqual([false]);
  });

  test("an answer composed from an option and a comment splits back into the same two parts", () => {
    const combined = formatAnswer("Use Postgres", "Keep it boring\nplease");
    expect(splitAnswer(combined)).toEqual({
      option: "Use Postgres",
      instructions: "Keep it boring\nplease",
    });
  });

  test("an option-only or comment-only answer is bare text, which splitAnswer leaves to the caller", () => {
    expect(formatAnswer("Use Postgres", "")).toBe("Use Postgres");
    expect(formatAnswer("", "just do it")).toBe("just do it");
    expect(splitAnswer("Use Postgres")).toBeNull();
  });
});
