import type { On } from "claude-code";

import { config } from "../config";
import { dropLead, leadingSpaces, parseAnsi, type Run } from "./ansi";
import { bubble, foldRows, isLight, memo, paint, PALETTES, runLine } from "./bubble";
import { glow } from "./glow";
import { type Kind, layout } from "./shell";
import { language } from "./sniff";
import { innerWidth, wrapRuns } from "./text";

type Style = { color?: string; bold?: boolean; italic?: boolean };

const shell = (p: (typeof PALETTES)["dark"]): Partial<Record<Kind, Style>> => ({
  prompt: { color: p.dim },
  flag: { color: p.dim },
  str: { color: p.str },
  var: { color: p.var },
  op: { color: p.op },
  comment: { color: p.dim, italic: true },
});
const SHELL = { dark: shell(PALETTES.dark), light: shell(PALETTES.light) };

// a finished card's command and output never change, yet every redraw re-tokenized, re-parsed and re-wrapped them
const remember = memo();

// a progress bar redraws its line with \r, so only the text after the last one is what the terminal showed
const toRuns = (text: unknown, color?: string): Run[][] =>
  typeof text === "string" && text
    ? text
        .replace(/\n+$/, "")
        .split("\n")
        .map((l) => {
          const t = parseAnsi(l.slice(l.lastIndexOf("\r") + 1))
            .map((r) => r.text)
            .join("")
            .replaceAll("\t", "    ");
          return t ? [{ text: t, ...(color ? { color } : {}) }] : [];
        })
    : [];

// glow indents a fenced block; the indent every line shares goes, so the code starts at the card's edge
const dedent = (lines: Run[][]): Run[][] => {
  const lead = (runs: Run[]) =>
    runs.some((r) => r.text.trim()) ? leadingSpaces(runs) : Infinity;
  const n = Math.min(...lines.map(lead));
  return Number.isFinite(n) && n > 0
    ? lines.map((runs) => dropLead(runs, n))
    : lines;
};

