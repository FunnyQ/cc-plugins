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
};

// both bubbles share this frame; every edge is drawn by hand, since Box borders refuse single sides and hid an absolute label
export const bubble = (
  { Box, Text }: Pick<Elements["terminal"], "Box" | "Text">,
  { color, label, side, inner, rows, key }: BubbleProps,
) => {
  const rule = (n: number) => (
    <Text color={color}>{"─".repeat(Math.max(0, n))}</Text>
  );
  const header =
    side === "left" ? (
      <Box flexDirection="row">
        <Text color={color}>{"╭─ "}</Text>
        <Text bold color={color}>
          {label}
        </Text>
        {rule(inner + 4 - 3 - cells(label) - 1)}
        <Text color={color}>{"╮"}</Text>
      </Box>
    ) : (
      <Box flexDirection="row">
        <Text color={color}>{"╭"}</Text>
        {rule(inner + 4 - 1 - cells(` ${label}`) - 2)}
        <Text bold color={color}>
          {` ${label}`}
        </Text>
        <Text color={color}>{"─╮"}</Text>
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
      {rows.map(([k, child]) => (
        <Box key={k} flexDirection="row">
          <Text color={color}>{"│ "}</Text>
          <Box width={inner}>{child as never}</Box>
          <Text color={color}>{" │"}</Text>
        </Box>
      ))}
      <Box flexDirection="row">
        <Text color={color}>{"╰"}</Text>
        {rule(inner + 2)}
        <Text color={color}>{"╯"}</Text>
      </Box>
    </Box>
  );
  // an empty Box stretches to its row's height, so the bar follows the bubble
  const bar = (
    <Box
      width={1}
      flexShrink={0}
      marginLeft={side === "right" ? 1 : 0}
      backgroundColor={color}
    />
  );
  return (
    <Box key={key} flexDirection="row" marginTop={1}>
      {side === "left" ? bar : null}
      {frame}
      {side === "right" ? bar : null}
    </Box>
  );
};
