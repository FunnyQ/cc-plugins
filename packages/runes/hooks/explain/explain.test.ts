import type { EngineInterface, On } from "claude-code";
import { expect, mock, test } from "claude-code/testing";

import type { ExplainEntry, ExplainView } from "../../types";
import { CONFIG, HOME, startSession } from "../transcript/test-session";
import { where } from "../transcript/where";
import { CHECK_TIMEOUT_MS, CHECKER, CHROME } from "./checker";
import {
  explainAsk,
  explainClear,
  explainDelete,
  explainHooks,
  explainOpen,
  explainPick,
  explainPress,
  explainReopen,
  explainSelect,
  explainShowHistory,
  PANE,
} from "./explain";
import { buildPrompt } from "./protocol";
import { usageOf } from "./state";

const USAGE = {
  input_tokens: 10,
  output_tokens: 20,
  cache_read_input_tokens: 30,
  cache_creation_input_tokens: 5,
};
const TOAST =
  "Explain plz! needs a wider terminal; the answer is in the pane once it fits";
const ROOT = "/plugin";
const TEMPLATE_PATH = `${ROOT}/hooks/explain/template.html`;
const textReply =
  "<mode>text</mode><title>Forks</title><body>a fork copies</body>";
const askReply =
  "<mode>ask</mode><title>Which?</title><question>What next?</question><option>the parser</option><option>the fork</option>";
const htmlReply =
  '<mode>html</mode><title>Fork flow</title><summary>It flows.</summary><main><p class="answer">yes</p></main>';

type Fork = {
  isAnswered: boolean;
  text?: string;
  usage?: typeof USAGE;
  reason?: string;
  status?: number;
};
type Hooks = Record<
  string,
  (($: unknown, e: unknown, next: unknown) => Promise<unknown>)[]
>;

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

let epoch = 0;

// the handlers need a hook's `$`, which the kit's `$` cannot stand in for, and the kit loads the plugin as its own
// module instance, so they are driven on this file's instance: a fake `$`, and `explainHooks` on a fake `on`
const rig = async (
  opts: {
    placed?: boolean;
    deny?: string;
    git?: string;
    writeFails?: boolean;
    entries?: ExplainEntry[];
    language?: string;
    trashFails?: boolean;
  } = {},
) => {
  let now = (epoch += 10 * CHECK_TIMEOUT_MS);
  where.home = HOME;
  let explain: ExplainView = { entries: opts.entries ?? [], isRunning: false };
  let version = 1;
  const files = new Map<string, string>([
    [TEMPLATE_PATH, '<html lang="{{lang}}">{{main}}</html>'],
    [CHROME, ""],
  ]);
  const forks: string[] = [];
  const replies: (Fork | Promise<Fork> | Error)[] = [];
  const opens: unknown[] = [];
  const toasts: string[] = [];
  const runs: string[][] = [];
  const spawns: { prompt: string }[] = [];
  const agents: { id: string; type: string }[] = [];
  const $ = {
    plugin: { name: "runes", root: ROOT },
    session: { id: async () => "94e739d6-4f3e-4ab7-8896-2a0aebe5aac2" },
    ui: {
      open: async (e: unknown) => {
        opens.push(e);
        return { isPlaced: opts.placed !== false };
      },
      toast: (text: string) => {
        toasts.push(text);
      },
    },
    model: {
      fork: async (e: { prompt: string }) => {
        forks.push(e.prompt);
        const r = replies.shift()!;
        if (r instanceof Error) throw r;
        return r;
      },
    },
    clock: { now: async () => now },
    settings: {
      read: async () => (opts.language === undefined ? {} : { language: opts.language }),
    },
    fs: {
      read: async (p: string) => files.get(p),
      write: async (p: string, text: string) => {
        if (opts.writeFails) throw new Error("disk full");
        files.set(p, text);
      },
      exists: async (p: string) => files.has(p),
    },
    process: {
      run: async (argv: string[]) => {
        runs.push(argv);
        const git = argv[0] === "git";
        if (argv[0] === "trash" && opts.trashFails)
          return { exitCode: 1, stdout: "", stderr: "trash: no such file" };
        return {
          exitCode: git && opts.git === undefined ? 128 : 0,
          stdout: git ? `${opts.git ?? ""}\n` : "",
          stderr: "",
        };
      },
    },
    agent: {
      spawn: async (e: { prompt: string }) => {
        if (opts.deny) return { deny: opts.deny };
        spawns.push(e);
        const id = `k${spawns.length}`;
        agents.push({ id, type: CHECKER });
        return { agentId: id, model: "sonnet" };
      },
      list: async () => agents,
    },
    state: {
      get: async () => ({ value: explain, version }),
      set: async (_ref: unknown, value: ExplainView, o?: { ifVersion?: number }) => {
        if (o?.ifVersion !== undefined && o.ifVersion !== version) return { isSet: false, version };
        explain = value;
        version++;
        return { isSet: true, version };
      },
    },
  } as unknown as EngineInterface;
  const hooks: Hooks = {};
  const fakeOn = ((event: string, ...rest: unknown[]) => {
    (hooks[event] ??= []).push(rest.at(-1) as Hooks[string][number]);
    return { catch: () => undefined };
  }) as unknown as On;
  explainHooks(fakeOn);
  const turnEnd = (e: Record<string, unknown>) =>
    hooks["turn.complete"]![0]!(
      $,
      {
        answer: "",
        durationMs: 0,
        isAborted: false,
        turnId: "t",
        reason: "answer",
        ...e,
      },
      async () => ({ text: "" }),
    );
  where.cwd = "/work/my repo";
  return {
    $,
    replies,
    forks,
    opens,
    toasts,
    runs,
    spawns,
    files,
    turnEnd,
    view: () => explain,
    token: (i: number) =>
      spawns[i]!.prompt.split("token is ")[1]!.replace(".", ""),
    setNow: (n: number) => (now = n),
  };
};

