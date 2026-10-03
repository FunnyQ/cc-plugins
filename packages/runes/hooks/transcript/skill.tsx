import type { On } from "claude-code";

import { config } from "../config";
import {
  bubble,
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
  success?: boolean;
  commandName?: string;
  allowedTools?: string[];
  model?: string;
  status?: "inline" | "forked";
  readOnly?: boolean;
  agentId?: string;
  result?: string;
  background?: boolean;
};

const remember = memo();

export const skill = (on: On) => {
  // module state, so a hot reload folds every card again
  const open = new Set<string>();

  hideResult(on, "Skill", "skill");

  on(
    "ui.render",
    { component: "ToolUse", props: { tool: "Skill" } },
    ($, e, next) => {
      if (!config.enabled.transcript || !config.enabled.skill) return next(e);
      const { color, error_color, icon, side } = config.skill;
      const { Box, Text, Button } = $.ui.resolve(e);
      const { isRunning, isErrored, isInterrupted, output } = e.props;
      const input = (e.props.input ?? {}) as { skill?: string; args?: string };
      const id = e.requestId;
      const inner = innerWidth(e.viewport?.columns);
      const { text: TEXT, dim: DIM } = palette();
      const o = (typeof output === "object" && output ? output : {}) as Output;

      const forked = o.status === "forked";
      const state = stateOf(e.props) || (o.background ? " · background" : "");
      const title = `${input.skill ?? o.commandName ?? "Skill"}${o.model ? ` · ${o.model}` : ""}${state}`;

      const meta = forked
        ? `forked${o.agentId ? ` · ${o.agentId}` : ""}`
        : o.success !== undefined
          ? [
              "inline",
              o.allowedTools?.length && plural(o.allowedTools.length, "tool"),
              o.readOnly && "read-only",
            ]
              .filter(Boolean)
              .join(" · ")
          : "";
      const info = [input.args?.trim() ?? "", meta].filter(Boolean);

      // a background fork's result only describes the launch, so it gets no fold
      const result =
        forked && !o.background && o.result
          ? remember(`result\0${id}`, () => ({
              text: o.result!,
              count: o.result!.split("\n").length,
            }))
          : undefined;

      // glow runs only once the result is open, so the skills nobody unfolds cost nothing
      const section = (text: { text: string; count: number }) =>
        foldSection(Button, {
          key: "result",
          label: `result · ${plural(text.count, "line")}`,
          isOpen: open.has(id),
          width: inner,
          onPress: () => {
            open.has(id) ? open.delete(id) : open.add(id);
            $.ui.invalidate("ui.render");
          },
          body: () => {
            const runs = glow.view(inner, text.text);
            if (glow.hintDue()) $.ui.toast(INSTALL_HINT);
            return runs?.length
              ? runs.map((line, i) => [
                  `result:${i}`,
                  runLine(Text, line, ({ text: _, color: c, ...style }) => ({
                    ...style,
                    color: c ?? TEXT,
                  })),
                ])
              : remember(`wrap\0${id}\0${inner}`, () =>
                  wrap(text.text, inner),
                ).map((line, i) => [
                  `result:${i}`,
                  <Text color={TEXT}>{line}</Text>,
                ]);
          },
        });

      const rows: [string, unknown][] = [
        ...(typeof output === "string"
          ? errorRows(Text, output, inner, error_color)
          : info.flatMap((line, i) =>
              wrap(line, inner).map((l, j): [string, unknown] => [
                `info:${i}:${j}`,
                <Text color={i || !input.args?.trim() ? DIM : TEXT}>{l}</Text>,
              ]),
            )),
        ...(result ? section(result) : []),
      ];
      return bubble(
        { Box, Text },
        {
          key: "skill",
          color:
            isErrored || isInterrupted || o.success === false
              ? error_color
              : color,
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
