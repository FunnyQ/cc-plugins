import { read } from "claude-code";
import type { On } from "claude-code";

import { clawd, seen, sprite, spriteColumns } from "./clawd/mascot";
import { config } from "./config";
import { desktopMap, inlineMap } from "./minimap/minimap";
import { stem } from "./minimap/rows";
import { TEACHER_COLOR, TEACHER_ICON } from "./teacher/lesson";
import { teacher } from "./teacher/teacher";
import { bubble } from "./transcript/bubble";
import { innerWidth, wrapWords } from "./transcript/text";

// the band's state by their keys: the state scan needs literals written in the file that reads them, and `claude plugin validate` fails a key types/index.d.ts does not declare
const FRAME = { plugin: "runes", key: "frame" } as const;
const MAP_ROWS = { plugin: "runes", key: "minimapRows" } as const;
const MAP_SHOWN = { plugin: "runes", key: "minimapShown" } as const;
const VIEW = { plugin: "runes", key: "explain" } as const;
const LABEL = "Explain plz!";
const RUNNING = "explaining…";
const ASK = "Tell me…";

export const band = (on: On) => {
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const isDesktop = e.surface === "desktop";
    const isDrawn = e.surface === "terminal" || isDesktop;
    const hasMap = config.enabled.minimap && isDrawn;
    // the desktop draws the lesson under its prompt alone; the band would only repeat it
    const lesson = e.surface === "terminal" ? teacher.latest() : undefined;
    const hasButton = config.enabled.explain && isDrawn;
    if (
      (!config.enabled.clawd && !hasMap && !lesson && !hasButton) ||
      e.props.hasSurvey
    )
      return next(e);

    seen(e.requestId, isDesktop);
    if (!isDrawn) return next(e);
    const ui = $.ui.resolve(e);
    const { Box, Button } = ui;
    // a desktop draws a native button, so the terminal's brackets would read as text
    const bracket = (label: string) => `[${label}]`;
    const tag = (label: string) => (isDesktop ? label : bracket(label));
    const [
      { value: frame = { clip: clawd.clip, index: clawd.index } },
      list,
      shown,
      view,
    ] = await Promise.all([
      $.state.get(FRAME),
      hasMap ? read($, MAP_ROWS) : undefined,
      hasMap ? read($, MAP_SHOWN) : undefined,
      hasButton ? read($, VIEW) : undefined,
    ]);
    // the columns Clawd and its gap take off the map's width; bodyColumns, not the viewport, since a docked pane narrows the band
    // the buttons stack left of Clawd in its slot, beside it rather than under it, so they take no line of their own
    const buttons = Math.max(
      ...[LABEL, RUNNING, ASK].map((l) => bracket(l).length),
    );
    const slot = hasButton ? spriteColumns() + 1 + buttons : spriteColumns();
    const slotWidth = isDesktop ? undefined : slot;
    const reserved = config.enabled.clawd ? slot + config.minimap.gap : 0;
    const room = (e.props.bodyColumns ?? 0) - reserved;
    const here = new Set((shown ?? []).map(stem));
    const map =
      list?.length && room > 4
        ? isDesktop
          ? desktopMap(ui, list, here, room)
          : inlineMap(
              ui,
              list,
              here,
              room,
              config.minimap.bar_rows,
              (target) => () =>
                void $.ui.scroll({
                  to: { requestId: target },
                  block: "start",
                }),
            )
        : undefined;
    const row = (picture?: ReturnType<typeof h>) => (
      <Box
        key="clawd-row"
        flexDirection="row"
        justifyContent={
          !picture ? "flex-start" : map ? "space-between" : "flex-end"
        }
        alignItems="flex-end"
        width={e.props.bodyColumns}
      >
        {map}
        {picture}
      </Box>
    );

    const inner = innerWidth(e.props.bodyColumns);
    const [first = [], ...rest] = lesson
      ? wrapWords(
          [{ text: (lesson.quip ?? lesson.better).replace(/\s+/g, " ") }],
          inner - 3,
        )
      : [];
    const toLesson = () => {
      if (lesson?.requestId)
        void $.ui.scroll({
          to: { requestId: lesson.requestId },
          block: "start",
        });
    };
    // resolved on the terminal alone: the desktop's Button and Text are other types, and the notice never draws there
    const term = e.surface === "terminal" ? $.ui.resolve(e) : undefined;
    const notice =
      !lesson || !term
        ? undefined
        : bubble(
        { Box: term.Box, Text: term.Text },
        {
          key: "teacher",
          color: TEACHER_COLOR,
          icon: TEACHER_ICON,
          title: "Your English Teacher",
          side: "left",
          bar: false,
          inner,
          rows: [
            [
              "teacher:0",
              <term.Button plain onPress={toLesson}>
                {`${first.map((r) => r.text).join("")}${rest.length ? "…" : ""} ↑`}
              </term.Button>,
            ],
          ],
        },
      );
    const withNotice = (node: ReturnType<typeof row>) =>
      notice ? (
        <Box key="teacher-band" flexDirection="column">
          {notice}
          {node}
        </Box>
      ) : (
        node
      );

    const picture = sprite(ui, isDesktop, frame);
    const explain = (
      <Button
        key="explain"
        {...(isDesktop ? { variant: "primary" } : { plain: true })}
        onPress={() => undefined}
      >
        {tag(view?.isRunning ? RUNNING : LABEL)}
      </Button>
    );
    const ask = (
      <Button
        key="explain-open"
        {...(isDesktop ? {} : { plain: true })}
        dimColor
        onPress={() => undefined}
      >
        {tag(ASK)}
      </Button>
    );
    // a native button is taller than a text line, so the desktop keeps a line between the two or they overlap
    const button = !hasButton ? undefined : isDesktop ? (
      <Box
        key="explain-buttons"
        flexDirection="column"
        alignItems="flex-end"
        gap={2}
      >
        {explain}
        {ask}
      </Box>
    ) : (
      <Box key="explain-buttons" flexDirection="column" width={buttons}>
        <Box
          key="explain-line"
          flexDirection="row"
          justifyContent="flex-end"
          width={buttons}
        >
          {explain}
        </Box>
        <Box
          key="explain-open-line"
          flexDirection="row"
          justifyContent="flex-end"
          width={buttons}
        >
          {ask}
        </Box>
      </Box>
    );
    const clawdRow = config.enabled.clawd
      ? row(
          button ? (
            <Box
              key="clawd-slot"
              flexDirection="row"
              alignItems="flex-end"
              gap={1}
              width={slotWidth}
            >
              {button}
              {picture}
            </Box>
          ) : (
            picture
          ),
        )
      : map
        ? row()
        : undefined;
    if (!button || config.enabled.clawd)
      return clawdRow ? withNotice(clawdRow) : notice || next(e);
    return (
      <Box
        key={notice ? "teacher-band" : "explain-band"}
        flexDirection="column"
      >
        {notice}
        {clawdRow}
        <Box
          key="explain-row"
          flexDirection="row"
          justifyContent="flex-end"
          width={e.props.bodyColumns}
        >
          <Box
            key="explain-under-clawd"
            flexDirection="row"
            justifyContent="center"
            width={slotWidth}
          >
            {button}
          </Box>
        </Box>
      </Box>
    );
  });
};
