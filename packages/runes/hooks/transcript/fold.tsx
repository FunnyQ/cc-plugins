import type { Hook, On, SessionMessage } from "claude-code";

import { config } from "../config";
import { paint, palette, pressRow } from "./bubble";
import { cells, innerWidth, plural, wrap } from "./text";
import { shortPath } from "./where";

export type Title = {
  tool: string;
  text: string;
  isRunning?: true;
  isHidden?: true;
  depth?: 1;
  isLastChild?: true;
  answers?: string[];
};
export type Pending = {
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  isDone?: true;
};
export type Member = {
  run: string;
  ids: string[];
  isLast: boolean;
  label: string;
  title: Title;
};
type $ = Parameters<Hook<"tool.call">>[0];
type Render = Parameters<Hook<"ui.render">>;

const nameOf = (tool: string) => tool.replace(/^mcp__.+?__/, "");

// code mode wraps every call in a REPL script and waits on it with Poll; the calls inside are the work
const PLUMBING = ["REPL", "Poll"];

type Question = { question?: unknown; header?: unknown };
const questionsOf = (input: Record<string, unknown>) =>
  (Array.isArray(input.questions) ? input.questions : []) as Question[];

const answersOf = (input: Record<string, unknown>, result: unknown) => {
  const given =
    (result as
      { answers?: Record<string, unknown>; response?: unknown } | undefined) ??
    {};
  const qs = questionsOf(input);
  const answers = qs.flatMap((q) => {
    const a = given.answers?.[String(q.question)];
    if (typeof a !== "string" || !a) return [];
    return [qs.length > 1 ? `${String(q.header)}: ${a}` : a];
  });
  return answers.length || typeof given.response !== "string"
    ? answers
    : [given.response];
};

const titleOf = (tool: string, input: Record<string, unknown>) => {
  if (tool === "Poll") return "Waiting for the script...";
  if (tool === "AskUserQuestion") {
    const qs = questionsOf(input);
    if (qs.length === 1) return String(qs[0]!.question);
    if (qs.length > 1) return qs.map((q) => String(q.header)).join(" · ");
  }
  const s = (k: string) =>
    typeof input[k] === "string" ? (input[k] as string) : undefined;
  const description = s("description");
  if (description) return description;
  const path = s("file_path") ?? s("path");
  const detail =
    (path && shortPath(path)) ??
    s("pattern") ??
    s("command")?.split("\n")[0] ??
    s("skill");
  return detail ? `${nameOf(tool)} ${detail}` : nameOf(tool);
};

export const runsOf = (
  messages: readonly SessionMessage[],
  {
    keep,
    min,
    pending = [],
  }: { keep: readonly string[]; min: number; pending?: readonly Pending[] },
): Map<string, Member> => {
  const members = new Map<string, Member>();
  let run: string[] = [];
  let tools: string[] = [];
  let titles: Title[] = [];
  let hasScript = false;
  const close = (least = min) => {
    if (run.length >= least) {
      titles.forEach((t, i) => {
        if (t.depth && !titles[i + 1]?.depth) t.isLastChild = true;
      });
      const work = tools.filter((t) => !PLUMBING.includes(t));
      const tally = work.length ? work : tools;
      const counts = new Map<string, number>();
      for (const t of tally) counts.set(t, (counts.get(t) ?? 0) + 1);
      const label = [
        plural(tally.length, "call"),
        ...[...counts].map(([t, n]) => `${t} ${n}`),
      ].join(" · ");
      const ids = run;
      ids.forEach((id, i) =>
        members.set(id, {
          run: ids[0]!,
          ids,
          isLast: i === ids.length - 1,
          label,
          title: titles[i]!,
        }),
      );
    }
    run = [];
    tools = [];
    titles = [];
    hasScript = false;
  };
  const seen = new Set<string>();
  const inFlight = new Set(
    pending.filter((u) => !u.isDone).map((u) => u.tool_use_id),
  );
  const add = (u: Pending & { result?: unknown }, isRunning: boolean) => {
    seen.add(u.tool_use_id);
    if (keep.includes(u.tool)) return;
    run.push(u.tool_use_id);
    tools.push(nameOf(u.tool));
    const answers =
      u.tool === "AskUserQuestion" ? answersOf(u.input, u.result) : [];
    titles.push({
      tool: u.tool,
      text: titleOf(u.tool, u.input),
      ...(isRunning ? { isRunning: true as const } : {}),
      ...(u.tool === "Poll" ? { isHidden: true as const } : {}),
      ...(hasScript && u.tool_use_id.startsWith("repl_")
        ? { depth: 1 as const }
        : {}),
      ...(answers.length ? { answers } : {}),
    });
    if (u.tool === "REPL") hasScript = true;
  };
  for (const m of messages) {
    // tool results ride on user messages with no text; anything the person typed ends the run
    if (m.text.trim()) close();
    for (const u of m.toolUses)
      if (!u.isError) add(u, inFlight.has(u.tool_use_id));
  }
  for (const u of pending) if (!seen.has(u.tool_use_id)) add(u, !u.isDone);
  close(1);
  return members;
};

