import type { On } from "claude-code";

import { enabled } from "../switch";
import type { Run } from "./ansi";
import { glow, INSTALL_HINT } from "./glow";
import { cells, innerWidth, wrap } from "./text";

// a prompt body taller than this folds to its head
const FOLD_LINES = 6;
const ACCENT = "#1b5ea6";
// nf-md icon U+F064C, needs a Nerd Font
const ICON = "\u{F064C}";
export type Segment = { kind: "body" | "reminder"; text: string };

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
    async ($, e, next) => {
      if (enabled.transcript === false) return next(e);
      const { Box, Text, Button } = $.ui.resolve(e);
      const toggle = (id: string) => () => {
        open.has(id) ? open.delete(id) : open.add(id);
        $.ui.invalidate("ui.render");
      };

      const inner = innerWidth(e.viewport?.columns);
      // each row is one terminal line, so the side borders are one glyph tall
      const row = (key: string, child: unknown) => (
        <Box key={key} flexDirection="row">
          <Text color={ACCENT}>{"│ "}</Text>
          <Box width={inner}>{child as never}</Box>
          <Text color={ACCENT}>{" │"}</Text>
        </Box>
      );
      // a flex-filled rule wrapped to blank rows even clipped to height 1, so every edge is counted
      const label = `${ICON} `;
      const line = (n: number) => (
        <Text color={ACCENT}>{"─".repeat(Math.max(0, n))}</Text>
      );
      const parts = segments(e.props.text);
      // a prompt is markdown too, so its shown body goes through glow; reminders stay plain
      const shown = parts.map((s, i) => {
        const lines = s.text.split("\n");
        return lines.length > FOLD_LINES && !open.has(`${e.requestId}:${i}`)
          ? lines.slice(0, FOLD_LINES).join("\n")
          : s.text;
      });
      const glowed: (Run[][] | null)[] = glow.missing
        ? []
        : await Promise.all(
            parts.map((s, i) =>
              s.kind === "body"
                ? glow.render((argv, init) => $.process.run(argv, init), inner, shown[i])
                : null,
            ),
          );
      if (glow.hintDue()) $.ui.toast(INSTALL_HINT);

      const rows = parts.flatMap((s, i) => {
        const id = `${e.requestId}:${i}`;
        // isExpanded is true for any row fitting the label cap, so folds ignore it
        const isOpen = open.has(id);

        if (s.kind === "reminder") {
          const head = s.text.split("\n")[0].slice(0, inner - 14);
          const button = row(
            `reminder:${i}:row`,
            <Button key={`reminder:${i}`} plain dimColor onPress={toggle(id)}>
              {`${isOpen ? "▾" : "▸"} reminder · ${head}`}
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
        const isLong = lines.length > FOLD_LINES;
        const runs = glowed[i];
        // glow failed or is missing, so the body falls back to plain cell-width wrapping
        const body = runs?.length
          ? runs.map((line, j) =>
              row(
                `body:${i}:${j}`,
                <Text>
                  {line.length
                    ? line.map(({ text, ...style }, k) => (
                        <Text key={String(k)} {...style}>
                          {text}
                        </Text>
                      ))
                    : " "}
                </Text>,
              ),
            )
          : wrap(shown[i], inner).map((line, j) =>
              row(`body:${i}:${j}`, <Text>{line}</Text>),
            );
        if (!isLong) return body;
        return [
          ...body,
          row(
            `body:${i}:more:row`,
            <Button key={`body:${i}:more`} plain dimColor onPress={toggle(id)}>
              {isOpen ? "▾ fold" : `▸ ${lines.length - FOLD_LINES} more lines`}
            </Button>,
          ),
        ];
      });

      return (
        <Box key="prompt" flexDirection="row" marginTop={1}>
          <Box flexDirection="column" flexGrow={1}>
            {/* every edge is drawn by hand: Box borders refuse single sides and hid an absolute label */}
            <Box flexDirection="row">
              <Text color={ACCENT}>{"╭"}</Text>
              {line(inner + 4 - 1 - cells(` ${label}`) - 2)}
              {/* the person's bubble keeps its icon and bar on the right, Claude's on the left */}
              <Text bold color={ACCENT}>
                {` ${label}`}
              </Text>
              <Text color={ACCENT}>{"─╮"}</Text>
            </Box>
            {rows}
            <Box flexDirection="row">
              <Text color={ACCENT}>{"╰"}</Text>
              {line(inner + 2)}
              <Text color={ACCENT}>{"╯"}</Text>
            </Box>
          </Box>
          {/* an empty Box stretches to its row's height, so the bar follows the bubble */}
          <Box
            width={1}
            flexShrink={0}
            marginLeft={1}
            backgroundColor={ACCENT}
          />
        </Box>
      );
    },
  );
};
