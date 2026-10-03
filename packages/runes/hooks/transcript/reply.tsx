import type { On } from "claude-code";

import { enabled } from "../switch";
import type { Run } from "./ansi";
import { glow, glowArgv, toLines } from "./glow";
import { cells } from "./prompt";

const CLAUDE = "#d97757";
// nf-cod icon U+EC82, needs a Nerd Font
const ICON = "";
// what the bar, its margin, the transcript gutter and the side borders take from the viewport
const CHROME = 7;

export const reply = (on: On) => {
  on("ui.render", { component: "AssistantMessage" }, async ($, e, next) => {
    if (enabled.transcript === false || glow.missing) return next(e);
    const inner = Math.max(10, (e.viewport?.columns ?? 80) - CHROME);
    const key = `${inner}\0${e.props.text}`;
    if (!glow.rendered.has(key)) {
      let lines: Run[][] | null = null;
      try {
        const { exitCode, stdout } = await $.process.run(glowArgv(inner), {
          stdin: e.props.text,
        });
        if (exitCode === 0) lines = toLines(stdout);
      } catch {
        glow.missing = true;
      }
      glow.remember(key, lines);
    }
    const lines = glow.rendered.get(key);
    if (!lines?.length) return next(e);
    const { Box, Text } = $.ui.resolve(e);

    // the glyph draws wider than its one cell and covers the space after it, so it gets two
    const label = `${ICON}  `;
    const rule = (n: number) => (
      <Text color={CLAUDE}>{"─".repeat(Math.max(0, n))}</Text>
    );

    return (
      <Box key="reply" flexDirection="row" marginTop={1}>
        <Box flexDirection="column" flexGrow={1}>
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
        {/* an empty Box stretches to its row's height, so the bar follows the bubble */}
        <Box width={1} flexShrink={0} marginLeft={1} backgroundColor={CLAUDE} />
      </Box>
    );
  });
};