const answered = (text: string): Fork => ({
  isAnswered: true,
  text,
  usage: USAGE,
});
const opened = (runs: string[][]) => runs.filter((a) => a[0] === "open");

test("press with a text reply opens the pane, forks once, and stores a selected text entry", async () => {
  const r = await rig();
  r.replies.push(answered(textReply));
  await explainPress(r.$);
  expect(r.opens).toEqual([
    { id: "runes-explain", title: "Explain plz!", columns: 64 },
  ]);
  expect(PANE).toBe("runes-explain");
  expect(r.forks).toEqual([buildPrompt({ kind: "press" })]);
  const v = r.view();
  expect(v.entries).toHaveLength(1);
  expect(v.entries[0]).toEqual(
    expect.objectContaining({
      kind: "text",
      body: "a fork copies",
      title: "Forks",
      usage: usageOf(USAGE),
    }),
  );
  expect(v.selected).toBe(v.entries[0]!.id);
  expect(v.isRunning).toBe(false);
});

test("press with an ask reply stores its question and options", async () => {
  const r = await rig();
  r.replies.push(answered(askReply));
  await explainPress(r.$);
  expect(r.view().entries[0]).toEqual(
    expect.objectContaining({
      kind: "ask",
      question: "What next?",
      options: ["the parser", "the fork"],
    }),
  );
});

test("press with an html reply writes the file, stores pending, and the checker's FIXED 2 settles and opens it", async () => {
  const r = await rig({ git: "/src/cc plugins" });
  r.replies.push(answered(htmlReply));
  await explainPress(r.$);
  const entry = r.view().entries[0] as Extract<ExplainEntry, { kind: "html" }>;
  expect(entry).toEqual(
    expect.objectContaining({
      kind: "html",
      summary: "It flows.",
      check: "pending",
    }),
  );
  expect(
    entry.path.startsWith(
      `${HOME}/.local/share/q-lab/runes/explain/cc-plugins/`,
    ),
  ).toBe(true);
  expect(
    /\/cc-plugins\/\d{8}-94e739d6\/\d{4}-[^/]+\.html$/.test(entry.path),
  ).toBe(true);
  expect(r.files.has(entry.path)).toBe(true);
  expect(r.spawns).toHaveLength(1);
  expect(opened(r.runs)).toEqual([]);
  expect(r.view().isRunning).toBe(false);
  await r.turnEnd({ agentId: "k1", answer: `${r.token(0)} FIXED 2` });
  expect(r.view().entries[0]).toEqual(
    expect.objectContaining({ check: "fixed", note: "2 fix(es)" }),
  );
  expect(opened(r.runs)).toEqual([["open", entry.path]]);
});

test("the project falls back to the cwd's basename when git fails", async () => {
  const r = await rig();
  r.replies.push(answered(htmlReply));
  await explainPress(r.$);
  const entry = r.view().entries[0] as Extract<ExplainEntry, { kind: "html" }>;
  expect(
    entry.path.startsWith(`${HOME}/.local/share/q-lab/runes/explain/my-repo/`),
  ).toBe(true);
});

test("a denied checker spawn still opens the page and fails the check", async () => {
  const r = await rig({ deny: "no" });
  r.replies.push(answered(htmlReply));
  await explainPress(r.$);
  const entry = r.view().entries[0] as Extract<ExplainEntry, { kind: "html" }>;
  expect(entry.check).toBe("failed");
  expect(opened(r.runs)).toContainEqual(["open", entry.path]);
});

