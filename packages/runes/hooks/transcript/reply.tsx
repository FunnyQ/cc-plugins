import type { On } from "claude-code";

import { config } from "../config";
import type { Run } from "./ansi";
import { glow, INSTALL_HINT } from "./glow";
import { bubble, runLine } from "./bubble";
import { innerWidth, wrap } from "./text";

export const reply = (on: On) => {
  on("ui.render", { component: "AssistantMessage" }, ($, e, next) => {
    if (!config.enabled.transcript || !config.enabled.reply) return next(e);
    const { color, icon, side } = config.reply;
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
        color,
        icon,
        side,
        inner,
        rows: lines.map((runs, i) => [
          `line:${i}`,
          runLine(Text, runs),
        ]),
      },
    );
  });
};
