import type { Hook, On, SessionMessage } from "claude-code";

import { config } from "../config";
import { paint, palette, pressRow } from "./bubble";
import { cells, innerWidth, plural, wrap } from "./text";
import { shortPath } from "./where";

export type Title = {
  tool: string;
  text: string;
  isRunning?: true;
  answers?: string[];
};
export type Pending = {
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
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

// an MCP tool's full name repeats its server on every call
const nameOf = (tool: string) => tool.replace(/^mcp__.+?__/, "");

type Question = { question?: unknown; header?: unknown };
const questionsOf = (input: Record<string, unknown>) =>
  (Array.isArray(input.questions) ? input.questions : []) as Question[];

// what the person picked for each question; several questions name their headers, so each answer says which it is
const answersOf = (input: Record<string, unknown>, result: unknown) => {
  const given =
    (result as
      | { answers?: Record<string, unknown>; response?: unknown }
      | undefined) ?? {};
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

// a call's own description when it has one, else its tool and the input that tells it apart
const titleOf = (tool: string, input: Record<string, unknown>) => {
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

// a run is the calls between two pieces of text; the live one folds from its first call, so a turn never shows its
// cards before folding them, and a closed one folds only from min calls, so a lone call ends drawn as its card
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
  const close = (least = min) => {
    if (run.length >= least) {
      const counts = new Map<string, number>();
      for (const t of tools) counts.set(t, (counts.get(t) ?? 0) + 1);
      const label = [
        plural(run.length, "call"),
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
  };
  const seen = new Set<string>();
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
      ...(answers.length ? { answers } : {}),
    });
  };
  for (const m of messages) {
    // tool results ride on user messages with no text; anything the person typed ends the run
    if (m.text.trim()) close();
    // a failed call stays out of the run, so its card is drawn
    for (const u of m.toolUses)
      if (!u.isError) add(u, u.result === undefined && u.text === undefined);
  }
  // a call tool.call has seen that the transcript does not hold yet runs at the end of the live run
  for (const u of pending) if (!seen.has(u.tool_use_id)) add(u, true);
  close(1);
  return members;
};

// nf-oct-search U+F422 and nf-fa-wrench U+F0AD, need a Nerd Font
export const SEARCH_ICON = "\u{F422}";
const TOOL_ICON = "\u{F0AD}";

// a tool with a card rune takes that card's icon and colour, read at draw time so config.yaml's apply
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

// module state, so a hot reload folds every run again
let members = new Map<string, Member>();
// the main loop's calls this turn, from tool.call; a turn's end clears them, by when the transcript holds each
let pending: Pending[] = [];
// the calls drawn as their card under their title
const open = new Set<string>();
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

// a call's title line, pressed to draw its card under it, then any answers it got; a ToolGroup draws several, so
// it suffixes each key with the call's place in the group
function titleLines(
  $: Render[0],
  e: Render[1],
  id: string,
  m: Member,
  suffix = "",
) {
  const { Box, Button, Client, Text } = $.ui.resolve(e);
  const { tool, text: title, isRunning, answers = [] } = m.title;
  const width = innerWidth(e.viewport?.columns);
  const scope = `fold:${id}`;
  const { icon, color } = iconOf(tool);
  // the spinner's two cells, or a dot holding them, so every title starts in one column
  const lead = `  ${icon}  `;
  const room = width - cells(lead);
  const line = wrap(title, room - 2)[0] ?? "";
  const shown = `${line}${cells(line) < cells(title) ? "…" : ""}`;
  // an answer sits two cells further in than the title's text
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
        <Text {...paint(palette().dim, scope)}>{"· "}</Text>
      )}
      <Text {...paint(color, scope)}>{lead.slice(2)}</Text>
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

// the summary under the run's last call, pressed to unfold every call, or fold them all once each is unfolded
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
  // a resumed session's runs fold from the start; register.tsx holds the unmatched session.start
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
      // the call's end takes its running mark off, or drops it from the run when it failed
      void refresh($);
    }
  });
  // every way a turn ends clears its pending calls, or one an abort cut before it was stored runs on forever;
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

  // registered ahead of every card rune, so a folded row never builds the card it hides
  on(
    "ui.render",
    { component: "ToolUse", surface: "terminal" },
    async ($, e, next) => {
      const id = e.props.tool_use_id;
      const m = isOn() ? members.get(id) : undefined;
      if (!m) return next(e);
      const { Box } = $.ui.resolve(e);
      return (
        <Box key="fold:call" flexDirection="column">
          {titleLines($, e, id, m)}
          {open.has(id) ? await next(e) : null}
          {m.isLast ? summary($, e, m) : null}
        </Box>
      );
    },
  );

  // a tool no rune draws keeps its engine result row under the call, which has to fold with it
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
      const ids = e.props.calls.map((c) => c.tool_use_id ?? "");
      const ms = ids.map((id) => members.get(id));
      const first = ms[0];
      if (!first || ms.some((m) => m?.run !== first.run)) return next(e);
      if (ids.some((id) => open.has(id))) return next(e);
      const { Box } = $.ui.resolve(e);
      const lines = ids.map((id, i) => titleLines($, e, id, ms[i]!, `:${i}`));
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
