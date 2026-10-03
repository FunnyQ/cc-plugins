import { atom, read, update } from "claude-code";
import type { EngineInterface, On, Timer } from "claude-code";

import type { FlightdeckDeck } from "../../types";
import { FLIGHTDECK_COMMAND, planArg } from "./deck-command.ts";
import { clip, docked, inline, type Line } from "./rows.ts";
import type { DeckSnapshot, DeckTask } from "./types.ts";

const PANE = "flightdeck";
// the dock width the layouts are drawn for, and the inline seat's height: a summary line and the current wave
const COLUMNS = 40;
const INLINE_ROWS = 2;
// the snapshot child re-reads the task tree and run log; 2 s keeps elapsed times live without a busy child
const TICK_MS = 2000;

const EMPTY: FlightdeckDeck = {
  plan: null,
  snapshot: null,
  stale: false,
  message: null,
};
const deck = atom({ plugin: "dispatch", key: "flightdeck" } as const, EMPTY);

// the module keeps the truth and publishes it whole, so two writes racing on the atom both land the latest view
let view: FlightdeckDeck = EMPTY;
// bumped by every open and close; a snapshot or lookup that returns under an older value is dropped
let generation = 0;
let ticker: Timer | undefined;

const publish = ($: EngineInterface) => update($, deck, () => view);

const firstLine = (text: string) => text.split("\n")[0]?.trim() ?? "";
const scriptPath = ($: EngineInterface, name: string) =>
  `${$.plugin.root}/skills/autopilot/scripts/${name}`;
const isOpen = async ($: EngineInterface) =>
  (await $.ui.panes()).some((p) => p.id === PANE);

const toastText = (t: DeckTask) => {
  const parts = [t.ref, t.title, t.state, `attempt ${t.attempts}`];
  if (t.score)
    parts.push(
      `score ${t.score.weighted.toFixed(1)}/${t.score.threshold.toFixed(1)} ${t.score.passed ? "passed" : "failed"}`,
    );
  return parts.join(" · ");
};

const refresh = async ($: EngineInterface, gen: number, plan: string) => {
  const r = await $.process.run([
    "bun",
    scriptPath($, "deck-snapshot.ts"),
    plan,
  ]);
  if (gen !== generation) return;
  view =
    r.exitCode === 0
      ? { plan, snapshot: JSON.parse(r.stdout), stale: false, message: null }
      : { ...view, stale: true, message: firstLine(r.stderr) };
  await publish($);
  // a tick whose snapshot did not change still moves the agents' elapsed times
  $.ui.invalidate("ui.render");
};

// only open and close touch the ticker, synchronously before their first await
const openOn = async ($: EngineInterface, plan: string) => {
  const gen = ++generation;
  view = { ...EMPTY, plan };
  void publish($);
  ticker?.cancel();
  let isRunning = false;
  let isFirst = true;
  const tick = async () => {
    if (isRunning) return;
    isRunning = true;
    try {
      if (!isFirst && !(await isOpen($))) {
        // closed by hand: stop here, unless an open or close already moved on and owns the ticker
        if (gen === generation) {
          generation++;
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
  const own = $.clock.every(TICK_MS, () => void tick());
  ticker = own;
  void tick();
  const title = `Flightdeck · ${plan.replace(/\/+$/, "").split("/").pop()}`;
  await $.ui.open({
    id: PANE,
    title,
    columns: COLUMNS,
    rows: INLINE_ROWS,
  });
};

const close = async ($: EngineInterface) => {
  generation++;
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
    if (arg === "close" || (arg === "" && (await isOpen($)))) {
      await close($);
      return { text: "Flightdeck closed." };
    }
    if (arg !== "") {
      await openOn($, arg);
      return { text: `Flightdeck opened on ${arg}.` };
    }
    const gen = generation;
    const top = await $.process.run(["git", "rev-parse", "--show-toplevel"]);
    const root = top.exitCode === 0 ? top.stdout.trim() : await $.session.cwd();
    const r = await $.process.run([
      "bun",
      scriptPath($, "deck-snapshot.ts"),
      "--latest",
      root,
    ]);
    if (r.exitCode === 3)
      return { text: `No flightplan run found under ${root}/docs` };
    if (r.exitCode !== 0) return { text: firstLine(r.stderr) };
    // a close or another open issued during the lookup wins
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
      const plan = planArg(e.command);
      if (plan) await openOn($, plan);
      return ran;
    },
  );

  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e);
    const { snapshot, stale, message } = await read($, deck);
    const s = snapshot as DeckSnapshot | null;
    const width = e.props.bodyColumns ?? COLUMNS;

    const row = (line: Line) => (
      <Box flexDirection="row">
        {line.length === 0 && <Text> </Text>}
        {line.map((seg) => {
          const task = seg.ref ? s?.tasks[seg.ref] : undefined;
          if (!task || !seg.text.startsWith(task.ref))
            return (
              <Text color={seg.color} dimColor={seg.dim}>
                {seg.text}
              </Text>
            );
          // a Button takes no colour, so the ref is the pressable part and the coloured glyph rides beside it
          const rest = seg.text.slice(task.ref.length);
          return (
            <Box flexDirection="row">
              <Button
                key={`card:${task.ref}`}
                plain
                dimColor={seg.dim}
                label={task.ref}
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
      const r = await $.process.run([
        "bun",
        scriptPath($, "flightdeck.ts"),
        "--plan",
        s.plan,
      ]);
      if (r.exitCode !== 0) $.ui.toast(firstLine(r.stderr));
    };
    return (
      <Box flexDirection="column">
        {docked(s, width, Date.now(), stale).map(row)}
        <Button
          key="open"
          label="Open flightdeck"
          onPress={() => void launch()}
        />
      </Box>
    );
  });
};
