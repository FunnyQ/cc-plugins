import type { Elements } from "claude-code";

import { cells } from "./text";

export type BubbleProps = {
  color: string;
  // the icon with its trailing padding: a glyph drawn wider than its cell covers the space after it
  label: string;
  // where the bar and the icon sit
  side: "left" | "right";
  inner: number;
  rows: [key: string, child: unknown][];
  key: string;
  // down: a tee on the bottom edge hands a line to the card drawn next; up: this card takes that line in
  link?: "down" | "up";
  // false draws the bar's column blank, so the frame still lines up with the other bubbles
  bar?: boolean;
  // columns the card sits in; the link column stays where an unindented card of the same total width has it
  indent?: number;
  // a hover group: every edge rests at half saturation and lights to `color` while the pointer is on any of it
  scope?: string;
};

// pulls each channel halfway to the colour's grey, then dims it, so the hue stays at lower saturation and brightness
export const mute = (hex: string, amount = 0.5, light = 0.75) => {
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [r = 0, g = 0, b = 0] = rgb;
  const grey = 0.299 * r + 0.587 * g + 0.114 * b;
  return `#${rgb
    .map((c) =>
      Math.round((c + (grey - c) * amount) * light)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
};

// a row that draws a rule across the card, joined to its side borders
export const DIVIDER = Symbol("divider");

// the Text props for a colour that rests muted and lights up while its hover group is under the pointer
export const paint = (color: string, scope?: string) =>
  scope ? { color: mute(color), hover: { color, scope } } : { color };

// both bubbles share this frame; every edge is drawn by hand, since Box borders refuse single sides and hid an absolute label
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
  // the link runs through the middle column of the frame
  const mid = Math.floor((inner + indent + 4) / 2) - indent;
  // a rule starting at column `from` takes the link's ┴ when the middle falls inside it
  const rule = (n: number, from: number) => {
    const line = [..."─".repeat(Math.max(0, n))];
    if (link === "up" && mid >= from && mid < from + line.length)
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
        {rule(inner + 4 - 3 - cells(label) - 1, 3 + cells(label))}
        <Text {...ink}>{"╮"}</Text>
      </Box>
    ) : (
      <Box flexDirection="row">
        <Text {...ink}>{"╭"}</Text>
        {rule(inner + 4 - 1 - cells(` ${label}`) - 2, 1)}
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
          {link === "down"
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
      marginTop={link === "up" ? 0 : 1}
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
