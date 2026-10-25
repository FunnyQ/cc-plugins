import { read } from "claude-code";
import type { On } from "claude-code";

import type { ExplainEntry, ExplainView } from "../../types";
import type { Run } from "../transcript/ansi";
import { runLine } from "../transcript/bubble";
import { glow } from "../transcript/glow";
import { wrap, wrapWords } from "../transcript/text";
import {
  explainAsk,
  explainPick,
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
const EMPTY = 'Press "hey mate, explain please" under the minimap.';

export const kilo = (n: number) =>
  n < 1000 ? String(Math.round(n)) : `${(n / 1000).toFixed(1)}k`;

type Html = Extract<ExplainEntry, { kind: "html" }>;
export const statusOf = (e: Html) => {
  if (e.check === "pending") return "checking layout…";
  if (e.check === "ok") return "layout ok";
  if (e.check === "fixed")
    return `fixed ${e.note?.match(/^\d+/)?.[0] ?? ""}`.trimEnd();
  return e.note ? `not checked: ${e.note}` : "not checked";
};

export const explainPane = (on: On) => {
  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e);
    const width = e.props.bodyColumns ?? COLUMNS;
    const v = (await read($, VIEW)) as ExplainView;
    const selected = selectedOf(v);

    // glow answers null while it renders in the background, and its worker redraws when the lines land
    const markdown = (id: string, text: string) => {
      const lines: Run[][] =
        glow.view(width, text, `explain:${id}`) ?? wrapWords([{ text }], width);
      return lines.map((runs) => runLine(Text, runs));
    };

    const body = (entry: ExplainEntry) => {
      if (entry.kind === "text") return markdown(entry.id, entry.body);
      if (entry.kind === "ask")
        return [
          <Text>{entry.question}</Text>,
          ...entry.options.map((option, i) => (
            <Button
              key={`explain-pick:${entry.id}:${i}`}
              label={option}
              onPress={() => explainPick($, option)}
            />
          )),
        ];
      return [
        ...markdown(entry.id, entry.summary),
        <Text dimColor>{entry.path}</Text>,
        <Text dimColor>{statusOf(entry)}</Text>,
        <Button
          key={`explain-open:${entry.id}`}
          label="open again"
          onPress={() => explainReopen($, entry.id)}
        />,
      ];
    };

    const tail = [
      v.error ? <Text color={ERROR_COLOR}>{v.error}</Text> : null,
      v.isRunning ? <Text dimColor>explaining…</Text> : null,
      <Input
        key="explain-ask"
        placeholder="ask a follow-up, or name what to explain"
        submitLabel="ask"
        onSubmit={(value: string) => {
          if (value.trim()) return explainAsk($, value);
        }}
      />,
    ];

    if (!selected)
      return (
        <Box flexDirection="column">
          <Text dimColor>{EMPTY}</Text>
          {tail}
        </Box>
      );

    const u = selected.usage;
    return (
      <Box flexDirection="column">
        {v.entries.map((entry) => (
          <Button
            key={`explain-entry:${entry.id}`}
            plain
            label={
              wrap(
                `${entry.id === selected.id ? "› " : "  "}${entry.title}`,
                width,
              )[0]!
            }
            onPress={() => explainSelect($, entry.id)}
          />
        ))}
        <Text dimColor>{"─".repeat(width)}</Text>
        {body(selected)}
        {u && (
          <Text dimColor>
            {`${kilo(u.input)} in · ${kilo(u.cacheRead)} cached · ${kilo(u.output)} out`}
          </Text>
        )}
        {tail}
      </Box>
    );
  });
};
