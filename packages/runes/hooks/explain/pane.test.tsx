import type { On } from "claude-code";
import { expect, test, type Engine } from "claude-code/testing";

import type { ExplainEntry, ExplainView } from "../../types";
import { eventually, ran, startSession } from "../transcript/test-session";

const PANE = {
  plugin: "runes",
  surface: "terminal",
  component: "Pane",
  requestId: "runes-explain",
  props: { bodyColumns: 64 },
} as never;

const GLOW = "\n  \x1b[38;5;252;1mglowed\x1b[m\x1b[38;5;252m words\x1b[m\n\n";

type Node = {
  type?: string;
  props?: Record<string, unknown>;
  children?: unknown[];
};

const text = (id: string, title = id, body = "a body"): ExplainEntry => ({
  id,
  at: 1,
  title,
  kind: "text",
  body,
});

// the view atom answers from here, so a test seeds it and reads what a press wrote
const seed = (on: On, initial: ExplainView) => {
  const box = {
    view: initial,
    version: 1,
    forks: [] as string[],
    opens: [] as string[][],
  };
  on(
    "state.get",
    { plugin: "runes" } as never,
    (_$, e, next) =>
      ((e as { key: string }).key === "explain"
        ? { value: { value: box.view, version: box.version } }
        : next(e)) as never,
  );
  on("state.set", { plugin: "runes" } as never, (_$, e, next) => {
    if ((e as { key: string }).key !== "explain") return next(e) as never;
    box.view = (e as unknown as { value: ExplainView }).value;
    return { value: { isSet: true, version: ++box.version } } as never;
  });
  on("ui.open", () => ({ value: { isPlaced: true } }) as never);
  on("model.fork", (_$, e) => {
    box.forks.push((e as { prompt: string }).prompt);
    return { value: { isAnswered: false, reason: "nothing-to-fork" } } as never;
  });
  return box;
};

const session = ($: Engine, on: On, view: ExplainView, glow?: string) => {
  const box = seed(on, view);
  return startSession($, on, {
    run: (e) => {
      box.opens.push(e.argv);
      if (e.argv[0] === "glow") {
        if (glow === undefined) throw new Error("glow: not found");
        return ran(glow);
      }
      return ran("");
    },
  }).then(() => box);
};

const tree = async ($: Engine) => {
  const ui = await $.ui.mount(PANE);
  const root = (await ui.find({ type: "Box" })) as Node;
  await ui.unmount();
  return root;
};

const flat = (n: unknown): Node[] =>
  typeof n === "object" && n !== null
    ? [n as Node, ...((n as Node).children ?? []).flatMap(flat)]
    : [];
const texts = (root: Node) =>
  flat(root)
    .filter((n) => n.type === "Text")
    .map((n) =>
      (n.children ?? []).filter((c) => typeof c === "string").join(""),
    );
const buttons = (root: Node) => flat(root).filter((n) => n.type === "Button");

test("an empty view draws the hint and the follow-up Input", async ($, on) => {
  await session($, on, { entries: [], isRunning: false });
  const root = await tree($);
  expect(texts(root)).toContain(
    'Press [Explain plz!] under Clawd, or type below.',
  );
  const ui = await $.ui.mount(PANE);
  expect(await ui.find({ key: "explain-ask" })).toBeDefined();
  await ui.unmount();
});

test("twelve entries draw twelve history rows, newest first, only the selected one marked", async ($, on) => {
  const entries = Array.from({ length: 12 }, (_, i) =>
    text(`x${12 - i}`, `title ${12 - i}`),
  );
  await session($, on, { entries, isRunning: false, selected: "x5" });
  const rows = buttons(await tree($)).filter((b) =>
    String(b.props?.key).startsWith("explain-entry:"),
  );
  expect(rows.map((b) => b.props?.key)).toEqual(
    entries.map((e) => `explain-entry:${e.id}`),
  );
  expect(
    rows
      .filter((b) => String(b.props?.label).startsWith("● "))
      .map((b) => b.props?.label),
  ).toEqual(["● title 5"]);
  expect(rows[0]!.props?.label).toBe("○ title 12");
});

