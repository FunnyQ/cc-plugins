import type { Elements } from "claude-code";

import type { Side } from "../config";
import {
  bubble,
  DIVIDER,
  isLight,
  memo,
  palette,
  runLine,
} from "../transcript/bubble";
import { cells, wrapWords } from "../transcript/text";
import { octantsOf, svgOf } from "../clawd/encode";
import { CLIPS } from "../clawd/frames";
import { changes, isFullRewrite, keyOf, teacher } from "./teacher";

export const TEACHER_COLOR = "#4f9a6a";
// raw greens, since no theme key names a tinted ground; tuned for the desktop's dark theme
const CARD_GROUND = "#17201a";
const REWRITE_GROUND = "#203026";
// nf-md U+F0890, needs a Nerd Font
export const TEACHER_ICON = "\u{F0890}";

type Run = { text: string; bold?: boolean; color?: string };

// a lesson never changes, yet every redraw of its prompt re-ran the word diff
const runsMemo = memo(50);
// the desktop wraps text itself, so it takes the rewrite as one line of runs
export const rewriteRuns = (
  text: string,
  better: string,
  fullColor?: string,
): Run[] => {
  const key = keyOf(text);
  return runsMemo(`${fullColor ?? ""}\0${key}\0${better}`, () =>
    isFullRewrite(key, better)
      ? [{ text: better, color: fullColor }]
      : changes(key, better).map(({ text, isChanged }): Run =>
          isChanged ? { text, bold: true, color: TEACHER_COLOR } : { text },
        ),
  );
};

const linesMemo = memo(50);
export const lessonLines = (
  text: string,
  better: string,
  why: string | undefined,
  width: number,
) =>
  linesMemo(
    `${width}\0${isLight()}\0${keyOf(text)}\0${better}\0${why ?? ""}`,
    (): Run[][] => [
      ...wrapWords(rewriteRuns(text, better, palette().var), width),
      ...(why
        ? [
            [{ text: "─".repeat(Math.max(width, 1)), color: palette().dim }],
            ...wrapWords([{ text: why, color: palette().dim }], width),
          ]
        : []),
    ],
  );

// the desktop's lesson under the prompt: a card in the teacher's colour, no octant smoker, since Text there is not a cell grid
export const lessonCard = (
  { Box, Text, Svg }: Pick<Elements["desktop"], "Box" | "Text" | "Svg">,
  text: string,
  better: string,
) => {
  const why = teacher.why(text);
  return (
    <Box
      key="teacher"
      flexDirection="row"
      gap={2}
      borderStyle="round"
      borderColor={TEACHER_COLOR}
      backgroundColor={CARD_GROUND}
      paddingX={2}
      paddingY={1}
      marginTop={1}
    >
      <Svg
        source={SMOKER_SVG}
        alt="Clawd the teacher, smoking"
        width={60}
        height={48}
      />
      <Box flexDirection="column" flexGrow={1} gap={1}>
        <Box flexDirection="column">
          <Text size="caption" weight="semibold" color={TEACHER_COLOR}>
            YOUR ENGLISH TEACHER
          </Text>
          <Text size="heading" weight="semibold" italic>
            {teacher.title(text)}
          </Text>
        </Box>
        <Box
          flexDirection="column"
          backgroundColor={REWRITE_GROUND}
          paddingX={1}
          paddingY={1}
        >
          <Text size="footnote" dimColor strikethrough>
            {text}
          </Text>
          <Text>
            {rewriteRuns(text, better).map((r) => (
              <Text bold={r.bold} color={r.color}>
                {r.text}
              </Text>
            ))}
          </Text>
        </Box>
        {why ? (
          <Text size="footnote" dimColor>
            {why}
          </Text>
        ) : null}
      </Box>
    </Box>
  );
};

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
const SMOKER_SVG = svgOf(grid.join(""));
const SMOKER_COLUMNS = 10;
const [[tailSlot, ...smoke] = [], ...body] = SMOKER;
const TALKER = [
  [
    {
      text: "     \\".padEnd(tailSlot?.text.length ?? 0),
      color: TEACHER_COLOR,
    },
    ...smoke,
  ],
  ...body,
];

export const lessonRows = (
  { Box, Text }: Pick<Elements["terminal"], "Box" | "Text">,
  text: string,
  better: string,
  inner: number,
): [string, unknown][] => {
  const title = teacher.title(text);
  const say = (key: string, line: string): [string, unknown] => [
    key,
    <Text color={TEACHER_COLOR}>{line}</Text>,
  ];
  const lines = lessonLines(
    text,
    better,
    teacher.why(text),
    inner - SMOKER_COLUMNS - 1,
  ).map((line) => runLine(Text, line));
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
        {TALKER[j] ? (
          runLine(Text, TALKER[j])
        ) : (
          <Text>{" ".repeat(SMOKER_COLUMNS)}</Text>
        )}
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
      rows: lessonLines(text, better, teacher.why(text), inner).map(
        (line, j): [string, unknown] => [`teacher:${j}`, runLine(Text, line)],
      ),
    },
  );
