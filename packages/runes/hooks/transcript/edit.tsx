import type { On } from "claude-code";

import { config } from "../config";
import { type Run } from "./ansi";
import {
  bubble,
  DIVIDER,
  errorRows,
  foldRows,
  hideResult,
  isLight,
  memo,
  palette,
  runLine,
  stateOf,
} from "./bubble";
import { codeRows, highlight } from "./code";
import { languageOf } from "./sniff";
import { cells, innerWidth, wrapRuns } from "./text";
import { shortPath } from "./where";

type Hunk = { oldStart: number; newStart: number; lines: string[] };
type Line = { sign: " " | "+" | "-"; n: number; code: string };

// move these into config.yaml if anyone wants to retheme
const DIFF = {
  dark: { add: "#b5bd68", del: "#cc6666", addBg: "#1e2b1e", delBg: "#331c1e" },
  light: { add: "#718c00", del: "#c82829", addBg: "#e6f2d8", delBg: "#f8e1e1" },
};

// a removed line takes its old number, every other line its new one; null splits two hunks
const linesOf = (hunks: Hunk[]): (Line | null)[] =>
  hunks.flatMap((h, i) => {
    let old = h.oldStart;
    let now = h.newStart;
    const out: (Line | null)[] = i ? [null] : [];
    for (const l of h.lines) {
      const sign = l[0];
      // "\ No newline at end of file" is not a line of the file
      if (sign !== " " && sign !== "+" && sign !== "-") continue;
      out.push({
        sign,
        n: sign === "-" ? old : now,
        code: l.slice(1).replaceAll("\t", "    "),
      });
      if (sign !== "+") old++;
      if (sign !== "-") now++;
    }
    return out;
  });

const remember = memo();

// a hunk's lines read once per call, with what the header and the gutter need from them
const diffOf = (hunks: Hunk[]) => {
  const lines = linesOf(hunks);
  let adds = 0;
  let dels = 0;
  let top = 0;
  for (const l of lines) {
    if (!l) continue;
    if (l.sign === "+") adds++;
    if (l.sign === "-") dels++;
    top = Math.max(top, l.n);
  }
  return {
    lines,
    codes: lines.flatMap((l) => (l ? [l.code] : [])),
    adds,
    dels,
    gutter: String(top).length,
  };
};

