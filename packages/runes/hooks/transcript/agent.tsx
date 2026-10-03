import type { On } from "claude-code";

import { config } from "../config";
import {
  bubble,
  DIVIDER,
  errorRows,
  foldSection,
  hideResult,
  memo,
  palette,
  runLine,
  stateOf,
} from "./bubble";
import { glow, INSTALL_HINT } from "./glow";
import { innerWidth, plural, wrap } from "./text";

type Output = {
  status?: "completed" | "async_launched" | "remote_launched";
  agentId?: string;
  resolvedModel?: string;
  content?: { type: string; text?: string }[];
  handbackReport?: { text: string; warning?: string };
  totalToolUseCount?: number;
  totalDurationMs?: number;
  totalTokens?: number;
  toolStats?: {
    readCount: number;
    searchCount: number;
    bashCount: number;
    editFileCount: number;
    linesAdded: number;
    linesRemoved: number;
    otherToolCount: number;
  };
  sessionUrl?: string;
};

const duration = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 60
    ? `${s}s`
    : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

const tokens = (n: number) =>
  n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;

// the zero counts go, so a read-only agent's line is not a row of zeros
const statsLine = (t: NonNullable<Output["toolStats"]>) =>
  [
    t.readCount && plural(t.readCount, "read"),
    t.searchCount && plural(t.searchCount, "search", "searches"),
    t.bashCount && `${t.bashCount} bash`,
    t.editFileCount &&
      `${plural(t.editFileCount, "edit")} +${t.linesAdded} −${t.linesRemoved}`,
    t.otherToolCount && `${t.otherToolCount} other`,
  ]
    .filter(Boolean)
    .join(" · ");

const remember = memo();

// a full id shows as its family, so claude-sonnet-5-5 reads sonnet; an alias stays as given
const family = (model: string) => model.match(/^claude-([a-z]+)-/)?.[1] ?? model;

export const agent = (on: On) => {
  // module state, so a hot reload folds every card again
  const open = new Set<string>();

  // no Agent output carries the effort, so it is read off the subagent's own model requests, by agentId
  const efforts = new Map<string, string>();
  on("turn.step", async function* ($, e, next) {
    const effort = e.effort === undefined ? undefined : String(e.effort);
    if (e.agentId && effort && efforts.get(e.agentId) !== effort) {
      efforts.set(e.agentId, effort);
      $.ui.invalidate("ui.render");
    }
    return yield* next(e);
  });

  hideResult(on, "Agent", "agent");

  on(
    "ui.render",
    { component: "ToolUse", props: { tool: "Agent" } },
    ($, e, next) => {
      if (!config.enabled.transcript || !config.enabled.agent) return next(e);
      const { color, error_color, icon, side } = config.agent;
      const { Box, Text, Button } = $.ui.resolve(e);
      const { isRunning, isErrored, isInterrupted, output } = e.props;
      const input = (e.props.input ?? {}) as {
        description?: string;
        prompt?: string;
        subagent_type?: string;
        model?: string;
      };
      const id = e.requestId;
      const inner = innerWidth(e.viewport?.columns);
      const { text: TEXT, dim: DIM } = palette();
      const o = (typeof output === "object" && output ? output : {}) as Output;

      const name = input.model ?? o.resolvedModel;
      const effort = o.agentId ? efforts.get(o.agentId) : undefined;
      const model = name && `${family(name)}${effort ? `/${effort}` : ""}`;
      const state =
        stateOf(e.props) ||
        (o.status === "async_launched"
          ? " · background"
          : o.status === "remote_launched"
            ? " · remote"
            : "");
      const title = `${input.description ?? "Agent"}${model ? ` · ${model}` : ""}${state}`;

      const type = input.subagent_type ?? "general-purpose";
      const meta =
        o.status === "completed"
          ? [
              type,
              plural(o.totalToolUseCount ?? 0, "tool"),
              duration(o.totalDurationMs ?? 0),
              `${tokens(o.totalTokens ?? 0)} tokens`,
            ].join(" · ")
          : o.status === "async_launched" && o.agentId
            ? `${type} · ${o.agentId}`
            : type;
      const stats = o.toolStats ? statsLine(o.toolStats) : "";
      const info = [meta, stats, o.sessionUrl ?? ""].filter(Boolean);

      // the texts and their line counts, read once per call rather than on every draw
      const { prompt, report } = remember(
        `texts\0${id}\0${o.status ?? ""}`,
        () => {
          const lines = (text: string) => ({ text, count: text.split("\n").length });
          const report =
            o.handbackReport?.text ??
            (o.content ?? [])
              .flatMap((c) => (c.type === "text" && c.text ? [c.text] : []))
              .join("\n\n");
          return { prompt: lines(input.prompt ?? ""), report: lines(report) };
        },
      );

      // glow runs only once a section is open, so the agents nobody unfolds cost nothing
      const section = (name: string, text: { text: string; count: number }) => {
        const key = `${id}:${name}`;
        return foldSection(Button, {
          key: name,
          label: `${name} · ${plural(text.count, "line")}`,
          isOpen: open.has(key),
          width: inner,
          onPress: () => {
            open.has(key) ? open.delete(key) : open.add(key);
            $.ui.invalidate("ui.render");
          },
          body: () => {
            const runs = glow.view(inner, text.text);
            if (glow.hintDue()) $.ui.toast(INSTALL_HINT);
            return runs?.length
              ? runs.map((line, i) => [
                  `${name}:${i}`,
                  runLine(Text, line, ({ text: _, color: c, ...style }) => ({
                    ...style,
                    color: c ?? TEXT,
                  })),
                ])
              : remember(`wrap\0${key}\0${inner}`, () => wrap(text.text, inner)).map(
                  (line, i) => [`${name}:${i}`, <Text color={TEXT}>{line}</Text>],
                );
          },
        });
      };

      const rows: [string, unknown][] = [
        ...(typeof output === "string"
          ? errorRows(Text, output, inner, error_color)
          : info.flatMap((line, i) =>
              wrap(line, inner).map((l, j): [string, unknown] => [
                `info:${i}:${j}`,
                <Text color={i ? DIM : TEXT}>{l}</Text>,
              ]),
            )),
        ["divider", DIVIDER],
        ...(prompt.text ? section("prompt", prompt) : []),
        ...(o.status === "completed" && report.text ? section("report", report) : []),
      ];
      return bubble(
        { Box, Text },
        {
          key: "agent",
          color: isErrored || isInterrupted ? error_color : color,
          icon,
          title,
          side,
          inner,
          rows,
          bar: false,
        },
      );
    },
  );
};
