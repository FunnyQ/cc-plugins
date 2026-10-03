import type { On } from "claude-code";

import { config } from "../config";
import { bubble, foldRows, runLine } from "./bubble";
import { glow, INSTALL_HINT } from "./glow";
import { cells, innerWidth, wrap } from "./text";

type Segment = { kind: "body" | "reminder"; text: string };

export const segments = (text: string): Segment[] => {
  const out: Segment[] = [];
  const push = (kind: Segment["kind"], raw: string) => {
    const t = raw.replace(/^\n+|\n+$/g, "");
    if (t) out.push({ kind, text: t });
  };
  let last = 0;
  for (const m of text.matchAll(
    /<system-reminder>([\s\S]*?)<\/system-reminder>/g,
  )) {
    push("body", text.slice(last, m.index));
    push("reminder", m[1]);
    last = m.index + m[0].length;
  }
  push("body", text.slice(last));
  return out;
};

export const prompt = (on: On) => {
  // module state, so a hot reload folds every row again
  const open = new Set<string>();

  on(
    "ui.render",
    { component: "UserMessage", props: { origin: { kind: "composer" } } },
    ($, e, next) => {
      if (!config.enabled.transcript || !config.enabled.prompt) return next(e);
      // a prompt body taller than fold_lines folds to its head
      const { color, icon, side, fold_lines: foldLines } = config.prompt;
      const { Box, Text, Button } = $.ui.resolve(e);
      const toggle = (id: string) => () => {
        open.has(id) ? open.delete(id) : open.add(id);
        $.ui.invalidate("ui.render");
      };

      const inner = innerWidth(e.viewport?.columns);
      const row = (key: string, child: unknown): [string, unknown] => [key, child];
      const parts = segments(e.props.text);
      // a prompt is markdown too, so its shown body goes through glow; reminders stay plain
      const shown = parts.map((s, i) => {
        const lines = s.text.split("\n");
        return lines.length > foldLines && !open.has(`${e.requestId}:${i}`)
          ? lines.slice(0, foldLines).join("\n")
          : s.text;
      });
      const glowed = parts.map((s, i) =>
        s.kind === "body" ? glow.view(inner, shown[i]) : null,
      );
      if (glow.hintDue()) $.ui.toast(INSTALL_HINT);

      const rows = parts.flatMap((s, i) => {
        const id = `${e.requestId}:${i}`;
        // isExpanded is true for any row fitting the label cap, so folds ignore it
        const isOpen = open.has(id);

        if (s.kind === "reminder") {
          const prefix = `${isOpen ? "▾" : "▸"} reminder · `;
          // cut by cells, not characters: a wide head wraps the button and the one-glyph borders break
          const head = wrap(s.text.split("\n")[0], inner - cells(prefix))[0];
          const button = row(
            `reminder:${i}:row`,
            <Button key={`reminder:${i}`} plain dimColor onPress={toggle(id)}>
              {prefix + head}
            </Button>,
          );
          if (!isOpen) return [button];
          return [
            button,
            ...wrap(s.text, inner - 2).map((line, j) =>
              row(
                j === 0 ? `reminder:${i}:body` : `reminder:${i}:${j}`,
                <Text dimColor>{`  ${line}`}</Text>,
              ),
            ),
          ];
        }

        const lines = s.text.split("\n");
        const isLong = lines.length > foldLines;
        const runs = glowed[i];
        // glow failed or is missing, so the body falls back to plain cell-width wrapping
        const body = runs?.length
          ? runs.map((line, j) =>
              row(
                `body:${i}:${j}`,
                runLine(Text, line),
              ),
            )
          : wrap(shown[i], inner).map((line, j) =>
              row(`body:${i}:${j}`, <Text>{line}</Text>),
            );
        if (!isLong) return body;
        return [
          ...body,
          ...foldRows(Button, {
            key: `body:${i}`,
            isOpen,
            hidden: lines.length - foldLines,
            width: inner,
            onPress: toggle(id),
          }),
        ];
      });

      return bubble(
        { Box, Text },
        { key: "prompt", color, icon, side, inner, rows },
      );
    },
  );
};