export const edit = (on: On) => {
  // module state, so a hot reload folds every card again
  const open = new Set<string>();

  // a Write that replaces a file sends hunks too, so it draws the same diff in its own rune's look
  for (const [tool, rune] of [
    ["Edit", "edit"],
    ["Write", "write"],
  ] as const) {
    hideResult(on, tool, rune);
    on("ui.render", { component: "ToolUse", props: { tool } }, ($, e, next) => {
      if (!config.enabled.transcript || !config.enabled[rune]) return next(e);
      const {
        color,
        error_color,
        icon,
        side,
        fold_lines: foldLines,
      } = config[rune];
      const { Box, Text, Button } = $.ui.resolve(e);
      const { isRunning, isErrored, isInterrupted, output } = e.props;
      const { file_path = "" } = (e.props.input ?? {}) as {
        file_path?: string;
      };
      const id = e.requestId;
      const inner = innerWidth(e.viewport?.columns);
      const isBad = isErrored || isInterrupted;
      const flip = (key: string) => () => {
        open.has(key) ? open.delete(key) : open.add(key);
        $.ui.invalidate("ui.render");
      };
      const card = (title: string, glyph: string, rows: [string, unknown][]) =>
        bubble(
          { Box, Text },
          {
            key: rune,
            color: isBad ? error_color : color,
            icon: glyph,
            title,
            side,
            inner,
            rows,
            bar: false,
          },
        );
      const path = shortPath(file_path);
      const state = stateOf(e.props);
      if (typeof output === "string")
        return card(
          `${path}${state}`,
          icon,
          errorRows(Text, output, inner, error_color),
        );

      const o = (output ?? {}) as {
        type?: "create" | "update";
        content?: string;
        structuredPatch?: Hunk[];
      };
      // a Write that creates a file sends no hunks and has nothing to compare, so it shows its head like a folded diff
      if (o.type === "create" && !o.structuredPatch?.length) {
        const content = o.content ?? "";
        if (!content)
          return card(`${path} · new`, icon, [
            ["empty", <Text color={palette().dim}>(empty file)</Text>],
          ]);
        // codeRows opens with a divider a card's first row does not need
        const rows = codeRows(Text, {
          id,
          content,
          start: 1,
          path: file_path,
          inner,
        }).slice(1);
        const key = `${id}:diff`;
        const isLong = rows.length > foldLines;
        return card(`${path} · new`, icon, [
          ...(isLong && !open.has(key) ? rows.slice(0, foldLines) : rows),
          ...(isLong
            ? foldRows(Button, {
                key: "diff",
                isOpen: open.has(key),
                hidden: rows.length - foldLines,
                width: inner,
                onPress: flip(key),
              })
            : []),
        ]);
      }

      const hunks = o.structuredPatch ?? [];
      const size = hunks.reduce((n, h) => n + h.lines.length, 0);
      const { lines, codes, adds, dels, gutter } = remember(
        `diff\0${id}\0${size}`,
        () => diffOf(hunks),
      );
      const lang = languageOf(file_path);
      const colored =
        lang && !isBad
          ? highlight(`${id}\0${codes.length}`, codes, lang)
          : null;
      const theme = isLight() ? "light" : "dark";
      const { text: TEXT, dim: DIM } = palette();
      const diff = DIFF[theme];

      // the line count rides in the key, so a card drawn plain before glow lands is drawn again
      const rows = remember(
        `rows\0${id}\0${inner}\0${theme}\0${size}\0${colored ? "glow" : "plain"}`,
        () => {
          let at = 0;
          return lines.flatMap((l): (Run[] | null)[] => {
            if (!l) return [null];
            const bg =
              l.sign === "+"
                ? diff.addBg
                : l.sign === "-"
                  ? diff.delBg
                  : undefined;
            const fill = bg ? { backgroundColor: bg } : {};
            const code = colored?.[at++] ?? (l.code ? [{ text: l.code }] : []);
            const head: Run = {
              text: `${String(l.n).padStart(gutter)} ${l.sign} `,
              color:
                l.sign === "+" ? diff.add : l.sign === "-" ? diff.del : DIM,
              ...fill,
            };
            const runs = [
              head,
              ...code.map(({ backgroundColor: _, ...r }) => ({
                ...r,
                ...fill,
              })),
            ];
            return wrapRuns(runs, inner, {
              text: " ".repeat(gutter + 3),
              ...fill,
            }).map((w) => {
              const room = inner - w.reduce((n, r) => n + cells(r.text), 0);
              return bg && room > 0
                ? [...w, { text: " ".repeat(room), ...fill }]
                : w;
            });
          });
        },
      );

      const counts = [adds && `+${adds}`, dels && `−${dels}`]
        .filter(Boolean)
        .join(" ");
      // a plus would read as a new file, so a Write over an existing one takes its own glyph
      const glyph = rune === "write" ? config.write.replace_icon : icon;
      const key = `${id}:diff`;
      const isLong = rows.length > foldLines;
      // sliced before drawing, so a folded diff builds only the rows it shows
      const shown = isLong && !open.has(key) ? rows.slice(0, foldLines) : rows;
      return card(`${path}${counts ? `  ${counts}` : ""}${state}`, glyph, [
        ...shown.map((runs, i): [string, unknown] =>
          runs === null
            ? [`hunk:${i}`, DIVIDER]
            : [
                `diff:${i}`,
                runLine(Text, runs, ({ text: _, color: c, ...style }) => ({
                  ...style,
                  color: c ?? TEXT,
                })),
              ],
        ),
        ...(isLong
          ? foldRows(Button, {
              key: "diff",
              isOpen: open.has(key),
              hidden: rows.length - foldLines,
              width: inner,
              onPress: flip(key),
            })
          : []),
        ...(!isRunning && output !== undefined && !rows.length
          ? [
              ["empty", <Text color={DIM}>(no changes)</Text>] as [
                string,
                unknown,
              ],
            ]
          : []),
      ]);
    });
  }
};
