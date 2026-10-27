import { read } from "claude-code";
import type { On } from "claude-code";

import type { ExplainEntry, ExplainView } from "../../types";
import type { Run } from "../transcript/ansi";
import { runLine } from "../transcript/bubble";
import { svg as clawdSvg } from "../clawd/encode";
import { glow } from "../transcript/glow";
import { wrap, wrapWords } from "../transcript/text";
import {
  explainClear,
  explainDelete,
  explainReopen,
  explainSelect,
  explainShowHistory,
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
const EMPTY = "Press [Explain plz!] under Clawd, or type below.";
const PENDING = "new explanation…";
const WRITING = "Writing the answer…";
const ASK_LABEL = "ASK · type below";
const NEW_LABEL = "NEW QUESTION · type below";
const ASK_HEADING = "Ask";
const NEW_HEADING = "New question";
const ASK_CAPTION = "Ask a follow-up, or name what to explain";
// raw colours, since no theme key names a card ground; tuned for the desktop's dark theme
const CARD = "#232120";
const CARD_HOVER = "#2f2c2a";
// ground, then accents, from each theme's own :root
const SWATCH: Record<string, string[]> = {
  "picture-book": ["#f3eee3", "#d97757", "#7da0b8", "#9bb08a"],
  blueprint: ["#0d3258", "#e8f1fa", "#ff8a68", "#8fd3ff"],
  "lab-notebook": ["#e6f0da", "#2d6a45", "#c0281c", "#1f2a23"],
  editorial: ["#fff1e5", "#262a33", "#b0201a", "#f2dfce"],
  "card-table": ["#1c3128", "#ebdfc0", "#b0802a", "#241a11"],
  "guide-map": ["#f5f1e4", "#8ed462", "#ffd23f", "#4fa6e3"],
};
const swatchSvg = ([ground, ...accents]: string[]) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 24"><rect width="40" height="24" rx="4" fill="${ground}"/>${accents
    .map((c, i) => `<circle cx="${10 + i * 10}" cy="12" r="4" fill="${c}"/>`)
    .join("")}</svg>`;
const BORDER_AND_PADDING = 4;
const FIELD_MAX_ROWS = 6;
const DESKTOP_FIELD_ROWS = 4;
const NOTE_LINES = 2;
const SPINNER_CELLS = 2;

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
  const rows = wrapWords([{ text: text.replace(/\s+/g, " ") }], width).map(
    (runs) =>
      runs
        .map((r) => r.text)
        .join("")
        .trimEnd(),
  );
  if (rows.length <= lines) return rows;
  const last = wrap(rows[lines - 1]!, width - 1)[0]!.trimEnd();
  return [...rows.slice(0, lines - 1), `${last}…`];
};

export const explainPane = (on: On) => {
  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e);
    const { Box, Text, Button, Input, Client } = ui;
    const isDesktop = e.surface === "desktop" && "Svg" in ui;
    const desk = <P extends object>(props: P) => (isDesktop ? props : {});
    const card = desk({ backgroundColor: CARD, paddingY: 1 });
    const width = e.props.bodyColumns ?? COLUMNS;
    const inner = Math.max(10, width - BORDER_AND_PADDING);
    const v = (await read($, VIEW)) as ExplainView;
    const selected = selectedOf(v);

    // glow answers null while it renders in the background, and its worker redraws when the lines land
    const markdown = (id: string, text: string) => {
      if (e.surface === "desktop" && "Markdown" in ui)
        return [<ui.Markdown key={`explain-md:${id}`} text={text} />];
      const lines: Run[][] =
        glow.view(inner, text, `explain:${id}`) ?? wrapWords([{ text }], inner);
      return lines.map((runs) => runLine(Text, runs));
    };

    const page = (entry: Html) => {
      const look = statusLook(entry);
      const status = (
        <Text>
          <Text
            color={look.color}
            dimColor={!look.color}
          >{`${look.glyph} `}</Text>
          <Text color={look.color} dimColor={!look.color}>
            {statusOf(entry)}
          </Text>
        </Text>
      );
      const swatch = isDesktop && entry.theme && SWATCH[entry.theme];
      const deleteButton = (
        <Button
          key={`explain-delete:${entry.id}`}
          label="delete"
          dimColor
          onPress={() => explainDelete($, entry.id)}
        />
      );
      return (
        <Box key="explain-page" flexDirection="column" marginTop={1}>
          {swatch ? (
            <Box gap={1} alignItems="center">
              <ui.Svg
                key={`explain-swatch:${entry.id}`}
                source={swatchSvg(swatch)}
                alt={`${entry.theme} theme`}
                width={40}
                height={24}
              />
              <Box flexDirection="column">
                {status}
                <Text size="caption" dimColor>
                  {entry.theme}
                </Text>
              </Box>
            </Box>
          ) : (
            status
          )}
          {entry.check !== "ok" && entry.check !== "fixed" && entry.note
            ? clip(entry.note, inner, NOTE_LINES).map((line) => (
                <Text dimColor>{line}</Text>
              ))
            : null}
          <Text dimColor wrap="truncate-middle">
            {entry.path}
          </Text>
          <Box marginTop={1} gap={2}>
            <Button
              key={`explain-open:${entry.id}`}
              label="open again"
              onPress={() => explainReopen($, entry.id)}
            />
            {isDesktop ? (
              <Box display="none" hover={{ display: "flex" }}>
                {deleteButton}
              </Box>
            ) : (
              deleteButton
            )}
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

    const status = v.isRunning
      ? { text: "explaining…", color: ACCENT, spins: true }
      : v.error
        ? { text: `✗ ${v.error}`, color: ERROR_COLOR, spins: false }
        : selected?.kind === "html" && selected.check === "pending"
          ? { text: "checking layout…", color: undefined, spins: true }
          : undefined;
    const banner = status ? (
      <Box
        key="explain-status"
        flexDirection="column"
        borderStyle="round"
        borderColor={status.color}
        borderDimColor={!status.color}
        paddingX={1}
      >
        {clip(
          status.text,
          inner - (status.spins ? SPINNER_CELLS : 0),
          NOTE_LINES,
        ).map((line, i) => (
          <Box key={`explain-status:${i}`}>
            {status.spins && i === 0 ? (
              <Client
                key="explain-spinner"
                module="../transcript/spinner.tsx"
                props={{ color: status.color ?? OK_COLOR }}
                width={SPINNER_CELLS}
              />
            ) : null}
            <Text color={status.color} dimColor={!status.color}>
              {line}
            </Text>
          </Box>
        ))}
      </Box>
    ) : null;

    const lineCount = (v.draft ?? "").split("\n").length;
    const field = (minRows: number) => (
      <Input
        key="explain-ask"
        placeholder="ask a follow-up, or name what to explain"
        value={v.draft ?? ""}
        rows={Math.min(Math.max(lineCount, minRows), FIELD_MAX_ROWS)}
        submitLabel="ask"
        onSubmit={() => undefined}
      />
    );

    const askBox = (label: string, heading: string, hasClawd: boolean) => (
      <Box
        key="explain-ask-box"
        flexDirection="column"
        borderStyle="round"
        borderDimColor
        paddingX={1}
        {...card}
      >
        {isDesktop ? (
          <Box key="explain-ask-head" gap={1} alignItems="center">
            {hasClawd ? (
              <ui.Svg
                key="explain-clawd"
                source={clawdSvg("living", 0)}
                alt="Clawd"
                width={60}
                height={48}
              />
            ) : null}
            <Box flexDirection="column">
              <Text size="heading" weight="semibold">
                {heading}
              </Text>
              <Text size="caption" dimColor>
                {ASK_CAPTION}
              </Text>
            </Box>
          </Box>
        ) : (
          <Text dimColor bold>
            {label}
          </Text>
        )}
        {field(isDesktop ? DESKTOP_FIELD_ROWS : 1)}
      </Box>
    );

    const tail = askBox(ASK_LABEL, ASK_HEADING, false);

    if (v.isAsking && !v.isRunning)
      return (
        <Box flexDirection="column" gap={1}>
          {banner}
          {askBox(NEW_LABEL, NEW_HEADING, true)}
          <Box justifyContent="flex-end">
            <Button
              key="explain-show-history"
              label="history"
              dimColor
              onPress={() => explainShowHistory($)}
            />
          </Box>
        </Box>
      );

    if (!selected && !v.isRunning)
      return (
        <Box flexDirection="column" gap={1}>
          {banner}
          <Box
            key="explain-answer"
            borderStyle="round"
            borderColor={ACCENT}
            paddingX={1}
            justifyContent="center"
            {...card}
          >
            <Text dimColor>{EMPTY}</Text>
          </Box>
          {askBox(ASK_LABEL, ASK_HEADING, true)}
        </Box>
      );

    // while a fork runs, the answer box belongs to the answer being written, not to the last one
    const current = v.isRunning ? undefined : selected;
    const u = current?.usage;
    return (
      <Box flexDirection="column" gap={1}>
        {banner}
        <Box
          key="explain-history"
          flexDirection="column"
          borderStyle="round"
          borderDimColor
          paddingX={1}
          {...card}
        >
          <Box justifyContent="space-between">
            <Text
              dimColor
              bold
              {...desk({ size: "caption" as const })}
            >{`HISTORY · ${v.entries.length + (v.isRunning ? 1 : 0)}`}</Text>
            <Button
              key="explain-clear"
              label="clear"
              dimColor
              onPress={() => explainClear($)}
            />
          </Box>
          {v.isRunning && (
            <Text key="explain-entry-new" color={ACCENT} bold>
              {wrap(`● ${PENDING}`, inner)[0]!}
            </Text>
          )}
          {v.entries.map((entry) => {
            const isSelected = entry.id === current?.id;
            const label = wrap(
              `${isSelected ? "●" : "○"} ${entry.title}`,
              inner,
            )[0]!;
            const row = (
              <Button
                key={`explain-entry:${entry.id}`}
                plain
                label={label}
                onPress={() => explainSelect($, entry.id)}
              >
                <Text
                  color={isSelected ? ACCENT : undefined}
                  bold={isSelected}
                  dimColor={!isSelected}
                >
                  {label}
                </Text>
              </Button>
            );
            return isDesktop ? (
              <Box
                key={`explain-row:${entry.id}`}
                paddingX={1}
                hover={{ backgroundColor: CARD_HOVER }}
              >
                {row}
              </Box>
            ) : (
              row
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
            {...card}
          >
            <Text bold color={ACCENT} {...desk({ size: "title" as const })}>
              {current?.title ?? PENDING}
            </Text>
            <Box flexDirection="column" marginTop={1}>
              {current ? body(current) : <Text dimColor>{WRITING}</Text>}
            </Box>
          </Box>
          {u && (
            <Box justifyContent="flex-end" paddingX={1}>
              <Text dimColor {...desk({ size: "caption" as const, tabular: true })}>
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