test("history and the selected entry each sit in a rounded border, the answer's in the accent colour", async ($, on) => {
  await session($, on, { entries: [text("x2"), text("x1")], isRunning: false });
  const root = await tree($);
  const box = (key: string) => flat(root).find((n) => n.props?.key === key);
  expect(box("explain-history")?.props).toMatchObject({ borderStyle: "round", borderDimColor: true });
  expect(box("explain-answer")?.props).toMatchObject({ borderStyle: "round", borderColor: "#d97757" });
});

// without it the previous answer stays in the box while a new one is written, and reads as the result
test("a running fork tops the history with a marked new row and fills the answer box with its placeholder", async ($, on) => {
  const old: ExplainEntry = { ...text("x1", "old title", "old body"), usage: { input: 1, cacheRead: 2, output: 3 } };
  await session($, on, { entries: [old], isRunning: true });
  const root = await tree($);
  const all = texts(root);
  expect(all.indexOf("● new explanation…")).toBeGreaterThanOrEqual(0);
  expect(all.indexOf("● new explanation…")).toBeLessThan(all.indexOf("○ old title"));
  expect(all).toContain("HISTORY · 2");
  expect(texts(root)).toContain("Writing the answer…");
  expect(texts(root).join("\n")).not.toContain("old body");
  expect(texts(root).join("\n")).not.toContain(" cached ");
});

test("a running fork with no history draws the placeholder, not the hint", async ($, on) => {
  await session($, on, { entries: [], isRunning: true });
  const all = texts(await tree($));
  expect(all).toContain("new explanation…");
  expect(all).not.toContain("Press [Explain plz!] under Clawd, or type below.");
});

test("the follow-up Input sits in a dim rounded border under its label, with or without history", async ($, on) => {
  const seeded = await session($, on, { entries: [], isRunning: false });
  for (const entries of [[], [text("x1")]]) {
    seeded.view = { entries, isRunning: false };
    const root = await tree($);
    const box = flat(root).find((n) => n.props?.key === "explain-ask-box");
    expect(box?.props).toMatchObject({ borderStyle: "round", borderDimColor: true });
    const inside = flat(box);
    expect(texts(box!)[0]).toBe("ASK · type below");
    expect(inside.some((n) => n.props?.key === "explain-ask")).toBe(true);
  }
});

test("the banner turns a spinner while explaining or checking, and none on an error", async ($, on) => {
  const page: ExplainEntry = { id: "p", at: 1, title: "p", kind: "html", summary: "", path: "/p.html", check: "pending" };
  const seeded = await session($, on, { entries: [], isRunning: true });
  const spinner = async () => {
    const node = flat(await tree($)).find((n) => n.props?.key === "explain-spinner");
    return node?.props?.module;
  };
  expect(await spinner()).toBe("hooks/transcript/spinner.tsx");
  expect(texts(await tree($))).toContain("explaining…");
  seeded.view = { entries: [page], isRunning: false };
  expect(await spinner()).toBe("hooks/transcript/spinner.tsx");
  expect(texts(await tree($))).toContain("checking layout…");
  seeded.view = { entries: [page], isRunning: false, error: "boom" };
  expect(await spinner()).toBeUndefined();
  expect(texts(await tree($))).toContain("✗ boom");
});

test("ask mode draws only the new-question box and a [history] button", async ($, on) => {
  await session($, on, { entries: [text("x1", "old title", "old body")], isRunning: false, isAsking: true });
  const root = await tree($);
  const all = texts(root).join("\n");
  expect(all).toContain("NEW QUESTION · type below");
  expect(all).not.toContain("old title");
  expect(all).not.toContain("HISTORY");
  expect(buttons(root).map((b) => b.props?.key)).toContain("explain-show-history");
  expect(flat(root).some((n) => n.props?.key === "explain-ask")).toBe(true);
});

test("pressing a history row selects that entry", async ($, on) => {
  const box = await session($, on, {
    entries: [text("x2"), text("x1")],
    isRunning: false,
  });
  const ui = await $.ui.mount(PANE);
  await ui.press({ key: "explain-entry:x1" });
  await ui.unmount();
  expect(box.view.selected).toBe("x1");
});

test("a text entry draws glow's runs once glow has rendered", async ($, on) => {
  await session(
    $,
    on,
    { entries: [text("x1", "t", "**glowed** words")], isRunning: false },
    GLOW,
  );
  expect(
    await eventually(async () => texts(await tree($)).includes("glowed")),
  ).toBe(true);
});

