import { atom, read, update } from "claude-code";
import type { EngineInterface, On } from "claude-code";

import { config } from "../config";
import { lines, type Row, stem } from "./rows";

export const PANE = "minimap";
// the dock refuses to go narrower than 24 columns, so ask for exactly that
const COLUMNS = 24;
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

export const minimap = (on: On) => {
  on("command.run", { command: "minimap" }, async ($, e) => {
    const arg = e.args.trim();
    if (arg === "off") {
      ticker?.cancel();
      await $.ui.close({ id: PANE });
      return { text: "Minimap closed." };
    }
    if (!config.enabled.minimap)
      return { text: "The minimap rune is off: /runes minimap on" };
    // `/minimap 30` asks for that many columns; a width dragged by hand still wins
    const columns = /^\d+$/.test(arg) ? Number(arg) : COLUMNS;
    await $.ui.open({ id: PANE, title: "Map", columns, focus: true });
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
    // the track takes one cell and one more is margin; the bar gets the rest of the pane
    const bar = Math.max(4, (e.props.bodyColumns ?? COLUMNS) - 2);
    const height = e.props.scroll?.bodyRows ?? (e.viewport?.rows ?? 24) - 4;
    const drawn = lines(list, here, height, bar);
    lastLine = `line:${drawn.length - 1}`;
    return (
      <Box flexDirection="column">
        {drawn.map((line, i) => (
          <Box flexDirection="row">
            <Button
              key={`line:${i}`}
              plain
              dimColor={!line.isHere}
              label={line.isHere ? "█" : "│"}
              onPress={() =>
                void $.ui.scroll({
                  to: { requestId: line.target },
                  block: "start",
                })
              }
            />
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
