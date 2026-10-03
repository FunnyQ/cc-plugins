import type { Elements } from "claude-code";

import type { Side } from "../config";
import { hex } from "./ansi";
import { cells } from "./text";

type BubbleProps = {
  color: string;
  // the icon with its trailing padding: a glyph drawn wider than its cell covers the space after it
  label: string;
  // where the bar and the icon sit
  side: Side;
  inner: number;
  rows: [key: string, child: unknown][];
  key: string;
  // down: a tee on the bottom edge hands a line to the card drawn next; up: this card takes that line in.
  // `at` is the link's column from an unindented card's left edge, so both cards of a pair share one number
  link?: { to: "down" | "up"; at: number };
  // false draws the bar's column blank, so the frame still lines up with the other bubbles
  bar?: boolean;
  // columns the card sits in
  indent?: number;
  // a hover group: every edge rests muted and lights to `color` while the pointer is on any of it
  scope?: string;
};

const SATURATION = 0.5;
const BRIGHTNESS = 0.75;
// one entry per colour drawn: the configured ones, the shell palette and glow's
const muted = new Map<string, string>();

// pulls each channel halfway to the colour's grey, then dims it, so the hue stays at lower saturation and brightness
export const mute = (color: string) => {
  const known = muted.get(color);
  if (known) return known;
  const rgb = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  const [r = 0, g = 0, b = 0] = rgb;
  const grey = 0.299 * r + 0.587 * g + 0.114 * b;
  const out = hex(
    ...rgb.map((c) => Math.round((c + (grey - c) * SATURATION) * BRIGHTNESS)),
  );
  muted.set(color, out);
  return out;
};

// a row that draws a rule across the card, joined to its side borders
export const DIVIDER = Symbol("divider");

// the Text props for a colour that rests muted and lights up while its hover group is under the pointer
export const paint = (color: string, scope?: string) =>
  scope ? { color: mute(color), hover: { color, scope } } : { color };

export const foldLabel = (isOpen: boolean, hidden: number) =>
  isOpen ? "▾ fold" : `▸ ${hidden} more lines`;

// one row of styled runs; an empty one draws a space so the row keeps its height
export const runLine = <R extends { text: string }>(
  Text: Elements["terminal"]["Text"],
  runs: R[],
  styleOf: (run: R) => object = ({ text: _, ...style }) => style,
  outer: object = {},
) => (
  <Text {...outer}>
    {runs.length
      ? runs.map((run, j) => (
          <Text key={String(j)} {...styleOf(run)}>
            {run.text}
          </Text>
        ))
      : " "}
  </Text>
);

// every bubble shares this frame; every edge is drawn by hand, since Box borders refuse single sides and hid an absolute label
export const bubble = (
  { Box, Text }: Pick<Elements["terminal"], "Box" | "Text">,
  {
    color,
    label,
    side,
    inner,
    rows,
    key,
    link,
    bar = true,
    indent = 0,
    scope,
  }: BubbleProps,
) => {
  const ink = paint(color, scope);
  const mid = link ? link.at - indent : -1;
  // what the header's rule fills: the frame less its corners, the label and its padding
  const fill = inner - cells(label);
  // a rule starting at column `from` takes the link's ┴ when the middle falls inside it
  const rule = (from: number) => {
    const line = [..."─".repeat(Math.max(0, fill))];
    if (link?.to === "up" && mid >= from && mid < from + line.length)
      line[mid - from] = "┴";
    return <Text {...ink}>{line.join("")}</Text>;
  };
  const header =
    side === "left" ? (
      <Box flexDirection="row">
        <Text {...ink}>{"╭─ "}</Text>
        <Text bold {...ink}>
          {label}
        </Text>
        {rule(3 + cells(label))}
        <Text {...ink}>{"╮"}</Text>
      </Box>
    ) : (
      <Box flexDirection="row">
        <Text {...ink}>{"╭"}</Text>
        {rule(1)}
        <Text bold {...ink}>
          {` ${label}`}
        </Text>
        <Text {...ink}>{"─╮"}</Text>
      </Box>
    );
  const frame = (
    <Box
      flexDirection="column"
      flexGrow={1}
      marginLeft={side === "left" ? 1 : 0}
    >
      {header}
      {/* each row is one terminal line, so the side borders are one glyph tall */}
      {rows.map(([k, child]) =>
        child === DIVIDER ? (
          <Box key={k} flexDirection="row">
            <Text {...ink}>{`├${"─".repeat(inner + 2)}┤`}</Text>
          </Box>
        ) : (
          <Box key={k} flexDirection="row">
            <Text {...ink}>{"│ "}</Text>
            <Box width={inner}>{child as never}</Box>
            <Text {...ink}>{" │"}</Text>
          </Box>
        ),
      )}
      <Box flexDirection="row">
        <Text {...ink}>
          {link?.to === "down"
            ? `╰${"─".repeat(mid - 1)}┬${"─".repeat(inner + 2 - mid)}╯`
            : `╰${"─".repeat(inner + 2)}╯`}
        </Text>
      </Box>
    </Box>
  );
  // an empty Box stretches to its row's height, so the bar follows the bubble
  const strip = (
    <Box
      width={1}
      flexShrink={0}
      marginLeft={side === "right" ? 1 : 0}
      backgroundColor={bar ? color : undefined}
    />
  );
  return (
    <Box
      key={key}
      flexDirection="row"
      marginTop={link?.to === "up" ? 0 : 1}
      marginLeft={indent}
      // a hover group lights over the Box's whole area, so a hovering card must not stretch past its frame
      {...(scope ? { alignSelf: "flex-start" as const } : {})}
    >
      {side === "left" ? strip : null}
      {frame}
      {side === "right" ? strip : null}
    </Box>
  );
};
