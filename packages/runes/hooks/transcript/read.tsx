import type { On } from "claude-code";

import { config } from "../config";
import { bubble, errorRows, foldSection, palette, stateOf } from "./bubble";
import { codeRows } from "./code";
import { innerWidth } from "./text";
import { shortPath } from "./where";

type Output =
  | {
      type: "text";
      file: {
        content?: string;
        numLines: number;
        startLine: number;
        totalLines: number;
        truncatedByTokenCap?: boolean;
      };
    }
  | {
      type: "image";
      file: {
        originalSize: number;
        dimensions?: { originalWidth?: number; originalHeight?: number };
      };
    }
  | { type: "pdf"; file: { originalSize: number } }
  | { type: "notebook"; file: { cells: unknown[] } };

const size = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

// what the read came to, in one line; a kind this does not know shows its name
const detail = (o: Output): string => {
  switch (o.type) {
    case "text": {
      const f = o.file;
      if (f.totalLines === 0) return "empty file";
      const end = f.startLine + Math.max(0, f.numLines - 1);
      return `lines ${f.startLine}–${end} of ${f.totalLines}${f.truncatedByTokenCap ? " · truncated" : ""}`;
    }
    case "image": {
      const d = o.file.dimensions;
      const dims =
        d?.originalWidth && d.originalHeight
          ? ` · ${d.originalWidth}×${d.originalHeight}`
          : "";
      return `image${dims} · ${size(o.file.originalSize)}`;
    }
    case "pdf":
      return `pdf · ${size(o.file.originalSize)}`;
    case "notebook":
      return `notebook · ${o.file.cells.length} cells`;
    default:
      return (o as { type: string }).type;
  }
};

export const read = (on: On) => {
  // module state, so a hot reload folds every card again
  const open = new Set<string>();

  on(
    "ui.render",
    { component: "ToolUse", props: { tool: "Read" } },
    ($, e, next) => {
      if (!config.enabled.transcript || !config.enabled.read) return next(e);
      const { color, error_color, icon, side } = config.read;
      const { Box, Text, Button } = $.ui.resolve(e);
      const { isRunning, isErrored, isInterrupted, output } = e.props;
      const { file_path = "" } = (e.props.input ?? {}) as {
        file_path?: string;
      };
      const id = e.requestId;
      const inner = innerWidth(e.viewport?.columns);
      const card = (rows: [string, unknown][]) =>
        bubble(
          { Box, Text },
          {
            key: "read",
            color: isErrored || isInterrupted ? error_color : color,
            icon,
            title: `${shortPath(file_path)}${stateOf(e.props)}`,
            side,
            inner,
            rows,
            bar: false,
          },
        );

      if (isRunning || output === undefined) return card([]);
      if (typeof output === "string")
        return card(errorRows(Text, output, inner, error_color));
      const o = output as Output;
      const content = o.type === "text" ? (o.file.content ?? "") : "";
      if (!content || o.type !== "text")
        return card([
          ["read:0", <Text color={palette().text}>{detail(o)}</Text>],
        ]);
      return card(
        foldSection(Button, {
          key: "read",
          label: detail(o),
          isOpen: open.has(id),
          width: inner,
          onPress: () => {
            open.has(id) ? open.delete(id) : open.add(id);
            $.ui.invalidate("ui.render");
          },
          body: () =>
            codeRows(Text, {
              id,
              content,
              start: o.file.startLine,
              path: file_path,
              inner,
            }),
        }),
      );
    },
  );
};
