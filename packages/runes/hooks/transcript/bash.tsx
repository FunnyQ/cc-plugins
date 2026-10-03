import type { On } from "claude-code";

import { config } from "../config";
import { parseAnsi, type Run } from "./ansi";
import { bubble, DIVIDER, paint } from "./bubble";
import { glow } from "./glow";
import { type Kind, layout } from "./shell";
import { language } from "./sniff";
import { cells, innerWidth, wrap, wrapRuns } from "./text";

type Line = { text: string; isErr?: boolean };

type Style = { color?: string; bold?: boolean; italic?: boolean };

// stands in for the terminal's foreground, which has no hex to mute; tuned for a dark theme
const TEXT = "#d4d4d4";
// the quiet kinds; dimColor lit every card's dim text at once under any pointer, live
const DIM = "#8a8a8a";

// fixed shell palette; move it into config.yaml if anyone wants to retheme it
const SHELL: Partial<Record<Kind, Style>> = {
  prompt: { color: DIM },
  flag: { color: DIM },
  str: { color: "#b5bd68" },
  var: { color: "#b294bb" },
  op: { color: "#de935f" },
  comment: { color: DIM, italic: true },
};

// a progress bar redraws its line with \r, so only the text after the last one is what the terminal showed
const plain = (text: string) =>
  text
    .replace(/\n+$/, "")
    .split("\n")
    .map((l) =>
      parseAnsi(l.slice(l.lastIndexOf("\r") + 1))
        .map((r) => r.text)
        .join("")
        .replaceAll("\t", "    "),
    );

const outputLines = (output: unknown): Line[] => {
  if (typeof output === "string")
    return plain(output).map((text) => ({ text, isErr: true }));
  const o = (output ?? {}) as {
    stdout?: string;
    stderr?: string;
    backgroundTaskId?: string;
  };
  return [
    ...(o.stdout ? plain(o.stdout).map((text) => ({ text })) : []),
    ...(o.stderr ? plain(o.stderr).map((text) => ({ text, isErr: true })) : []),
  ];
};

// drops the first n characters of a line, across as many runs as they span
const dropLead = (runs: Run[], n: number): Run[] => {
  const out = runs.map((r) => ({ ...r }));
  while (n > 0 && out.length) {
    const cut = Math.min(n, out[0]!.text.length);
    out[0]!.text = out[0]!.text.slice(cut);
    n -= cut;
    if (!out[0]!.text) out.shift();
  }
  return out;
};