test("a text entry draws its plain wrapped body when glow is missing", async ($, on) => {
  const body = "one two three\nfour";
  await session($, on, { entries: [text("x1", "t", body)], isRunning: false });
  // the first draw queues glow, which fails; every later draw takes the fallback
  await tree($);
  const shown = await eventually(async () =>
    texts(await tree($)).includes("four"),
  );
  expect(shown).toBe(true);
  expect(texts(await tree($))).toContain("one");
});

test("an ask entry draws its question and one Button per option, each picking its option", async ($, on) => {
  const box = await session($, on, {
    entries: [
      {
        id: "x1",
        at: 1,
        title: "Which?",
        kind: "ask",
        question: "What next?",
        options: ["the parser", "the fork"],
      },
    ],
    isRunning: false,
  });
  const root = await tree($);
  expect(texts(root)).toContain("What next?");
  const picks = buttons(root).filter((b) =>
    String(b.props?.key).startsWith("explain-pick:"),
  );
  expect(picks.map((b) => [b.props?.key, b.props?.label])).toEqual([
    ["explain-pick:x1:0", "the parser"],
    ["explain-pick:x1:1", "the fork"],
  ]);
  const ui = await $.ui.mount(PANE);
  await ui.press({ key: "explain-pick:x1:1" });
  await ui.unmount();
  expect(box.forks).toHaveLength(1);
  expect(box.forks[0]).toContain("the fork");
});

test("an html entry draws summary, dim path, each check's status line, and open again", async ($, on) => {
  const cases: [
    ExplainEntry & { kind: "html" } extends infer H ? Partial<H> : never,
    string,
  ][] = [
    [{ check: "pending" }, "checking layout…"],
    [{ check: "ok" }, "layout ok"],
    [{ check: "fixed", note: "2 fix(es)" }, "fixed 2"],
    [{ check: "failed", note: "boom" }, "boom"],
    [{ check: "skipped", note: "no Chrome" }, "no Chrome"],
    [{ check: "failed" }, "not checked"],
    [{ check: "skipped" }, "not checked"],
  ];
  const html = (patch: object): ExplainEntry =>
    ({
      id: "x1",
      at: 1,
      title: "Flow",
      kind: "html",
      summary: "It flows.",
      path: "/p/flow.html",
      check: "ok",
      ...patch,
    }) as ExplainEntry;
  const box = await session($, on, { entries: [html({})], isRunning: false });
  for (const [patch, line] of cases) {
    box.view = { entries: [html(patch)], isRunning: false };
    const root = await tree($);
    expect(texts(root)).toContain(line);
    expect(texts(root).join("")).toContain("It flows.");
    const path = flat(root).find(
      (n) => n.type === "Text" && (n.children ?? []).includes("/p/flow.html"),
    );
    expect(path?.props?.dimColor).toBe(true);
  }
  const ui = await $.ui.mount(PANE);
  expect((await ui.find({ key: "explain-open:x1" }))?.props).toMatchObject({
    label: "open again",
  });
  await ui.press({ key: "explain-open:x1" });
  await ui.unmount();
  expect(box.opens).toContainEqual(["open", "/p/flow.html"]);
});

test("a long check note wraps inside the answer box and stops at two lines", async ($, on) => {
  const note = "The server-side auto mode classifier gave no verdict for Agent: the request that produced this action did not ask for one. Issue the action again once, as-is.";
  await session($, on, {
    entries: [
      { id: "x1", at: 1, title: "Flow", kind: "html", summary: "It flows.", path: "/p/flow.html", check: "failed", note } as ExplainEntry,
    ],
    isRunning: false,
  });
  const noteLines = texts(await tree($)).filter((t) => t.trim() && note.includes(t.replace(/…$/, "")) && t !== "It flows.");
  expect(noteLines.length).toBeGreaterThan(0);
  expect(noteLines.length).toBeLessThanOrEqual(2);
  for (const line of noteLines) expect(line.length).toBeLessThanOrEqual(64 - 4);
  expect(noteLines.at(-1)!.endsWith("…")).toBe(true);
});

test("the usage line formats each count in kilo", async ($, on) => {
  await session($, on, {
    entries: [
      {
        ...text("x1"),
        usage: { input: 12345, cacheRead: 812, output: 1000 },
      } as ExplainEntry,
    ],
    isRunning: false,
  });
  expect(texts(await tree($))).toContain("12.3k in · 812 cached · 1.0k out");
});

