import { atom, read, update } from "claude-code";
import type { EngineInterface, On } from "claude-code";

import { config } from "../config";
import { kindAt, lines, type Row, stem } from "./rows";

export const PANE = "minimap";
// the dock refuses to go narrower than 24 columns, so ask for exactly that
const COLUMNS = 24;
// the inline map's bars are this many blocks tall, the track under them one more row
const BAR_ROWS = 3;
// polls for on-screen changes every TICK ms and re-reads the transcript every REREAD ticks, only while the pane is open
const TICK = 250;
const REREAD = 12;

const rows = atom({ plugin: "runes", key: "minimapRows" } as const, []);
const shown = atom({ plugin: "runes", key: "minimapShown" } as const, []);

// the prompt and reply bubbles report here as they draw; a render hook may not write state, so the ticker does
const onScreen = new Set<string>();
let isDirty = false;
export const noteRow = (id: string, isShown: boolean) => {
  if (onScreen.has(id) === isShown) return;
  if (isShown) onScreen.add(id);
  else onScreen.delete(id);
  isDirty = true;
};

// the focus ring wraps from the last line to the first; the pane tracks where it is to refuse that jump
let focused: string | undefined;
let lastLine = "line:0";
let ticker: { cancel: () => void } | undefined;

const COLOR: Record<string, () => string> = {
  prompt: () => config.prompt.color,
  reply: () => config.reply.color,
  bash: () => config.bash.color,
  read: () => config.read.color,
  edit: () => config.edit.color,
  write: () => config.write.color,
  agent: () => config.agent.color,
  skill: () => config.skill.color,
};
const colorOf = (kind: string) => COLOR[kind]?.() ?? "#808080";

// a bun child, because a transcript outgrows the mod's 4 MiB $.fs.read cap
const reread = async ($: EngineInterface) => {
  const { exitCode, stdout } = await $.process.run([
    "bun",
    `${$.plugin.root}/hooks/minimap/index.ts`,
    await $.session.id(),
  ]);
  if (exitCode === 0) await update($, rows, () => JSON.parse(stdout) as Row[]);
};

const startTicker = ($: EngineInterface) => {
  ticker?.cancel();
  let n = 0;
  ticker = $.clock.every(TICK, () => {
    if (isDirty) {
      isDirty = false;
      void update($, shown, () => [...onScreen]);
    }
    if (++n % REREAD) return;
    void $.ui.panes().then((panes) => {
      if (!panes.some((p) => p.id === PANE)) ticker?.cancel();
      else void reread($);
    });
  });
};

// the arguments of `/runes minimap` that open or close the pane; the rest stay with the switch
export const isMapArg = (arg?: string) =>
  arg === undefined || arg === "open" || arg === "close";

export const minimap = (on: On) => {
  // `/runes minimap` opens the pane or shuts it when open, `open 30` asks for that many columns, `close` shuts it
  on("command.run", { command: "runes" }, async ($, e, next) => {
    const [first, arg, width] = e.args.trim().split(/\s+/);
    if (first !== "minimap" || !isMapArg(arg)) return next(e);
    const isOpen = (await $.ui.panes()).some((p) => p.id === PANE);
    if (arg === "close" || (arg === undefined && isOpen)) {
      ticker?.cancel();
      await $.ui.close({ id: PANE });
      return { text: "Minimap closed." };
    }
    if (!config.enabled.minimap)
      return { text: "The minimap rune is off: /runes minimap on" };
    // a width dragged by hand still wins over the one asked for
    const columns = /^\d+$/.test(width ?? "") ? Number(width) : COLUMNS;
    // rows sizes the inline seat a narrow terminal gives it, where the map lies sideways above the prompt
    await $.ui.open({ id: PANE, title: "Map", columns, rows: 4, focus: true });
    await reread($);
    startTicker($);
    return { text: "Minimap opened." };
  });

  on("ui.focus", { component: "Pane", requestId: PANE }, async ($, e, next) => {
    const wraps =
      (focused === lastLine && e.element === "line:0") ||
      (focused === "line:0" && e.element === lastLine);
    if (wraps && lastLine !== "line:0")
      return { deny: "the minimap stops at its ends" };
    focused = e.element;
    return next(e);
  });

  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e);
    const list = await read($, rows);
    const here = new Set((await read($, shown)).map(stem));
    if (!list.length) return <Text dimColor>No messages yet.</Text>;
    const jump = (target: string) => () =>
      void $.ui.scroll({ to: { requestId: target }, block: "start" });
    const height = e.props.scroll?.bodyRows ?? (e.viewport?.rows ?? 24) - 4;
    const width = e.props.bodyColumns ?? COLUMNS;

    // inline (a narrow terminal seats it above the prompt, over Clawd): one column per bucket, the track along the bottom
    if (e.props.placement === "inline") {
      const drawn = lines(list, here, Math.max(1, width - 1), BAR_ROWS);
      lastLine = `line:${drawn.length - 1}`;
      const strip = Array.from({ length: BAR_ROWS }, (_, i) => i);
      return (
        <Box flexDirection="column">
          {strip.map((cell) => (
            <Box flexDirection="row">
              {drawn.map((line) => {
                const kind = kindAt(line, cell);
                return kind ? (
                  <Text color={colorOf(kind)}>
                    {line.isHere || cell > 0 ? "█" : "▆"}
                  </Text>
                ) : (
                  <Text> </Text>
                );
              })}
            </Box>
          ))}
          <Box flexDirection="row">
            {drawn.map((line, i) =>
              line.isHere ? (
                <Text color="#ff8c00">▂</Text>
              ) : (
                <Button
                  key={`line:${i}`}
                  plain
                  dimColor
                  label="_"
                  onPress={jump(line.target)}
                />
              ),
            )}
          </Box>
        </Box>
      );
    }

    // docked beside the transcript: one line per bucket, the track on the left and a one-cell margin on the right
    const drawn = lines(list, here, height, Math.max(4, width - 2));
    lastLine = `line:${drawn.length - 1}`;
    return (
      <Box flexDirection="column">
        {drawn.map((line, i) => (
          <Box flexDirection="row">
            {line.isHere ? (
              <Text color="#ff8c00">█</Text>
            ) : (
              <Button
                key={`line:${i}`}
                plain
                dimColor
                label="│"
                onPress={jump(line.target)}
              />
            )}
            {line.segments.map((s) => (
              <Text color={colorOf(s.kind)}>
                {(line.isHere ? "█" : "▆").repeat(s.cells)}
              </Text>
            ))}
          </Box>
        ))}
      </Box>
    );
  });
};
