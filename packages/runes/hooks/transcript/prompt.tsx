import type { On } from "claude-code";

import { enabled } from "../switch";
import type { Run } from "./ansi";
import { GLOW_INIT, glow, glowArgv, toLines } from "./glow";

// a prompt body taller than this folds to its head
const FOLD_LINES = 6;
const ACCENT = "#1b5ea6";
// nf-md icon U+F064C, needs a Nerd Font
const ICON = "\u{F064C}";
// what the bar, its margin, the transcript gutter and the side borders take from the viewport
const CHROME = 7;

// East Asian wide ranges and emoji take two cells
const WIDE =
  /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1FAFF}]/u;

export const cells = (text: string): number =>
  [...text].reduce((n, ch) => n + (WIDE.test(ch) ? 2 : 1), 0);

// breaks by cell width, not at word boundaries: hard-wraps mid-word, word wrap if it reads badly
export const wrap = (text: string, width: number): string[] =>
  text.split("\n").flatMap((line) => {
    const out: string[] = [];
    let cur = "";
    let used = 0;
    for (const ch of line) {
      const w = WIDE.test(ch) ? 2 : 1;
      if (used + w > width && cur) {
        out.push(cur);
        cur = "";
        used = 0;
      }
      cur += ch;
      used += w;
    }
    out.push(cur);
    return out;
  });

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

      const inner = Math.max(10, (e.viewport?.columns ?? 80) - CHROME);
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
      const shownOf = (s: Segment, i: number) => {
        const lines = s.text.split("\n");
        return lines.length > FOLD_LINES && !open.has(`${e.requestId}:${i}`)
          ? lines.slice(0, FOLD_LINES).join("\n")
          : s.text;
      };
      const glowed = new Map<number, Run[][]>();
      for (const [i, s] of parts.entries()) {
        if (s.kind !== "body" || glow.missing) continue;
        const key = `${inner}\0${shownOf(s, i)}`;
        if (!glow.rendered.has(key)) {
          let lines: Run[][] | null = null;
          try {
            const { exitCode, stdout } = await $.process.run(glowArgv(inner), {
              ...GLOW_INIT,
              stdin: shownOf(s, i),
            });
            if (exitCode === 0) lines = toLines(stdout);
          } catch {
            glow.missing = true;
          }
          glow.remember(key, lines);
        }
        const lines = glow.rendered.get(key);
        if (lines?.length) glowed.set(i, lines);
      }

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
        const runs = glowed.get(i);
        // glow failed or is missing, so the body falls back to plain cell-width wrapping
        const body = runs
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
          : wrap(shownOf(s, i), inner).map((line, j) =>
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
