import type { Hook, On, SessionMessage } from "claude-code";

import { config } from "../config";
import { paint, palette, pressRow } from "./bubble";
import { cells, innerWidth, plural, wrap } from "./text";
import { shortPath } from "./where";

export type Title = { tool: string; text: string; isRunning?: true };
export type Pending = {
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
};
export type Member = {
  run: string;
  isHead: boolean;
  label: string;
  titles: Title[];
};
type $ = Parameters<Hook<"tool.call">>[0];
type Render = Parameters<Hook<"ui.render">>;

// an MCP tool's full name repeats its server on every call
const nameOf = (tool: string) => tool.replace(/^mcp__.+?__/, "");

// a call's own description when it has one, else its tool and the input that tells it apart
const titleOf = (tool: string, input: Record<string, unknown>) => {
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
      for (const id of run)
        members.set(id, { run: run[0]!, isHead: id === run[0], label, titles });
    }
    run = [];
    tools = [];
    titles = [];
  };
  const seen = new Set<string>();
  const add = (u: Pending, isRunning: boolean) => {
    seen.add(u.tool_use_id);
    if (keep.includes(u.tool)) return;
    run.push(u.tool_use_id);
    tools.push(nameOf(u.tool));
    titles.push({
      tool: u.tool,
      text: titleOf(u.tool, u.input),
      ...(isRunning ? { isRunning: true as const } : {}),
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

// a band of lit cells that sweeps a running title, then a dark gap before it comes round again
const BAND = 3;
const GAP = 3;
export const shimmer = (text: string, tick: number) => {
  const chars = [...text];
  const at = tick % (chars.length + GAP);
  const runs: { text: string; isLit: boolean }[] = [];
  chars.forEach((c, i) => {
    const isLit = i <= at && i > at - BAND;
    const last = runs.at(-1);
    if (last && last.isLit === isLit) last.text += c;
    else runs.push({ text: c, isLit });
  });
  return runs;
};

// written by the ticker and read only by a summary with a running call, so a frame redraws that row alone
const SHIMMER = { plugin: "runes", key: "shimmer" } as const;
// the transcript redraws ten times a second at most, so speed comes from the cells a frame moves, not the frame rate
const TICK_MS = 100;
const STEP = 2;

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
// the main loop's calls still running, and the ticker that shimmers their titles while any is
let inFlight = 0;
let ticker: { cancel: () => void } | undefined;
let tick = 0;
const stopTicker = () => {
  ticker?.cancel();
  ticker = undefined;
};
const open = new Set<string>();
// a run's first call that the engine drew inside its own ToolGroup: the group draws the summary, so the call's row does not
const inGroup = new Set<string>();
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

// the run's summary row, and under it, unfolded, the row it stands at
async function head($: Render[0], e: Render[1], next: Render[2], m: Member) {
  const isOpen = open.has(m.run);
  const { Box, Button, Text } = $.ui.resolve(e);
  // only a run with a call still running reads the frame, so a finished run never redraws for it
  const frame =
    !isOpen && m.titles.some((t) => t.isRunning) ? ((await $.state.get(SHIMMER)).value ?? 0) : 0;
  const width = innerWidth(e.viewport?.columns);
  const scope = `fold:${m.run}`;
  const summary = (
    <Box key="fold:row" marginTop={1}>
      {pressRow(Button, {
        key: "fold",
        text: `${isOpen ? "▾" : "▸"} ${m.label}`,
        width,
        hover: { color: palette().text, scope },
        onPress: () => {
          open.has(m.run) ? open.delete(m.run) : open.add(m.run);
          $.ui.invalidate("ui.render");
        },
      })}
    </Box>
  );
  if (!isOpen)
    return (
      <Box key="fold:closed" flexDirection="column">
        {summary}
        {m.titles.map(({ tool, text: title, isRunning }, i) => {
          const { icon, color } = iconOf(tool);
          const text = isRunning ? `${title} · running` : title;
          const line = wrap(text, width - 7)[0] ?? "";
          const shown = `${line}${cells(line) < cells(text) ? "…" : ""}`;
          return (
            <Box key={`fold:title:${i}`}>
              <Text {...paint(color, scope)}>{`  ${icon}  `}</Text>
              {isRunning ? (
                shimmer(shown, frame).map((r) => (
                  <Text color={r.isLit ? palette().text : palette().dim}>{r.text}</Text>
                ))
              ) : (
                <Text {...paint(palette().dim, scope)}>{shown}</Text>
              )}
            </Box>
          );
        })}
      </Box>
    );
  return (
    <Box key="fold:open" flexDirection="column">
      {summary}
      {await next(e)}
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
      inFlight += 1;
      ticker ??= $.clock.every(TICK_MS, () => {
        tick += STEP;
        void $.state.set(SHIMMER, tick);
      });
    }
    void refresh($);
    try {
      return await next(e);
    } finally {
      // the call's end takes its running mark off, or drops it from the run when it failed
      if (isMain && --inFlight === 0) stopTicker();
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
      // an abort can end a turn without every call coming back through tool.call
      inFlight = 0;
      stopTicker();
      void refresh($);
      return r;
    });

  // registered ahead of every card rune, so a folded row never builds the card it hides
  on(
    "ui.render",
    { component: "ToolUse", surface: "terminal" },
    async ($, e, next) => {
      const m = isOn() ? members.get(e.props.tool_use_id) : undefined;
      if (!m) return next(e);
      if (m.isHead && !inGroup.has(e.props.tool_use_id))
        return head($, e, next, m);
      if (open.has(m.run)) return next(e);
      const { Box } = $.ui.resolve(e);
      return <Box key="fold:hidden" />;
    },
  );

  // a tool no rune draws keeps its engine result row under the call, which has to fold with it
  on(
    "ui.render",
    { component: "ToolResult", surface: "terminal" },
    ($, e, next) => {
      const m = isOn() ? members.get(e.props.tool_use_id) : undefined;
      if (!m || open.has(m.run)) return next(e);
      const { Box } = $.ui.resolve(e);
      return <Box key="fold:result" />;
    },
  );

  // the engine's own fold of reads and searches sits inside a run too, and may hold the run's first call
  on(
    "ui.render",
    { component: "ToolGroup", surface: "terminal" },
    async ($, e, next) => {
      if (!isOn()) return next(e);
      const ms = e.props.calls.map((c) =>
        c.tool_use_id ? members.get(c.tool_use_id) : undefined,
      );
      const first = ms[0];
      if (!first || ms.some((m) => m?.run !== first.run)) return next(e);
      const lead = ms.find((m) => m!.isHead);
      if (lead) {
        inGroup.add(lead.run);
        return head($, e, next, lead);
      }
      if (open.has(first.run)) return next(e);
      const { Box } = $.ui.resolve(e);
      return <Box key="fold:group" />;
    },
  );
};
