import type { On } from "claude-code";

import { enabled } from "../switch";
import type { Run } from "./ansi";
import { glow, INSTALL_HINT } from "./glow";
import { cells, innerWidth, wrap } from "./text";

const CLAUDE = "#d97757";
// nf-cod icon U+EC82, needs a Nerd Font
const ICON = "";

export const reply = (on: On) => {
  on("ui.render", { component: "AssistantMessage" }, ($, e, next) => {
    if (enabled.transcript === false) return next(e);
    const inner = innerWidth(e.viewport?.columns);
    const rendered = glow.view(inner, e.props.text, e.requestId);
    if (glow.hintDue()) $.ui.toast(INSTALL_HINT);
    // without glow the raw markdown still gets the bubble, wrapped by cell width
    const lines: Run[][] = rendered?.length
      ? rendered
      : wrap(e.props.text, inner).map((l) => (l ? [{ text: l }] : []));
    const { Box, Text } = $.ui.resolve(e);

    // the glyph draws wider than its one cell and covers the space after it, so it gets two
    const label = `${ICON}  `;
    const rule = (n: number) => (
      <Text color={CLAUDE}>{"─".repeat(Math.max(0, n))}</Text>
    );

    return (
      <Box key="reply" flexDirection="row" marginTop={1}>
        {/* an empty Box stretches to its row's height, so the bar follows the bubble */}
        <Box width={1} flexShrink={0} backgroundColor={CLAUDE} />
        <Box flexDirection="column" flexGrow={1} marginLeft={1}>
          <Box flexDirection="row">
            <Text color={CLAUDE}>{"╭─ "}</Text>
            <Text bold color={CLAUDE}>
              {label}
            </Text>
            {rule(inner + 4 - 3 - cells(label) - 1)}
            <Text color={CLAUDE}>{"╮"}</Text>
          </Box>
          {lines.map((runs, i) => (
            <Box key={`line:${i}`} flexDirection="row">
              <Text color={CLAUDE}>{"│ "}</Text>
              <Box width={inner}>
                <Text>
                  {runs.length
                    ? runs.map(({ text, ...style }, j) => (
                        <Text key={String(j)} {...style}>
                          {text}
                        </Text>
                      ))
                    : " "}
                </Text>
              </Box>
              <Text color={CLAUDE}>{" │"}</Text>
            </Box>
          ))}
          <Box flexDirection="row">
            <Text color={CLAUDE}>{"╰"}</Text>
            {rule(inner + 2)}
            <Text color={CLAUDE}>{"╯"}</Text>
          </Box>
        </Box>
      </Box>
    );
  });
};