export const bash = (on: On) => {
  // module state, so a hot reload folds every card again
  const open = new Set<string>();

  // the engine draws ToolResult inside its own ToolUse row, so a hook that replaces the row draws the output too
  on(
    "ui.render",
    { component: "ToolUse", props: { tool: "Bash" } },
    ($, e, next) => {
      if (!config.enabled.transcript || !config.enabled.bash) return next(e);
      const {
        color,
        error_color,
        icon,
        output_icon: outputIcon,
        side,
        fold_lines: foldLines,
      } = config.bash;
      const { Box, Text, Button } = $.ui.resolve(e);
      const { isRunning, isErrored, isInterrupted, output } = e.props;
      const { command = "", description } = (e.props.input ?? {}) as {
        command?: string;
        description?: string;
      };
      const id = e.requestId;
      const inner = innerWidth(e.viewport?.columns);
      // the call keeps two columns free on its right, so the output card under it reaches past its edge
      const callInner = inner - 2;
      const isBad = isErrored || isInterrupted;
      const tint = isBad ? error_color : color;

      const fold = (
        part: string,
        total: number,
        scope: string,
        width: number,
      ) => {
        const key = `${id}:${part}`;
        if (total <= foldLines) return [];
        return foldRows(Button, {
          key: part,
          isOpen: open.has(key),
          hidden: total - foldLines,
          width,
          hover: { color: tint, scope },
          onPress: () => {
            open.has(key) ? open.delete(key) : open.add(key);
            $.ui.invalidate("ui.render");
          },
        });
      };
      const visible = <T,>(part: string, all: T[]) =>
        open.has(`${id}:${part}`) ? all : all.slice(0, foldLines);
      // each card is one hover group, so the pointer anywhere on it lights all of it
      const callScope = `${id}:call`;
      const outScope = `${id}:out`;
      const theme = isLight() ? "light" : "dark";
      const { text: TEXT, dim: DIM } = PALETTES[theme];
      const tokenStyle = ({ kind }: { kind: Kind }): object => {
        const s = kind === "cmd" ? { bold: true, color } : SHELL[theme][kind];
        if (!s) return paint(TEXT, callScope);
        return s.color ? { ...s, ...paint(s.color, callScope) } : s;
      };
      // the link runs through the middle column of the call card, and the output card meets it there
      const linkAt = Math.floor((callInner + 4) / 2);

      const state = isInterrupted
        ? " · interrupted"
        : isRunning
          ? " · running"
          : "";
      const lines = remember(`cmd\0${id}\0${callInner}\0${command.length}`, () =>
        layout(command, callInner),
      );
      const call = bubble(
        { Box, Text },
        {
          key: "bash",
          color: tint,
          icon,
          title: `${description ?? "Bash"}${state}`,
          side,
          inner: callInner,
          rows: [
            ...visible("cmd", lines).map((line, i): [string, unknown] => [
              `cmd:${i}`,
              runLine(Text, line, tokenStyle, { hover: { scope: callScope } }),
            ]),
            ...fold("cmd", lines.length, callScope, callInner),
          ],
          link: isRunning ? undefined : { to: "down", at: linkAt },
          bar: false,
          scope: callScope,
        },
      );
      if (isRunning) return call;

      const o = (output ?? {}) as {
        stdout?: unknown;
        stderr?: unknown;
        backgroundTaskId?: string;
      };
      const stdout = typeof o.stdout === "string" ? o.stdout : "";
      // the output's lengths are in every key: a card can draw once without output before its result lands
      const size = `${stdout.length}\0${String(o.stderr ?? "").length}\0${typeof output === "string" ? output.length : -1}`;
      const { lang, fence } = remember(`lang\0${id}\0${isBad}\0${size}`, () => {
        const lang = isBad || !stdout ? undefined : language(command, stdout);
        const fence =
          lang === "markdown"
            ? stdout
            : `\`\`\`${lang}\n${stdout.replace(/\n+$/, "")}\n\`\`\``;
        return { lang, fence };
      });
      const glowed = lang ? glow.view(inner - 2, fence) : null;
      // until glow has rendered, or with no language to give it, the output draws as plain text
      const out = remember(
        `out\0${id}\0${inner}\0${isBad}\0${size}\0${glowed?.length ? "glow" : "plain"}`,
        () => {
          const source: Run[][] = glowed?.length
            ? [
                ...(lang === "markdown" ? glowed : dedent(glowed)),
                ...toRuns(o.stderr, error_color),
              ]
            : typeof output === "string"
              ? toRuns(output, error_color)
              : [...toRuns(stdout), ...toRuns(o.stderr, error_color)];
          return source.flatMap((runs) =>
            runs.length ? wrapRuns(runs, inner - 2) : [[]],
          );
        },
      );
      const outRows: [string, unknown][] = [
        ...visible("out", out).map((runs, i): [string, unknown] => [
          `out:${i}`,
          runLine(
            Text,
            runs,
            ({ text: _, color: c, ...style }) => ({
              ...style,
              ...paint(c ?? TEXT, outScope),
            }),
            { hover: { scope: outScope } },
          ),
        ]),
        ...(out.length
          ? []
          : [
              [
                "out:empty",
                <Text {...paint(DIM, outScope)}>
                  {o.backgroundTaskId
                    ? `(running in background: ${o.backgroundTaskId})`
                    : "(no output)"}
                </Text>,
              ] as [string, unknown],
            ]),
        ...fold("out", out.length, outScope, inner - 2),
      ];
      return (
        <Box key="bash:pair" flexDirection="column">
          {call}
          {bubble(
            { Box, Text },
            {
              key: "bash:output",
              color: tint,
              icon: outputIcon,
              title: isBad ? "error" : "output",
              side,
              // two columns in, and two narrower, so its right edge stays with the other bubbles
              inner: inner - 2,
              indent: 2,
              rows: outRows,
              link: { to: "up", at: linkAt },
              bar: false,
              scope: outScope,
            },
          )}
        </Box>
      );
    },
  );
};
