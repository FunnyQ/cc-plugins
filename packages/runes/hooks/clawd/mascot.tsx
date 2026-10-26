import type { Hook, On } from "claude-code";

import { Director } from "./director";
import { IMAGE_COLUMNS, IMAGE_ROWS, octants, pixels, svg } from "./encode";
import { CLIPS } from "./frames";
import { config } from "../config";
import type { Ui } from "../ui";

const TICK_MS = 50;
const DONE_MS = 5_000;
const SVG_WIDTH = 40;
const SVG_HEIGHT = 32;
const TEXT_COLUMNS = 10;

// read while drawing, so a frame redraws the band alone; an invalidate redrew every transcript row runes hooks.
// band.tsx reads it under a literal of its own (the state scan needs one in the file that reads); validate fails a key that drifts from types/index.d.ts
const FRAME = { plugin: "runes", key: "frame" } as const;

// what the band (band.tsx) and the frame ticker below share: module values, since a rune may share nothing else
const INITIAL = {
  requestId: undefined as string | undefined,
  clip: "living",
  index: 0,
  // terminals without kitty Unicode placeholders (herdr's libghostty) deny Image blits
  useText: false,
  // the desktop has no blit, so each frame is a redraw of a static SVG (transparent, unlike an isInteractive frame)
  isDesktop: false,
};
export const clawd = { ...INITIAL };

export const seen = (requestId: string, isDesktop: boolean) => {
  clawd.requestId = requestId;
  if (isDesktop) clawd.isDesktop = true;
};

export const spriteColumns = () =>
  clawd.useText ? TEXT_COLUMNS : IMAGE_COLUMNS;

export const sprite = (
  { Image, Svg, Text, Box }: Ui,
  isDesktop: boolean,
  frame: { clip: string; index: number },
) => {
  if (isDesktop)
    return (
      <Svg
        key="clawd"
        source={svg(frame.clip, frame.index)}
        alt={`Clawd ${frame.clip}`}
        width={SVG_WIDTH}
        height={SVG_HEIGHT}
      />
    );
  // Raster refuses non-BMP characters, so octants go out as plain coloured Text
  if (clawd.useText) {
    return (
      <Box key="clawd" flexDirection="column">
        {octants(frame.clip, frame.index).map((runs, y) => (
          <Text key={String(y)}>
            {runs.map((run, x) => (
              <Text
                key={String(x)}
                color={run.color}
                backgroundColor={run.backgroundColor}
              >
                {run.text}
              </Text>
            ))}
          </Text>
        ))}
      </Box>
    );
  }
  // the live clip and index, not `frame`: the ticker moves them by blit, which redraws nothing
  return (
    <Image
      key="clawd"
      columns={IMAGE_COLUMNS}
      rows={IMAGE_ROWS}
      alt=" "
      source={pixels(clawd.clip, clawd.index)}
    />
  );
};

function animate(
  $: Parameters<Hook<"session.start">>[0],
  nextClip: () => string,
  isDue: () => boolean,
) {
  clawd.clip = nextClip();
  $.clock.every(TICK_MS, () => {
    const { requestId } = clawd;
    if (!isDue() || requestId === undefined) return;
    clawd.index += 1;
    if (clawd.index === CLIPS[clawd.clip]!.length) {
      clawd.index = 0;
      clawd.clip = nextClip();
    }
    if (clawd.isDesktop || clawd.useText) {
      void $.state.set(FRAME, { clip: clawd.clip, index: clawd.index });
      return;
    }
    $.ui
      .blit({
        requestId,
        key: "clawd",
        source: pixels(clawd.clip, clawd.index),
      })
      .then((r) => {
        if (!("deny" in r)) return;
        clawd.useText = true;
        void $.state.set(FRAME, { clip: clawd.clip, index: clawd.index });
      });
  });
}

export const mascot = (on: On) => {
  const director = new Director();
  Object.assign(clawd, INITIAL);
  let now = 0;
  let isWorking = false;
  let blocked = 0;
  let subagents = 0;
  let turnStartedAt = 0;
  let doneAt = -Infinity;
  let lastActiveAt = 0;
  let elapsed = 0;
  const inputs = () => ({
    blocked,
    busy: (isWorking ? 1 : 0) + subagents,
    done: now - doneAt < DONE_MS,
    longestTurn: isWorking ? (now - turnStartedAt) / 1000 : 0,
    idleFor: isWorking ? 0 : (now - lastActiveAt) / 1000,
  });

  let isTicking = false;
  const nextClip = () => director.next(inputs());
  const isDue = () => {
    now += TICK_MS;
    elapsed += TICK_MS;
    if (
      !config.enabled.clawd ||
      clawd.requestId === undefined ||
      elapsed < CLIPS[clawd.clip]![clawd.index]!.ms
    )
      return false;
    elapsed = 0;
    return true;
  };

  // register.tsx holds the unmatched session.start; a mascot only matters where someone watches
  on("session.start", { isInteractive: true }, ($, e, next) => {
    if (!isTicking) animate($, nextClip, isDue);
    isTicking = true;
    return next(e);
  });

  // the desktop app runs Claude through the SDK, a non-interactive session; its first draw attaches it, a headless run never does
  on("session.attach", { surface: "desktop" }, ($, e, next) => {
    if (!isTicking) animate($, nextClip, isDue);
    isTicking = true;
    return next(e);
  });

  on("prompt.submit", ($, e, next) => {
    isWorking = true;
    turnStartedAt = now;
    doneAt = -Infinity;
    return next(e);
  });

  on("turn.complete", ($, e, next) => {
    // fires for each subagent turn too; only the main loop's ends the work, and subagents outlive it
    if (e.agentId) return next(e);
    isWorking = false;
    blocked = 0;
    doneAt = now;
    lastActiveAt = now;
    director.cheer();
    return next(e);
  });

  on("classic.PermissionRequest", ($, e, next) => {
    blocked = 1;
    return next(e);
  });

  on("classic.PostToolUse", ($, e, next) => {
    blocked = 0;
    return next(e);
  });

  on("classic.PermissionDenied", ($, e, next) => {
    blocked = 0;
    return next(e);
  });

  on("classic.SubagentStart", ($, e, next) => {
    subagents += 1;
    return next(e);
  });

  on("classic.SubagentStop", ($, e, next) => {
    subagents = Math.max(0, subagents - 1);
    lastActiveAt = now;
    return next(e);
  });
};
