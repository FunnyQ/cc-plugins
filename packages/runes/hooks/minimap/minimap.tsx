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

// the desktop's native "─" button, measured; a column is the wider of the two, so bars this wide touch. Measure again if the desktop restyles its buttons
const BAR_WIDTH = 34;
const CELL_HEIGHT = 8;
// a desktop column holds a native button, about three cells wide
export const DESKTOP_COLUMN = 3;

const barSvg = (line: Line, barRows: number) => {
  const height = barRows * CELL_HEIGHT;
  let top = height;
  const rects = line.segments.map((s) => {
    top -= s.cells * CELL_HEIGHT;
    return `<rect x="0" y="${top}" width="${BAR_WIDTH}" height="${s.cells * CELL_HEIGHT}" fill="${colorOf(s.kind)}"/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${BAR_WIDTH}" height="${height}" viewBox="0 0 ${BAR_WIDTH} ${height}">${rects.join("")}</svg>`;
};

// the desktop leaves a gap between text lines, so each bucket is one Svg bar over its button, aligned by their column
export const desktopMap = (
  { Box, Text, Button, Svg }: Ui,
  list: Row[],
  here: Set<string>,
  width: number,
  barRows: number,
  jump: (target: string) => () => void,
) => (
  <Box flexDirection="row" alignItems="flex-end">
    {lines(
      list,
      here,
      Math.max(1, Math.floor(width / DESKTOP_COLUMN)),
      barRows,
    ).map((line, i) => (
      <Box key={`col:${i}`} flexDirection="column" alignItems="center">
        <Svg
          source={barSvg(line, barRows)}
          alt={line.segments.map((s) => s.kind).join(", ")}
          width={BAR_WIDTH}
          height={barRows * CELL_HEIGHT}
        />
        {line.isHere ? (
          <Text color={config.minimap.marker_color}>━</Text>
        ) : (
          <Button
            key={`line:${i}`}
            plain
            dimColor
            label="─"
            onPress={jump(line.target)}
          />
        )}
      </Box>
    ))}
  </Box>
);

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