// nf-oct-search U+F422 and nf-fa-wrench U+F0AD, need a Nerd Font
export const SEARCH_ICON = "\u{F422}";
const TOOL_ICON = "\u{F0AD}";

const iconOf = (tool: string) => {
  const rune = (
    {
      Bash: config.bash,
      Read: config.read,
      Edit: config.edit,
      Write: config.write,
      Agent: config.agent,
      Skill: config.skill,
    } as Record<string, { icon: string; color: string }>
  )[tool];
  if (rune) return rune;
  return {
    icon: tool === "Grep" || tool === "Glob" ? SEARCH_ICON : TOOL_ICON,
    color: palette().dim,
  };
};

let members = new Map<string, Member>();
let pending: Pending[] = [];
const open = new Set<string>();
const settled = new Set<number>();
const SETTLED = /kind="repl-eval"[^>]*?\beval="(\d+)"/g;
// a Poll's reply names each script that ended, the only sign a dispatched REPL is done
const noteSettled = (output: unknown) => {
  const text = (output as { content?: unknown } | undefined)?.content;
  if (typeof text !== "string") return false;
  const before = settled.size;
  for (const [, n] of text.matchAll(SETTLED)) settled.add(Number(n));
  return settled.size > before;
};
const scriptRuns = (output: unknown, m: Member) => {
  const o = output as
    { evalId?: unknown; asyncDispatched?: unknown } | undefined;
  return (
    o?.asyncDispatched === true &&
    typeof o.evalId === "number" &&
    !settled.has(o.evalId) &&
    m.run === [...members.values()].at(-1)?.run
  );
};
const RAIL_MAX_CARD_LINES = 200;
const isOn = () => config.enabled.transcript && config.enabled.fold;

// reads the whole transcript per call, a cursor over new messages if long sessions make it slow
async function refresh($: $) {
  if (!isOn()) return;
  const keep = config.fold.keep
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  members = runsOf(await $.session.messages(), {
    keep,
    min: config.fold.min_calls,
    pending,
  });
  $.ui.invalidate("ui.render");
}

function titleLines(
  $: Render[0],
  e: Render[1],
  id: string,
  m: Member,
  call: { isRunning?: boolean; output?: unknown },
  suffix = "",
) {
  const { Box, Button, Client, Text } = $.ui.resolve(e);
  const { tool, text: title, isHidden, answers = [] } = m.title;
  // code mode's Poll and REPL never reach tool.call, so only the engine knows they still run
  const isRunning =
    m.title.isRunning ||
    call.isRunning ||
    (tool === "REPL" && scriptRuns(call.output, m));
  if (isHidden && !isRunning) return [];
  const width = innerWidth(e.viewport?.columns);
  const scope = `fold:${id}`;
  const { icon, color } = iconOf(tool);
  const guide = m.title.depth ? (m.title.isLastChild ? "└ " : "│ ") : "";
  const lead = `  ${guide}${icon}  `;
  const room = width - cells(lead);
  const line = wrap(title, room - 2)[0] ?? "";
  const shown = `${line}${cells(line) < cells(title) ? "…" : ""}`;
  const indent = " ".repeat(cells(lead) + 2);
  return [
    // the blank line between rows belongs to the engine's own row, so the run's first line sets its own
    <Box key={`fold:title${suffix}`} marginTop={m.ids[0] === id ? 1 : 0}>
      {isRunning ? (
        <Client
          key={`fold:spinner${suffix}`}
          module="./spinner.tsx"
          props={{ color: palette().text }}
          width={2}
        />
      ) : (
        <Text {...paint(palette().dim, scope)}>
          {open.has(id) ? "▾ " : "· "}
        </Text>
      )}
      {guide ? <Text {...paint(palette().dim, scope)}>{guide}</Text> : null}
      <Text {...paint(color, scope)}>{lead.slice(2 + guide.length)}</Text>
      <Button
        key={`fold:open${suffix}`}
        plain
        dimColor
        hover={{ color: palette().text, scope }}
        onPress={() => {
          open.has(id) ? open.delete(id) : open.add(id);
          $.ui.invalidate("ui.render");
        }}
      >
        {`${shown}${" ".repeat(Math.max(0, room - cells(shown)))}`}
      </Button>
    </Box>,
    ...answers.map((answer, j) => {
      const cut = wrap(answer, width - indent.length)[0] ?? "";
      return (
        <Box key={`fold:answer${suffix}:${j}`}>
          <Text {...paint(palette().text, scope)}>
            {`${indent}${cut}${cells(cut) < cells(answer) ? "…" : ""}`}
          </Text>
        </Box>
      );
    }),
  ];
}

