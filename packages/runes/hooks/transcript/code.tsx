import type { Elements } from "claude-code";

import { dropLead, type Run } from "./ansi";
import { DIVIDER, memo, palette, runLine } from "./bubble";
import { glow } from "./glow";
import { languageOf } from "./sniff";
import { cells, wrapRuns } from "./text";

// glow's margin and the code block's indent; glow wraps past its width, so it gets the longest line plus these
const GLOW_INDENT = 4;

// glow pads every line to its width, one escape per cell, so a minified line would cost megabytes; past this it draws plain
const GLOW_MAX_WIDTH = 400;

const remember = memo();
// keyed by glow's own output, so an aligned render lives exactly as long as glow keeps the one it came from
const aligned = new WeakMap<Run[][], Run[][] | null>();

// glow drops a fence's blank first and last lines, so they are counted back; any other mismatch draws plain.
// `key` names the lines, so the fence is built once and not on every draw
export const highlight = (
  key: string,
  codes: string[],
  lang: string,
): Run[][] | null => {
  const fence = remember(`fence\0${key}`, () => {
    const first = codes.findIndex((c) => c.trim());
    const width = Math.max(0, ...codes.map(cells)) + GLOW_INDENT;
    if (first === -1 || width > GLOW_MAX_WIDTH) return null;
    const last = codes.findLastIndex((c) => c.trim());
    return {
      first,
      last,
      width,
      text: `\`\`\`${lang}\n${codes.join("\n")}\n\`\`\``,
    };
  });
  if (!fence) return null;
  const glowed = glow.view(fence.width, fence.text);
  if (!glowed) return null;
  if (!aligned.has(glowed)) {
    const { first, last } = fence;
    aligned.set(
      glowed,
      first + glowed.length + (codes.length - 1 - last) === codes.length
        ? [
            ...codes.slice(0, first).map(() => []),
            ...glowed.map((runs) => dropLead(runs, GLOW_INDENT - 2)),
            ...codes.slice(last + 1).map(() => []),
          ]
        : null,
    );
  }
  return aligned.get(glowed)!;
};

// a file's text as numbered rows from `start` under a divider, coloured by glow when its language is known
export const codeRows = (
  Text: Elements["terminal"]["Text"],
  {
    id,
    content,
    start,
    path,
    inner,
  }: {
    id: string;
    content: string;
    start: number;
    path: string;
    inner: number;
  },
): [string, unknown][] => {
  const { text: TEXT, dim: DIM } = palette();
  const codes = remember(`codes\0${id}\0${content.length}`, () =>
    content
      .replace(/\n$/, "")
      .split("\n")
      .map((l) => l.replaceAll("\t", "    ")),
  );
  const lang = languageOf(path);
  const colored = lang
    ? highlight(`${id}\0${codes.length}`, codes, lang)
    : null;
  const gutter = String(start + codes.length - 1).length;
  const rows = remember(
    `rows\0${id}\0${inner}\0${DIM}\0${codes.length}\0${colored ? "glow" : "plain"}`,
    () =>
      codes.flatMap((code, i) =>
        wrapRuns(
          [
            { text: `${String(start + i).padStart(gutter)}  `, color: DIM },
            ...(colored?.[i] ?? (code ? [{ text: code }] : [])),
          ],
          inner,
          { text: " ".repeat(gutter + 2) },
        ),
      ),
  );
  return [
    ["code:divider", DIVIDER],
    ...rows.map((runs, i): [string, unknown] => [
      `line:${i}`,
      runLine(Text, runs, ({ text: _, color: c, ...style }) => ({
        ...style,
        color: c ?? TEXT,
      })),
    ]),
  ];
};
