import type { Elements } from "claude-code";

import type { Side } from "../config";
import { bubble, DIVIDER, memo, runLine } from "../transcript/bubble";
import { cells, wrapWords } from "../transcript/text";
import { octantsOf } from "../clawd/encode";
import { CLIPS } from "../clawd/frames";
import { changes, keyOf, teacher } from "./teacher";

export const TEACHER_COLOR = "#4f9a6a";
// nf-md U+F0890, needs a Nerd Font
export const TEACHER_ICON = "\u{F0890}";

type Run = { text: string; bold?: boolean; color?: string };

// the rewrite's wrapped lines, each word it changed bold in the teacher's colour; a lesson never changes, yet every
// redraw of its prompt re-ran the word diff
const linesMemo = memo(50);
const betterLines = (text: string, better: string, width: number) =>
  linesMemo(`${width}\0${keyOf(text)}\0${better}`, () =>
    wrapWords(
      changes(keyOf(text), better).map(({ text, isChanged }): Run => (isChanged ? { text, bold: true, color: TEACHER_COLOR } : { text })),
      width,
    ),
  );

// octant text needs no blit, so it draws in any terminal; a cell with a gap draws every pixel in one colour,
// so each puff sits alone in its 2x4 cell, clear of the body and the red tip, and the cream cigarette's cell is
// filled with body so it has no gap and keeps both colours
const EDITS: [number, number, string][] = [
  [8, 15, "#"],
  [9, 15, "#"],
  [11, 15, "#"],
  [9, 18, "w"],
  [8, 19, "w"],
  [6, 19, "H"],
  [5, 18, "H"],
  [3, 17, "w"],
  [1, 16, "w"],
  [2, 18, "H"],
];
const grid = [...CLIPS.smoking![23]!.grid.replace(/s/g, ".")];
for (const [row, col, c] of EDITS) grid[row * 20 + col] = c;
const SMOKER = octantsOf(grid.join(""));
const SMOKER_COLUMNS = 10;
// the bubble's tail sits in the blank left of Clawd's top row, which holds only smoke, so no line is spent on it
const [[blank, ...smoke] = [], ...body] = SMOKER;
const TALKER = [[{ text: "     \\".padEnd(blank?.text.length ?? 0), color: TEACHER_COLOR }, ...smoke], ...body];

// the rewrite under the prompt's own words, inside the prompt's bubble: Clawd says the title, cowsay style, and the
// rewrite sits at its right
export const lessonRows = (
  { Box, Text }: Pick<Elements["terminal"], "Box" | "Text">,
  text: string,
  better: string,
  inner: number,
): [string, unknown][] => {
  const title = teacher.title(text);
  const say = (key: string, line: string): [string, unknown] => [key, <Text color={TEACHER_COLOR}>{line}</Text>];
  const lines = betterLines(text, better, inner - SMOKER_COLUMNS - 1).map((line) => runLine(Text, line));
  const height = Math.max(lines.length, TALKER.length);
  return [
    ["teacher:divider", DIVIDER],
    say("teacher:top", `╭${"─".repeat(cells(title) + 2)}╮`),
    [
      "teacher:title",
      <Text color={TEACHER_COLOR}>
        {"│ "}
        <Text bold>{title}</Text>
        {" │"}
      </Text>,
    ],
    say("teacher:bottom", `╰${"─".repeat(cells(title) + 2)}╯`),
    ...Array.from({ length: height }, (_, j): [string, unknown] => [
      `teacher:${j}`,
      <Box flexDirection="row">
        {TALKER[j] ? runLine(Text, TALKER[j]) : <Text>{" ".repeat(SMOKER_COLUMNS)}</Text>}
        <Text> </Text>
        {lines[j] ?? <Text> </Text>}
      </Box>,
    ]),
  ];
};

// the rewrite as its own small bubble under the engine's prompt, for when the prompt rune is off
export const lessonBubble = (
  { Box, Text }: Pick<Elements["terminal"], "Box" | "Text">,
  text: string,
  better: string,
  inner: number,
  side: Side,
) =>
  bubble(
    { Box, Text },
    {
      key: "teacher",
      color: TEACHER_COLOR,
      icon: TEACHER_ICON,
      title: teacher.title(text),
      side,
      inner,
      rows: betterLines(text, better, inner).map((line, j): [string, unknown] => [`teacher:${j}`, runLine(Text, line)]),
    },
  );
