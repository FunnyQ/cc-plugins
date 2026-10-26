import { atom, read, update } from "claude-code";
import type { EngineInterface, On, Timer } from "claude-code";

import type { FlightdeckDeck } from "../../types";
import { FLIGHTDECK_COMMAND, planArg, planFromOutput } from "./deck-command.ts";
import {
  type CardModel,
  clip,
  COLOR,
  docked,
  inline,
  type Line,
} from "./rows.ts";
import type { DeckSnapshot, DeckTask, DeckTokens } from "./types.ts";

const PANE = "flightdeck";
const COLUMNS = 40;
const INLINE_ROWS = 2;
const SNAPSHOT_POLL_MS = 2000;

const EMPTY: FlightdeckDeck = {
  snapshot: null,
  stale: false,
  message: null,
  tokenMode: "fresh",
};
const deck = atom({ plugin: "dispatch", key: "flightdeck" } as const, EMPTY);

// the module keeps the truth and publishes it whole, so two writes racing on the atom both land the latest view
let view: FlightdeckDeck = EMPTY;
let generation = 0;
let ticker: Timer | undefined;
let lastOut = "";
let followedPlan: string | null = null;

const publish = ($: EngineInterface) => update($, deck, () => view);

const firstLine = (text: string) => text.split("\n")[0]?.trim() ?? "";
const runScript = ($: EngineInterface, name: string, ...args: string[]) =>
  $.process.run([
    "bun",
    `${$.plugin.root}/skills/autopilot/scripts/${name}`,
    ...args,
  ]);
const isOpen = async ($: EngineInterface) =>
  (await $.ui.panes()).some((p) => p.id === PANE);
const isPlaced = async ($: EngineInterface) =>
  (await $.ui.panes()).some((p) => p.id === PANE && p.isPlaced);

const toastText = (t: DeckTask) => {
  const parts = [t.ref, t.title, t.state, `attempt ${t.attempts}`];
  if (t.score)
    parts.push(
      `score ${t.score.weighted.toFixed(1)}/${t.score.threshold.toFixed(1)} ${t.score.passed ? "passed" : "failed"}`,
    );
  return parts.join(" · ");
};

const tokens = new Map<string, DeckTokens | null>();
let runTokens: DeckTokens | null = null;
const unread = (s: DeckSnapshot | null) =>
  Object.values(s?.tasks ?? {}).some(
    (t) => t.state === "done" && !tokens.has(t.ref),
  );

const refresh = async ($: EngineInterface, gen: number, plan: string) => {
  const withUsage = unread(view.snapshot as DeckSnapshot | null);
  const r = withUsage
    ? await runScript($, "deck-snapshot.ts", plan, "--usage")
    : await runScript($, "deck-snapshot.ts", plan);
  if (gen !== generation) return;
  if (r.exitCode === 0) {
    if (r.stdout !== lastOut || view.stale || withUsage) {
      lastOut = r.stdout;
      const snapshot = JSON.parse(r.stdout) as DeckSnapshot;
      for (const t of Object.values(snapshot.tasks)) {
        if (t.state !== "done") continue;
        if (withUsage && !tokens.has(t.ref)) tokens.set(t.ref, t.tokens);
        t.tokens = tokens.get(t.ref) ?? null;
      }
      if (withUsage) runTokens = snapshot.tokens;
      snapshot.tokens = runTokens;
      view = {
        ...view,
        snapshot,
        stale: false,
        message: null,
      };
      await publish($);
    }
  } else {
    const message = firstLine(r.stderr);
    if (!view.stale || view.message !== message) {
      view = { ...view, stale: true, message };
      await publish($);
    }
  }
  const live = view.snapshot as DeckSnapshot | null;
  if (live?.agents.length || (live?.time && live.time.endedAt === null))
    $.ui.invalidate("ui.render");
};

