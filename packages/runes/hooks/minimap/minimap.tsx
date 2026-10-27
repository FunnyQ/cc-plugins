import { atom, update } from "claude-code";
import type { EngineInterface, On } from "claude-code";

import { config } from "../config";
import type { Ui } from "../ui";
import { kindAt, lines, type Line, type Row } from "./rows";

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

export const COLOR: Record<string, () => string> = {
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

let transcript: string | undefined;
let lastSeen: string | undefined;
let lastRows = "";

// a bun child, because a transcript outgrows the mod's 4 MiB $.fs.read cap; true once the transcript has been read
const reread = async ($: EngineInterface) => {
  const { exitCode, stdout } = await $.process.run([
    "bun",
    `${$.plugin.root}/hooks/minimap/index.ts`,
    await $.session.id(),
  ]);
  if (exitCode !== 0) return false;
  const read = JSON.parse(stdout) as { path: string; rows: Row[] };
  transcript = read.path;
  if (stdout !== lastRows) {
    lastRows = stdout;
    await update($, rows, () => read.rows);
  }
  return true;
};

// a stat of the transcript is one file-system call; the spawn it spares is a process and up to 76 MB.
const rereadIfChanged = async ($: EngineInterface) => {
  const stat = transcript
    ? await $.fs.stat(transcript).catch(() => undefined)
    : undefined;
  const seen = stat && `${stat.size}:${stat.mtimeMs}`;
  if (seen !== undefined && seen === lastSeen) return;
  lastSeen = (await reread($)) ? seen : undefined;
};

// one column per bucket, `barRows` blocks tall, the track along the bottom as a line into an arrowhead, drawn mid-cell like `→` so they join; drawn in Clawd's band
export const inlineMap = (
  { Box, Text, Button }: Ui,
  list: Row[],
  here: Set<string>,
  width: number,
  barRows: number,
  jump: (target: string) => () => void,
) => {
  const drawn = lines(list, here, Math.max(1, width - 1), barRows);
  const cellsTopDown = Array.from(
    { length: barRows },
    (_, i) => barRows - 1 - i,
  );
  return (
    <Box flexDirection="column">
      {cellsTopDown.map((cell) => (
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
};

const BLOCK = 8;
// the desktop's blocks are smaller than a terminal cell, so it draws taller bars than bar_rows
const DESKTOP_BAR_ROWS = 5;
const GAP = 2;
const PITCH = BLOCK + GAP;
// the desktop's code-font advance, which its cells are counted in; a guess, but the Svg scales down to its slot, so a wide guess only shrinks the squares
const CELL_PX = 8;

// the desktop draws the map alone, no jump buttons: their native padding set every column's width
const mapSvg = (drawn: Line[], barRows: number) => {
  const height = barRows * BLOCK + GAP * 2;
  const rects = drawn.flatMap((line, x) => {
    let row = barRows;
    const blocks = line.segments.flatMap((s) =>
      Array.from({ length: s.cells }, () => {
        row -= 1;
        return `<rect x="${x * PITCH}" y="${row * BLOCK}" width="${BLOCK}" height="${BLOCK}" fill="${colorOf(s.kind)}"/>`;
      }),
    );
    return line.isHere
      ? [
          ...blocks,
          `<rect x="${x * PITCH}" y="${barRows * BLOCK + GAP}" width="${BLOCK}" height="${GAP}" fill="${config.minimap.marker_color}"/>`,
        ]
      : blocks;
  });
  const width = drawn.length * PITCH - GAP;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges">${rects.join("")}</svg>`;
};

// the slot shrinks and clips, so a guessed width too wide narrows the map rather than pushing Clawd and the buttons out
export const desktopMap = (
  { Box, Svg }: Ui,
  list: Row[],
  here: Set<string>,
  width: number,
) => {
  const drawn = lines(
    list,
    here,
    Math.max(1, Math.floor((width * CELL_PX) / PITCH)),
    DESKTOP_BAR_ROWS,
  );
  return (
    <Box key="minimap-slot" flexShrink={1} minWidth={0} overflow="hidden">
      <Svg
        key="minimap"
        source={mapSvg(drawn, DESKTOP_BAR_ROWS)}
        alt={`minimap, ${drawn.length} columns`}
      />
    </Box>
  );
};

const forgetTranscript = () => {
  transcript = lastSeen = undefined;
  lastRows = "";
};

const startTicker = ($: EngineInterface) => {
  ticker?.cancel();
  forgetTranscript();
  let n = 0;
  ticker = $.clock.every(TICK, () => {
    if (isDirty) {
      isDirty = false;
      void update($, shown, () => [...onScreen]);
    }
    if (++n % REREAD) return;
    if (config.enabled.minimap) void rereadIfChanged($).catch(() => {});
  });
};

export const minimap = (on: On) => {
  on("session.start", { isInteractive: true }, async ($, e, next) => {
    startTicker($);
    return next(e);
  });

  // the desktop app runs Claude through the SDK, a non-interactive session; its first draw attaches it
  on("session.attach", { surface: "desktop" }, async ($, e, next) => {
    startTicker($);
    return next(e);
  });
};