test("a write that throws keeps the summary as a text entry and sets the error", async () => {
  const r = await rig({ writeFails: true });
  r.replies.push(answered(htmlReply));
  await explainPress(r.$);
  expect(r.view().entries[0]).toEqual(
    expect.objectContaining({ kind: "text", body: "It flows." }),
  );
  expect(r.view().error).toBe("could not write the explainer: disk full");
  expect(r.spawns).toHaveLength(0);
  expect(r.view().isRunning).toBe(false);
});

test("a press forks in the language settings name, and an html page carries it as its lang", async () => {
  const r = await rig({ language: "ja" });
  r.replies.push(answered(textReply));
  await explainPress(r.$);
  expect(r.forks).toEqual([buildPrompt({ kind: "press" }, "ja")]);
  r.replies.push(answered(htmlReply));
  await explainPress(r.$);
  const page = [...r.files.entries()].find(([p]) => p.endsWith(".html") && p !== TEMPLATE_PATH);
  expect(page?.[1]).toContain('lang="ja"');
});

test("an unplaced pane raises the toast and the fork still runs", async () => {
  const r = await rig({ placed: false });
  r.replies.push(answered(textReply));
  await explainPress(r.$);
  expect(r.toasts).toEqual([TOAST]);
  expect(r.forks).toHaveLength(1);
});

test("an unanswered fork sets the error, stores nothing, and clears isRunning", async () => {
  const r = await rig();
  r.replies.push({ isAnswered: false, reason: "nothing-to-fork" });
  await explainPress(r.$);
  expect(r.view()).toEqual({
    entries: [],
    isRunning: false,
    error: "nothing to explain yet",
  });
  r.replies.push({ isAnswered: false, reason: "api-error", status: 529 });
  await explainPress(r.$);
  expect(r.view().error).toBe("the fork failed: api-error 529");
  r.replies.push(answered(textReply));
  await explainPress(r.$);
  expect(r.view().error).toBeUndefined();
});

test("a fork that throws clears isRunning and sets the error", async () => {
  const r = await rig();
  r.replies.push(new Error("boom"));
  await explainPress(r.$);
  expect(r.view().isRunning).toBe(false);
  expect(r.view().error).toBe("the fork failed: boom");
});

test("a second press while the fork is pending forks nothing", async () => {
  const r = await rig();
  const d = deferred<Fork>();
  r.replies.push(d.promise);
  const first = explainPress(r.$);
  await explainPress(r.$);
  expect(r.forks).toHaveLength(1);
  d.resolve(answered(textReply));
  await first;
  expect(r.view().isRunning).toBe(false);
});

test("a finishing check does not clear a newer press's isRunning", async () => {
  const r = await rig();
  r.replies.push(answered(htmlReply));
  await explainPress(r.$);
  const b = deferred<Fork>();
  r.replies.push(b.promise);
  const pressB = explainPress(r.$);
  await new Promise((res) => setTimeout(res, 0));
  await r.turnEnd({ agentId: "k1", answer: `${r.token(0)} OK` });
  expect(r.view().entries.find((e) => e.kind === "html")).toEqual(
    expect.objectContaining({ check: "ok" }),
  );
  expect(r.view().isRunning).toBe(true);
  await explainPress(r.$);
  expect(r.forks).toHaveLength(2);
  b.resolve(answered(textReply));
  await pressB;
  expect(r.view().isRunning).toBe(false);
});

// ask mode hides the history, so a submit there must not ride an answer the user cannot see
test("[Tell me…] opens ask mode; a submit there asks fresh past the selected entry and leaves ask mode", async () => {
  const r = await rig();
  await explainOpen(r.$);
  expect(r.view().isAsking).toBe(true);
  expect(r.forks).toEqual([]);
  r.replies.push(answered(textReply));
  await explainAsk(r.$, "why?");
  expect(r.forks).toEqual([buildPrompt({ kind: "free", question: "why?" })]);
  expect(r.view().isAsking).toBeFalsy();
});

test("[history] and an Explain plz! press each leave ask mode", async () => {
  const r = await rig();
  await explainOpen(r.$);
  await explainShowHistory(r.$);
  expect(r.view().isAsking).toBeFalsy();
  expect(r.forks).toEqual([]);
  await explainOpen(r.$);
  r.replies.push(answered(textReply));
  await explainPress(r.$);
  expect(r.view().isAsking).toBeFalsy();
});

test("ask follows the selected entry, asks free with none, and ignores blank text", async () => {
  const none = await rig();
  none.replies.push(answered(textReply));
  await explainAsk(none.$, "   ");
  expect(none.forks).toEqual([]);
  await explainAsk(none.$, " why? ");
  expect(none.forks).toEqual([buildPrompt({ kind: "free", question: "why?" })]);
  none.replies.push(answered(textReply));
  await explainAsk(none.$, "why?");
  expect(none.forks[1]).toBe(
    buildPrompt({
      kind: "follow",
      previous: { title: "Forks", text: "a fork copies" },
      question: "why?",
    }),
  );
  const asked = await rig({
    entries: [
      {
        id: "q",
        at: 1,
        title: "Which?",
        kind: "ask",
        question: "What next?",
        options: ["a", "b"],
      },
    ],
  });
  asked.replies.push(answered(textReply));
  await explainAsk(asked.$, "why?");
  expect(asked.forks[0]).toBe(
    buildPrompt({
      kind: "follow",
      previous: { title: "Which?", text: "What next?\na\nb" },
      question: "why?",
    }),
  );
});

