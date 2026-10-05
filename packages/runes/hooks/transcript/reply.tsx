import type { On } from "claude-code";

import { config } from "../config";
import { noteRow } from "../minimap/minimap";
import type { Run } from "./ansi";
import { glow, INSTALL_HINT } from "./glow";
import { bubble, runLine } from "./bubble";
import { innerWidth, wrap } from "./text";

export const reply = (on: On) => {
  on("ui.render", { component: "AssistantMessage", surface: "terminal" }, async ($, e, next) => {
    noteRow(e.requestId, Boolean(e.props.onScreen));
    if (!config.enabled.transcript || !config.enabled.reply) return next(e);
    // run the chain anyway so plugins beneath still see the row; its tree is discarded
    await next(e);
    const { color, icon, side } = config.reply;
    const inner = innerWidth(e.viewport?.columns);
    const rendered = glow.view(inner, e.props.text, e.requestId);
    if (glow.hintDue()) $.ui.toast(INSTALL_HINT);
    // without glow the raw markdown still gets the bubble, wrapped by cell width
    const lines: Run[][] = rendered?.length
      ? rendered
      : wrap(e.props.text, inner).map((l) => (l ? [{ text: l }] : []));
    const { Box, Text, Button } = $.ui.resolve(e);
    // the bubble's borders ride along with a mouse selection, so the raw markdown opens where it selects clean
    const openRaw = async () => {
      const script = `${$.plugin.root}/hooks/transcript/open-raw.ts`;
      const { exitCode, stderr } = await $.process.run(["bun", script, e.requestId], {
        stdin: e.props.text,
      });
      if (exitCode !== 0) $.ui.toast(stderr.trim() || "could not open the raw reply");
    };
    return bubble(
      { Box, Text, Button },
      {
        key: "reply",
        action: { key: "reply:raw", label: " ⧉ raw ", onPress: openRaw },
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