function summary($: Render[0], e: Render[1], m: Member) {
  const { Box, Button } = $.ui.resolve(e);
  const isAllOpen = m.ids.every((id) => open.has(id));
  return (
    <Box key="fold:row">
      {pressRow(Button, {
        key: "fold",
        text: `${isAllOpen ? "▾" : "▸"} ${m.label}`,
        width: innerWidth(e.viewport?.columns),
        hover: { color: palette().text, scope: `fold:${m.run}` },
        onPress: () => {
          for (const id of m.ids) isAllOpen ? open.delete(id) : open.add(id);
          $.ui.invalidate("ui.render");
        },
      })}
    </Box>
  );
}

export const fold = (on: On) => {
  on("session.start", { surface: "terminal" }, async ($, e, next) => {
    const r = await next(e);
    void refresh($);
    return r;
  });
  // by a call, every message before it is stored, so a reply that closed the last run is in the list
  on("tool.call", async ($, e, next) => {
    // a subagent's calls draw in its own transcript, not this one
    const isMain = Boolean(e.tool_use_id) && !e.agentId;
    if (isMain) {
      const {
        tool,
        tool_use_id,
        consent: _,
        requestMeta: __,
        ...input
      } = e as typeof e & Record<string, unknown>;
      pending.push({ tool_use_id: tool_use_id!, tool, input });
    }
    void refresh($);
    try {
      return await next(e);
    } finally {
      for (const u of pending)
        if (u.tool_use_id === e.tool_use_id) u.isDone = true;
      void refresh($);
    }
  });
  // clawd holds the unmatched turn.complete, so each reason is its own matcher
  for (const reason of ["answer", "aborted", "refusal", "error"] as const)
    on("turn.complete", { reason }, async ($, e, next) => {
      const r = await next(e);
      // a subagent's turn ends inside the main one
      if (e.agentId) return r;
      pending = [];
      void refresh($);
      return r;
    });

  on(
    "ui.render",
    { component: "ToolUse", surface: "terminal" },
    async ($, e, next) => {
      const id = e.props.tool_use_id;
      if (e.props.tool === "Poll" && noteSettled(e.props.output))
        $.ui.invalidate("ui.render");
      const m = isOn() ? members.get(id) : undefined;
      if (!m) return next(e);
      const { Box, Text } = $.ui.resolve(e);
      return (
        <Box key="fold:call" flexDirection="column">
          {titleLines($, e, id, m, e.props)}
          {open.has(id) ? (
            // the rail spans the card whatever its height: absolute, so its glyphs never stretch the row, and
            // column-reverse, so the overflow it clips is above and its corner sits on the card's last line;
            // the tint stops at the title, so the pressable line reads apart from what it opened
            <Box
              key="fold:rail"
              paddingLeft={1}
              backgroundColor={palette().surface}
            >
              <Box
                position="absolute"
                top={0}
                bottom={0}
                left={0}
                width={1}
                overflow="hidden"
                flexDirection="column-reverse"
              >
                <Text {...paint(palette().dim, `fold:${id}`)}>
                  {`${"│\n".repeat(RAIL_MAX_CARD_LINES)}╰`}
                </Text>
              </Box>
              {await next({
                ...e,
                viewport: e.viewport && {
                  ...e.viewport,
                  columns: e.viewport.columns - 1,
                },
              })}
            </Box>
          ) : null}
          {m.isLast ? summary($, e, m) : null}
        </Box>
      );
    },
  );

  on(
    "ui.render",
    { component: "ToolResult", surface: "terminal" },
    ($, e, next) => {
      const m = isOn() ? members.get(e.props.tool_use_id) : undefined;
      if (!m || open.has(e.props.tool_use_id)) return next(e);
      const { Box } = $.ui.resolve(e);
      return <Box key="fold:result" />;
    },
  );

  // the engine's own fold of reads and searches sits inside a run too: folded, it draws its calls' titles itself, since
  // their rows inside it are not drawn, and once one is unfolded the engine draws the group and each row its own line
  on(
    "ui.render",
    { component: "ToolGroup", surface: "terminal" },
    async ($, e, next) => {
      if (!isOn()) return next(e);
      if (e.props.calls.some((c) => c.tool === "Poll" && noteSettled(c.output)))
        $.ui.invalidate("ui.render");
      const ids = e.props.calls.map((c) => c.tool_use_id ?? "");
      const ms = ids.map((id) => members.get(id));
      const first = ms[0];
      if (!first || ms.some((m) => m?.run !== first.run)) return next(e);
      if (ids.some((id) => open.has(id))) return next(e);
      const { Box } = $.ui.resolve(e);
      const lines = ids.map((id, i) =>
        titleLines($, e, id, ms[i]!, e.props.calls[i]!, `:${i}`),
      );
      const last = ms.at(-1)!;
      return (
        <Box key="fold:group" flexDirection="column">
          {lines.flat()}
          {last.isLast ? summary($, e, last) : null}
        </Box>
      );
    },
  );
};