test("pick forks on the topic", async () => {
  const r = await rig();
  r.replies.push(answered(textReply));
  await explainPick(r.$, "the parser");
  expect(r.forks).toEqual([buildPrompt({ kind: "pick", topic: "the parser" })]);
});

test("two entries in one millisecond get x<at> and x<at>-2", async () => {
  const r = await rig();
  r.setNow(42);
  r.replies.push(answered(textReply), answered(textReply));
  await explainPress(r.$);
  await explainPress(r.$);
  expect(r.view().entries.map((e) => e.id)).toEqual(["x42-2", "x42"]);
});

test("select sets selected; reopen opens an html entry and nothing else", async () => {
  const r = await rig({
    entries: [
      {
        id: "h",
        at: 1,
        title: "h",
        kind: "html",
        summary: "",
        path: "/p/h.html",
        check: "ok",
      },
      { id: "t", at: 1, title: "t", kind: "text", body: "" },
    ],
  });
  await explainSelect(r.$, "t");
  expect(r.view().selected).toBe("t");
  await explainReopen(r.$, "t");
  expect(r.runs).toEqual([]);
  await explainReopen(r.$, "h");
  expect(r.runs).toEqual([["open", "/p/h.html"]]);
});

const pages: ExplainEntry[] = [
  { id: "h2", at: 3, title: "h2", kind: "html", summary: "", path: "/p/h2.html", check: "ok" },
  { id: "t", at: 2, title: "t", kind: "text", body: "" },
  { id: "h1", at: 1, title: "h1", kind: "html", summary: "", path: "/p/h1.html", check: "ok" },
];

test("explainDelete moves an html entry's page to the Trash and drops the entry; a text entry just drops", async () => {
  const r = await rig({ entries: pages });
  await explainSelect(r.$, "h2");
  await explainDelete(r.$, "h2");
  expect(r.runs).toEqual([["trash", "/p/h2.html"]]);
  expect(r.view().entries.map((e) => e.id)).toEqual(["t", "h1"]);
  expect(r.view().selected).toBeUndefined();
  await explainDelete(r.$, "t");
  expect(r.runs).toHaveLength(1);
  expect(r.view().entries.map((e) => e.id)).toEqual(["h1"]);
});

test("a failed trash keeps the entry and names the page in the error", async () => {
  const r = await rig({ entries: pages, trashFails: true });
  await explainDelete(r.$, "h1");
  expect(r.view().entries).toHaveLength(3);
  expect(r.view().error).toBe("could not move h1.html to the Trash: trash: no such file");
});

test("explainClear trashes every html page in one call and empties the history", async () => {
  const r = await rig({ entries: pages });
  await explainClear(r.$);
  expect(r.runs).toEqual([["trash", "/p/h2.html", "/p/h1.html"]]);
  expect(r.view().entries).toEqual([]);
  expect(r.view().selected).toBeUndefined();
  const failing = await rig({ entries: pages, trashFails: true });
  await explainClear(failing.$);
  expect(failing.view().entries).toHaveLength(3);
  expect(failing.view().error).toBe("could not move 2 pages to the Trash: trash: no such file");
});

test("explainHooks hooks the checker, the three presses and the follow-up submit", async () => {
  const hooks: Record<string, number> = {};
  explainHooks(((event: string) => {
    hooks[event] = (hooks[event] ?? 0) + 1;
    return { catch: () => undefined };
  }) as unknown as On);
  expect(hooks).toEqual({
    "agent.offer": 1,
    "tool.check": 4,
    "tool.call": 1,
    "turn.complete": 2,
    "ui.press": 3,
    "ui.input": 1,
  });
});

test("the whole plugin starts through register.tsx with explain on, and every turn end still passes", async ($, on) => {
  mock.clock(on);
  on("agent.list", () => ({ value: [] }) as never);
  on("turn.complete", () => ({ text: "" }) as never);
  const host = await startSession($, on, {
    files: new Map([[CONFIG, "explain:\n  enabled: true\n"]]),
  });
  expect(host.registered.map((a) => a.name)).toEqual(["explain-checker"]);
  for (const isAborted of [false, true])
    await $.turn.complete({
      answer: "",
      durationMs: 0,
      isAborted,
      turnId: "t",
      reason: "answer",
    } as never);
});
