import { read } from "claude-code";
import type { On } from "claude-code";

import type { ExplainEntry, ExplainView } from "../../types";
import type { Run } from "../transcript/ansi";
import { runLine } from "../transcript/bubble";
import { glow } from "../transcript/glow";
import { wrap, wrapWords } from "../transcript/text";
import {
  explainReopen,
  explainSelect,
  COLUMNS,
  PANE,
} from "./explain";
import { selectedOf } from "./state";

// the state scan needs the literal key in the file that reads the atom
const VIEW = { plugin: "runes", key: "explain" } as const;
// the dark-theme deletion red of the Edit card
const ERROR_COLOR = "#cc6666";
// Claude's orange, the colour Clawd is drawn in
const ACCENT = "#d97757";
const OK_COLOR = "#8fbf7f";
const WARN_COLOR = "#e0b060";
const EMPTY = "Press [Explain plz!] under Clawd.";
const BORDER_AND_PADDING = 4;
const NOTE_LINES = 2;

export const kilo = (n: number) =>
  n < 1000 ? String(Math.round(n)) : `${(n / 1000).toFixed(1)}k`;

type Html = Extract<ExplainEntry, { kind: "html" }>;
export const statusOf = (e: Html) => {
  if (e.check === "pending") return "checking layout…";
  if (e.check === "ok") return "layout ok";
  if (e.check === "fixed")
    return `fixed ${e.note?.match(/^\d+/)?.[0] ?? ""}`.trimEnd();
  return "not checked";
};
const statusLook = (e: Html) =>
  e.check === "pending"
    ? { glyph: "◌", color: undefined }
    : e.check === "ok" || e.check === "fixed"
      ? { glyph: "✓", color: OK_COLOR }
      : { glyph: "!", color: WARN_COLOR };

// Text in a bordered Box does not wrap to the border, so a note is wrapped here and cut at `lines`
const clip = (text: string, width: number, lines: number) => {
  const rows = wrapWords([{ text: text.replace(/\s+/g, " ") }], width).map((runs) =>
    runs.map((r) => r.text).join("").trimEnd(),
  );
  if (rows.length <= lines) return rows;
  const last = wrap(rows[lines - 1]!, width - 1)[0]!.trimEnd();
  return [...rows.slice(0, lines - 1), `${last}…`];
};

export const explainPane = (on: On) => {
  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e);
    const width = e.props.bodyColumns ?? COLUMNS;
    const inner = Math.max(10, width - BORDER_AND_PADDING);
    const v = (await read($, VIEW)) as ExplainView;
    const selected = selectedOf(v);

    // glow answers null while it renders in the background, and its worker redraws when the lines land
    const markdown = (id: string, text: string) => {
      const lines: Run[][] =
        glow.view(inner, text, `explain:${id}`) ?? wrapWords([{ text }], inner);
      return lines.map((runs) => runLine(Text, runs));
    };

    const page = (entry: Html) => {
      const look = statusLook(entry);
      return (
        <Box key="explain-page" flexDirection="column" marginTop={1}>
          <Text>
            <Text color={look.color} dimColor={!look.color}>{`${look.glyph} `}</Text>
            <Text color={look.color} dimColor={!look.color}>{statusOf(entry)}</Text>
          </Text>
          {entry.check !== "ok" && entry.check !== "fixed" && entry.note
            ? clip(entry.note, inner, NOTE_LINES).map((line) => <Text dimColor>{line}</Text>)
            : null}
          <Text dimColor wrap="truncate-middle">{entry.path}</Text>
          <Box marginTop={1}>
            <Button
              key={`explain-open:${entry.id}`}
              label="open again"
              onPress={() => explainReopen($, entry.id)}
            />
          </Box>
        </Box>
      );
    };

    const body = (entry: ExplainEntry) => {
      if (entry.kind === "text") return markdown(entry.id, entry.body);
      if (entry.kind === "ask")
        return [
          <Text bold>{entry.question}</Text>,
          <Box key="explain-picks" flexDirection="column" marginTop={1}>
            {entry.options.map((option, i) => (
              <Button
                key={`explain-pick:${entry.id}:${i}`}
                label={option}
                plain
                hotkey={String(i + 1)}
                onPress={() => undefined}
              />
            ))}
          </Box>,
        ];
      return [...markdown(entry.id, entry.summary), page(entry)];
    };

    const tail = [
      v.error ? (
        <Box key="explain-error" marginTop={1} paddingX={1}>
          <Text color={ERROR_COLOR}>{`✗ ${v.error}`}</Text>
        </Box>
      ) : null,
      v.isRunning ? (
        <Text key="explain-running" color={ACCENT}>
          explaining…
        </Text>
      ) : null,
      <Input
        key="explain-ask"
        placeholder="ask a follow-up, or name what to explain"
        submitLabel="ask"
        onSubmit={() => undefined}
      />,
    ];

    if (!selected)
      return (
        <Box flexDirection="column" gap={1}>
          <Box
            key="explain-answer"
            borderStyle="round"
            borderColor={ACCENT}
            paddingX={1}
            justifyContent="center"
          >
            <Text dimColor>{EMPTY}</Text>
          </Box>
          {tail}
        </Box>
      );

    const u = selected.usage;
    return (
      <Box flexDirection="column" gap={1}>
        <Box
          key="explain-history"
          flexDirection="column"
          borderStyle="round"
          borderDimColor
          paddingX={1}
        >
          <Text dimColor bold>{`HISTORY · ${v.entries.length}`}</Text>
          {v.entries.map((entry) => {
            const isSelected = entry.id === selected.id;
            const label = wrap(`${isSelected ? "●" : "○"} ${entry.title}`, inner)[0]!;
            return (
              <Button
                key={`explain-entry:${entry.id}`}
                plain
                label={label}
                onPress={() => explainSelect($, entry.id)}
              >
                <Text color={isSelected ? ACCENT : undefined} bold={isSelected} dimColor={!isSelected}>
                  {label}
                </Text>
              </Button>
            );
          })}
        </Box>
        <Box key="explain-selected" flexDirection="column">
          <Box
            key="explain-answer"
            flexDirection="column"
            borderStyle="round"
            borderColor={ACCENT}
            paddingX={1}
          >
            <Text bold color={ACCENT}>{selected.title}</Text>
            <Box flexDirection="column" marginTop={1}>
              {body(selected)}
            </Box>
          </Box>
          {u && (
            <Box justifyContent="flex-end" paddingX={1}>
              <Text dimColor>
                {`${kilo(u.input)} in · ${kilo(u.cacheRead)} cached · ${kilo(u.output)} out`}
              </Text>
            </Box>
          )}
        </Box>
        {tail}
      </Box>
    );
  });
};
