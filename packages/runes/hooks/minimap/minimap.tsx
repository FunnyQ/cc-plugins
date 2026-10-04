import { atom, update } from "claude-code";
import type { EngineInterface, On } from "claude-code";

import { config } from "../config";
import { kindAt, lines, type Row } from "./rows";

// polls for on-screen changes every TICK ms and re-reads the transcript every REREAD ticks, while the rune is on
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

// one column per bucket, `barRows` blocks tall, the track along the bottom as a line into an arrowhead, drawn mid-cell like `→` so they join; drawn in Clawd's band
export const inlineMap = (
  { Box, Text, Button }: ReturnType<EngineInterface["ui"]["resolve"]>,
  list: Row[],
  here: Set<string>,
  width: number,
  barRows: number,
  jump: (target: string) => () => void,
) => {
  const drawn = lines(list, here, Math.max(1, width - 1), barRows);
  // drawn top down, so the earliest cell (0) lands on the bottom row and a bar reads upward in time
  const strip = Array.from({ length: barRows }, (_, i) => barRows - 1 - i);
  const node = (
    <Box flexDirection="column">
      {strip.map((cell) => (
        <Box flexDirection="row">
          {drawn.map((line) => {
            const kind = kindAt(line, cell);
            return kind ? (
              <Text color={colorOf(kind)}>
                {line.isHere || cell < barRows - 1 ? "█" : "▆"}
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
            <Text color={config.minimap.marker_color}>━</Text>
          ) : (
            <Button
              key={`line:${i}`}
              plain
              dimColor
              label="─"
              onPress={jump(line.target)}
            />
          ),
        )}
        <Text dimColor>→</Text>
      </Box>
    </Box>
  );
  return { node, count: drawn.length };
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
    if (config.enabled.minimap) void reread($).catch(() => {});
  });
};

export const minimap = (on: On) => {
  // Clawd's band draws the map, so the transcript is read from the session's start
  on("session.start", { isInteractive: true }, async ($, e, next) => {
    startTicker($);
    return next(e);
  });
};