// glow indents a fenced block; the indent every line shares goes, so the code starts at the card's edge
const dedent = (lines: Run[][]): Run[][] => {
  const lead = (runs: Run[]) => {
    const t = runs.map((r) => r.text).join("");
    return t.trim() ? t.length - t.trimStart().length : Infinity;
  };
  const n = Math.min(...lines.map(lead));
  return Number.isFinite(n) && n > 0 ? lines.map((runs) => dropLead(runs, n)) : lines;
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
      const inner = innerWidth(e.viewport?.columns);
      const isBad = isErrored || isInterrupted;

      const flip = (id: string) => () => {
        open.has(id) ? open.delete(id) : open.add(id);
        $.ui.invalidate("ui.render");
      };
      // Box takes no onPress, so the Button's label is padded to the row's width to make the whole row its target
      const fold = (
        part: string,
        total: number,
        scope: string,
        width: number,
      ): [string, unknown][] => {
        const id = `${e.requestId}:${part}`;
        if (total <= foldLines) return [];
        const text = open.has(id) ? "▾ fold" : `▸ ${total - foldLines} more lines`;
        const left = Math.max(0, Math.floor((width - cells(text)) / 2));
        const right = Math.max(0, width - cells(text) - left);
        return [
          [`${part}:divider`, DIVIDER],
          [
            `${part}:more:row`,
            <Button
              key={`${part}:more`}
              plain
              hover={{ color: isBad ? error_color : color, scope }}
              onPress={flip(id)}
            >
              {`${" ".repeat(left)}${text}${" ".repeat(right)}`}
            </Button>,
          ],
        ];
      };
      const visible = <T,>(part: string, all: T[]) =>
        open.has(`${e.requestId}:${part}`) ? all : all.slice(0, foldLines);
      // each card is one hover group, so the pointer anywhere on it lights all of it
      const callScope = `${e.requestId}:call`;
      const outScope = `${e.requestId}:out`;
      // plain text takes a fixed grey: a dimColor hover lit every card's plain text at once, live
      const quiet = (scope: string) => paint(TEXT, scope);
      const tokenStyle = (kind: Kind): object => {
        const s = kind === "cmd" ? { bold: true, color } : SHELL[kind];
        if (!s) return quiet(callScope);
        return s.color ? { ...s, ...paint(s.color, callScope) } : s;
      };

      const state = isInterrupted ? " · interrupted" : isRunning ? " · running" : "";
      // the glyph draws wider than its one cell and covers the space after it, so it gets two
      const lines = layout(command, inner);
      const label = wrap(`${icon}  ${description ?? "Bash"}${state}`, inner - 3)[0];
      const cmdRows: [string, unknown][] = [
        ...visible("cmd", lines).map((line, i): [string, unknown] => [
          `cmd:${i}`,
          <Text hover={{ scope: callScope }}>
            {line.map((t, j) => (
              <Text key={String(j)} {...tokenStyle(t.kind)}>
                {t.text}
              </Text>
            ))}
          </Text>,
        ]),
        ...fold("cmd", lines.length, callScope, inner),
      ];
      const call = bubble(
        { Box, Text },
        {
          key: "bash",
          color: isBad ? error_color : color,
          label: `${label} `,
          side,
          inner,
          rows: cmdRows,
          link: isRunning ? undefined : "down",
          bar: false,
          scope: callScope,
        },
      );
      if (isRunning) return call;

      const o = (output ?? {}) as { stdout?: unknown; stderr?: unknown; backgroundTaskId?: string };
      const stdout = typeof o.stdout === "string" ? o.stdout : "";
      const lang = isBad || !stdout ? undefined : language(command, stdout);
      const glowed = lang
        ? glow.view(
            inner - 2,
            lang === "markdown" ? stdout : `\`\`\`${lang}\n${stdout.replace(/\n+$/, "")}\n\`\`\``,
          )
        : null;
      const errLines = (text: unknown): Run[][] =>
        typeof text === "string" && text ? plain(text).map((t) => [{ text: t, color: error_color }]) : [];
      // until glow has rendered, or with no language to give it, the output draws as plain text
      const source: Run[][] = glowed?.length
        ? [...(lang === "markdown" ? glowed : dedent(glowed)), ...errLines(o.stderr)]
        : outputLines(output).map((l) =>
            l.text ? [{ text: l.text, ...(l.isErr ? { color: error_color } : {}) }] : [],
          );
      const out = source.flatMap((runs) => (runs.length ? wrapRuns(runs, inner - 2) : [[]]));
      const outRows: [string, unknown][] = [
        ...visible("out", out).map((runs, i): [string, unknown] => [
          `out:${i}`,
          <Text hover={{ scope: outScope }}>
            {runs.length
              ? runs.map(({ text, color: c, ...style }, j) => (
                  <Text key={String(j)} {...style} {...(c ? paint(c, outScope) : quiet(outScope))}>
                    {text}
                  </Text>
                ))
              : " "}
          </Text>,
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
              color: isBad ? error_color : color,
              label: `${outputIcon}  ${isBad ? "error" : "output"} `,
              side,
              // two columns in, and two narrower, so its right edge stays under the call's
              inner: inner - 2,
              indent: 2,
              rows: outRows,
              link: "up",
              bar: false,
              scope: outScope,
            },
          )}
        </Box>
      );
    },
  );
};