const openOn = async ($: EngineInterface, plan: string) => {
  const gen = ++generation;
  followedPlan = plan;
  tokens.clear();
  runTokens = null;
  view = { ...EMPTY, tokenMode: view.tokenMode };
  lastOut = "";
  void publish($);
  ticker?.cancel();
  let isRunning = false;
  let isFirst = true;
  const tick = async () => {
    if (isRunning) return;
    isRunning = true;
    try {
      if (!isFirst && !(await isOpen($))) {
        if (gen === generation) {
          generation++;
          followedPlan = null;
          own.cancel();
        }
        return;
      }
      isFirst = false;
      await refresh($, gen, plan);
    } finally {
      isRunning = false;
    }
  };
  const own = $.clock.every(SNAPSHOT_POLL_MS, () => void tick());
  ticker = own;
  void tick();
  const title = `Flightdeck · ${plan.replace(/\/+$/, "").split("/").pop()}`;
  return $.ui.open({
    id: PANE,
    title,
    columns: COLUMNS,
    rows: INLINE_ROWS,
  });
};

const close = async ($: EngineInterface) => {
  generation++;
  followedPlan = null;
  ticker?.cancel();
  ticker = undefined;
  await $.ui.close({ id: PANE });
};

export const flightdeck = (on: On) => {
  // a matcher of its own, so no other unmatched session.start hook in this module collides with it
  on("session.start", { isInteractive: true }, async ($, e, next) => {
    await $.command.register({
      name: "flightdeck",
      description: "Open the flightdeck overview pane",
      argumentHint: "[planDir|close]",
    });
    return next(e);
  });

  on("command.run", { command: "flightdeck" }, async ($, e) => {
    const arg = e.args.trim();
    if (arg === "close" || (arg === "" && (await isPlaced($)))) {
      await close($);
      return { text: "Flightdeck closed." };
    }
    const target = arg || followedPlan;
    if (target) {
      await openOn($, target);
      return { text: `Flightdeck opened on ${target}.` };
    }
    const gen = generation;
    const top = await $.process.run(["git", "rev-parse", "--show-toplevel"]);
    const root = top.exitCode === 0 ? top.stdout.trim() : await $.session.cwd();
    const r = await runScript($, "deck-snapshot.ts", "--latest", root);
    if (r.exitCode === 3)
      return { text: `No flightplan run found under ${root}/docs` };
    if (r.exitCode !== 0) return { text: firstLine(r.stderr) };
    if (gen !== generation) return { text: "Flightdeck lookup superseded." };
    const { plan } = JSON.parse(r.stdout) as { plan: string };
    await openOn($, plan);
    return { text: `Flightdeck opened on ${plan}.` };
  });

  // a distinct matcher from register.ts's Edit|Write lint hook; opens in the launching session only
  on(
    "tool.call",
    { tool: "Bash", command: FLIGHTDECK_COMMAND },
    async ($, e, next) => {
      const ran = await next(e);
      if (ran.deny !== undefined || ran.isError) return ran;
      const plan =
        planFromOutput((ran.result as { stdout?: string }).stdout ?? "") ??
        planArg(e.command);
      if (plan && !(await openOn($, plan)).isPlaced)
        $.ui.toast(
          "Flightdeck is waiting for a wider terminal. Type /flightdeck to show it.",
        );
      return ran;
    },
  );

  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e);
    const { snapshot, stale, message, tokenMode } = await read($, deck);
    const s = snapshot as DeckSnapshot | null;
    const width = e.props.bodyColumns ?? COLUMNS;

    const row = (line: Line) => (
      <Box flexDirection="row">
        {line.length === 0 && <Text> </Text>}
        {line.map((seg) => {
          const task = seg.ref ? s?.tasks[seg.ref] : undefined;
          if (!task)
            return (
              <Text color={seg.color} dimColor={seg.dim}>
                {seg.text}
              </Text>
            );
          // a Button takes no colour, so the ref is the pressable part and the coloured glyph rides beside it; a clip that cut into the ref leaves it all pressable
          const head = seg.text.startsWith(task.ref) ? task.ref : seg.text;
          const rest = seg.text.slice(head.length);
          return (
            <Box flexDirection="row">
              <Button
                key={`card:${task.ref}`}
                plain
                dimColor={seg.dim}
                label={head}
                onPress={() => $.ui.toast(toastText(task))}
              />
              {rest && (
                <Text color={seg.color} dimColor={seg.dim}>
                  {rest}
                </Text>
              )}
            </Box>
          );
        })}
      </Box>
    );

    if (!s)
      return row(clip([{ text: message ?? "Loading…", dim: true }], width));
    if (e.props.placement === "inline")
      return (
        <Box flexDirection="column">{inline(s, width, stale).map(row)}</Box>
      );
    const launch = async () => {
      const r = await runScript($, "flightdeck.ts", "--plan", s.plan, "--open");
      if (r.exitCode !== 0) $.ui.toast(firstLine(r.stderr));
    };
    const { title, totals, bars, wave, states, cards, crew } = docked(
      s,
      width,
      Date.now(),
      stale,
      tokenMode,
    );
    const toggleTokens = async () => {
      view = {
        ...view,
        tokenMode: view.tokenMode === "fresh" ? "billed" : "fresh",
      };
      await publish($);
    };
    // a Button takes no colour, so the glyph is coloured Text and the ref beside it is the pressable part
    const cardBox = (c: CardModel) => (
      <Box
        flexDirection="column"
        width={cards.inner + 2}
        borderStyle="round"
        borderColor={c.color}
        borderDimColor={c.dim}
      >
        <Box flexDirection="row">
          <Text color={c.color} dimColor={c.dim}>
            {c.head.slice(0, 2)}
          </Text>
          <Button
            key={`card:${c.ref}`}
            plain
            dimColor={c.dim}
            label={c.head.slice(2)}
            onPress={() => $.ui.toast(toastText(s.tasks[c.ref]!))}
          />
          {c.time && (
            <Box flexGrow={1} justifyContent="flex-end">
              <Text dimColor>{c.time}</Text>
            </Box>
          )}
        </Box>
        <Text dimColor>{c.sub}</Text>
        {c.agents.map((line) => (
          <Text color={COLOR["in-progress"]}>{line}</Text>
        ))}
        {c.tokens && <Text dimColor>{c.tokens}</Text>}
      </Box>
    );
    return (
      // the top row clears the pane's close mark, which sits over the body's first line
      <Box flexDirection="column" paddingTop={1}>
        <Box
          key="title"
          justifyContent="center"
          borderStyle="round"
          borderDimColor
        >
          <Text bold>{title}</Text>
        </Box>
        {totals && (
          <Box
            key="totals"
            flexDirection="column"
            borderStyle="round"
            borderDimColor
            paddingX={1}
          >
            <Button
              key="token-mode"
              plain
              dimColor
              label={`Total Cost · ${tokenMode}`}
              onPress={() => void toggleTokens()}
            />
            <Box flexDirection="row" justifyContent="space-between">
              <Text>{totals.time}</Text>
              {totals.tokens && <Text>{totals.tokens}</Text>}
            </Box>
          </Box>
        )}
        {bars.map(row)}
        {crew.length > 0 && (
          <Box
            key="loose-agents"
            flexDirection="column"
            alignItems="center"
            borderStyle="round"
            borderColor={COLOR["in-progress"]}
          >
            {crew.map(row)}
          </Box>
        )}
        {row([])}
        <Box flexDirection="row" justifyContent="center">
          {row(wave)}
        </Box>
        <Box flexDirection="row" justifyContent="center">
          {row(states)}
        </Box>
        {cards.groups.map((g) => (
          <Box flexDirection="row">
            <Text>{g.label}</Text>
            <Box
              flexDirection="row"
              flexWrap="wrap"
              flexShrink={1}
              columnGap={1}
            >
              {g.cards.map(cardBox)}
            </Box>
          </Box>
        ))}
        <Box flexDirection="row" justifyContent="center">
          <Button
            key="open"
            label="Open flightdeck"
            onPress={() => void launch()}
          />
        </Box>
      </Box>
    );
  });
};