test("an error draws in #cc6666, and no error draws no error line", async ($, on) => {
  const box = await session($, on, {
    entries: [text("x1")],
    isRunning: false,
    error: "the fork failed: api-error 500",
  });
  const red = () =>
    tree($).then((r) => flat(r).filter((n) => n.props?.color === "#cc6666"));
  const shown = await red();
  expect(shown).toHaveLength(1);
  expect(texts({ children: [shown[0]] }).join("")).toContain(
    "the fork failed: api-error 500",
  );
  box.view = { entries: [text("x1")], isRunning: false };
  expect(await red()).toHaveLength(0);
});

test("the status banner tops the pane: running, then an error, then a pending check; none when idle", async ($, on) => {
  const page = { id: "h1", at: 1, title: "P", kind: "html", summary: "s", path: "/p/p.html", check: "pending" } as ExplainEntry;
  const box = await session($, on, { entries: [text("x1")], isRunning: true, error: "boom" });
  const first = async () => ((await tree($)).children as Node[])[0]!;
  const banner = async () => {
    const top = await first();
    return top.props?.key === "explain-status" ? texts({ children: [top] }).join("") : undefined;
  };
  expect(await banner()).toContain("explaining…");
  box.view = { entries: [text("x1")], isRunning: false, error: "boom" };
  expect(await banner()).toContain("✗ boom");
  box.view = { entries: [page], isRunning: false };
  expect(await banner()).toContain("checking layout…");
  box.view = { entries: [text("x1")], isRunning: false };
  expect(await banner()).toBeUndefined();
  expect(((await tree($)).children as Node[]).at(-1)?.props?.key).toBe("explain-ask-box");
});

test("an html entry has a delete button and the history a clear button, each moving pages to the Trash", async ($, on) => {
  const page = (id: string) => ({ id, at: 1, title: id, kind: "html", summary: "s", path: `/p/${id}.html`, check: "ok" }) as ExplainEntry;
  const box = await session($, on, { entries: [page("h2"), page("h1")], isRunning: false });
  const ui = await $.ui.mount(PANE);
  await ui.press({ key: "explain-delete:h2" });
  await ui.unmount();
  expect(box.opens).toContainEqual(["trash", "/p/h2.html"]);
  expect(box.view.entries.map((e) => e.id)).toEqual(["h1"]);
  const again = await $.ui.mount(PANE);
  await again.press({ key: "explain-clear" });
  await again.unmount();
  expect(box.opens).toContainEqual(["trash", "/p/h1.html"]);
  expect(box.view.entries).toEqual([]);
});

test("submitting asks a follow-up; a blank submit asks nothing", async ($, on) => {
  const box = await session($, on, {
    entries: [text("x1", "Forks", "a fork copies")],
    isRunning: false,
  });
  const ui = await $.ui.mount(PANE);
  await ui.input({ key: "explain-ask", text: "   " });
  expect(box.forks).toHaveLength(0);
  await ui.input({ key: "explain-ask", text: "why?" });
  await ui.unmount();
  expect(box.forks).toHaveLength(1);
  expect(box.forks[0]).toContain("why?");
});

// a fork that writes a page spawns the checker, which the engine lets runes allow only from inside a runes hook
test("a pick and a follow-up fork from runes' own hooks once the press and submit bottoms returned", async ($, on) => {
  const forks: string[] = [];
  const forksPastBottom: number[] = [];
  on("ui.press", async (_$, e, next) => {
    const pressed = await next(e);
    forksPastBottom.push(forks.length);
    return pressed;
  });
  on("ui.input", async (_$, e, next) => {
    const submitted = await next(e);
    forksPastBottom.push(forks.length);
    return submitted;
  });
  const box = await session($, on, {
    entries: [
      { id: "x1", at: 1, title: "Which?", kind: "ask", question: "What next?", options: ["the parser", "the fork"] },
    ],
    isRunning: false,
  });
  box.forks = forks;
  const ui = await $.ui.mount(PANE);
  await ui.press({ key: "explain-pick:x1:1" });
  await ui.input({ key: "explain-ask", text: "why?" });
  await ui.unmount();
  expect(box.forks).toEqual([expect.stringContaining("the fork"), expect.stringContaining("why?")]);
  expect(forksPastBottom).toEqual([0, 1]);
});
