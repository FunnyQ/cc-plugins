import type { On } from "claude-code";

import { config } from "../config";
import { bubble, foldRows, mute, runLine } from "./bubble";
import { glow, INSTALL_HINT } from "./glow";
import { innerWidth, wrap } from "./text";

const FRAME_END = "The report follows:\n";

// the harness wraps a subagent's report in a frame for the model and indents every report line by two
export const split = (text: string): { frame?: string; report: string } => {
  const at = text.startsWith("[Subagent hand-back]")
    ? text.indexOf(FRAME_END)
    : -1;
  if (at < 0) return { report: text };
  return {
    frame: text.slice(0, at + FRAME_END.length - 1),
    report: text
      .slice(at + FRAME_END.length)
      .split("\n")
      .map((l) => l.replace(/^ {2}/, ""))
      .join("\n"),
  };
};

export const peer = (on: On) => {
  // module state, so a hot reload folds every card again
  const open = new Set<string>();

  on(
    "ui.render",
    { component: "UserMessage", props: { origin: { kind: "peer" } } },
    ($, e, next) => {
      if (!config.enabled.transcript || !config.enabled.peer) return next(e);
      const { color, icon, side, fold_lines: foldLines } = config.peer;
      const { Box, Text, Button } = $.ui.resolve(e);
      const toggle = (id: string) => () => {
        open.has(id) ? open.delete(id) : open.add(id);
        $.ui.invalidate("ui.render");
      };

      // two columns in, and two narrower, so its right edge stays with the other bubbles
      const inner = innerWidth(e.viewport?.columns) - 2;
      const { frame, report } = split(e.props.text);
      const lines = report.split("\n");
      const isLong = lines.length > foldLines;
      const isOpen = open.has(`${e.requestId}:body`);
      const shown =
        isLong && !isOpen ? lines.slice(0, foldLines).join("\n") : report;
      const runs = glow.view(inner, shown);
      if (glow.hintDue()) $.ui.toast(INSTALL_HINT);

      const frameOpen = open.has(`${e.requestId}:frame`);
      const frameRows: [string, unknown][] = frame
        ? [
            [
              "frame:row",
              <Button
                key="frame"
                plain
                dimColor
                onPress={toggle(`${e.requestId}:frame`)}
              >
                {`${frameOpen ? "▾" : "▸"} hand-back frame`}
              </Button>,
            ],
            ...(frameOpen
              ? wrap(frame, inner - 2).map((line, j): [string, unknown] => [
                  `frame:${j}`,
                  <Text dimColor>{`  ${line}`}</Text>,
                ])
              : []),
          ]
        : [];
      // glow failed or is missing, so the report falls back to plain cell-width wrapping
      const body: [string, unknown][] = runs?.length
        ? runs.map((line, j) => [
            `body:${j}`,
            runLine(Text, line, undefined, { dimColor: true }),
          ])
        : wrap(shown, inner).map((line, j) => [
            `body:${j}`,
            <Text dimColor>{line}</Text>,
          ]);

      return bubble(
        { Box, Text },
        {
          key: "peer",
          // another agent's words rest a step behind the conversation's own
          color: mute(color),
          indent: 2,
          icon,
          title: e.props.from?.name ?? "peer",
          side,
          inner,
          rows: [
            ...frameRows,
            ...body,
            ...(isLong
              ? foldRows(Button, {
                  key: "body",
                  isOpen,
                  hidden: lines.length - foldLines,
                  width: inner,
                  onPress: toggle(`${e.requestId}:body`),
                })
              : []),
          ],
        },
      );
    },
  );
};
