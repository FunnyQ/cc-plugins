import type { On } from "claude-code";

import { enabled } from "../switch";
import type { Run } from "./ansi";
import { glow, INSTALL_HINT } from "./glow";
import { bubble } from "./bubble";
import { innerWidth, wrap } from "./text";

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
    return bubble(
      { Box, Text },
      {
        key: "reply",
        color: CLAUDE,
        // the glyph draws wider than its one cell and covers the space after it, so it gets two
        label: `${ICON}  `,
        side: "left",
        inner,
        rows: lines.map((runs, i) => [
          `line:${i}`,
          <Text>
            {runs.length
              ? runs.map(({ text, ...style }, j) => (
                  <Text key={String(j)} {...style}>
                    {text}
                  </Text>
                ))
              : " "}
          </Text>,
        ]),
      },
    );
  });
};
