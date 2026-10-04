import type { Hook, Register } from "claude-code";

import { band } from "./band";
import { mascot } from "./clawd/mascot";
import { minimap } from "./minimap/minimap";
import {
  config,
  configPath,
  DEFAULTS,
  normalize,
  PARSE,
  type Rune,
  RUNES,
  setSwitch,
  TEMPLATE,
  upgrade,
  isComplete,
} from "./config";
import { agent } from "./transcript/agent";
import { bash } from "./transcript/bash";
import { edit } from "./transcript/edit";
import { glow } from "./transcript/glow";
import { prompt } from "./transcript/prompt";
import { peer } from "./transcript/peer";
import { read } from "./transcript/read";
import { reply } from "./transcript/reply";
import { skill } from "./transcript/skill";
import { where } from "./transcript/where";

type $ = Parameters<Hook<"session.start">>[0];

const USAGE = `[on|off|status|reload] or <${RUNES.join("|")}> [on|off]; bare toggles`;
const status = () =>
  RUNES.map((r) => `${r}: ${config.enabled[r] ? "on" : "off"}`).join(", ");

type Loaded = {
  path: string;
  text?: string;
  // set when the file did not parse; every write then refuses, so a half-finished hand edit is never overwritten
  broken?: string;
  problems: string[];
  parse: (text: string) => Promise<unknown>;
};

// read on session.start and on every /runes, never while drawing
const load = async ($: $): Promise<Loaded> => {
  const home = (await $.env.get("HOME")) ?? "";
  where.home = home;
  const path = configPath(home);
  const parse = async (text: string) => {
    // a mod's child gets no HOME
    const r = await $.process
      .run(PARSE, { stdin: text, env: { HOME: home } })
      .catch((err: unknown) => {
        throw new Error(`bun did not start (${String(err)})`);
      });
    if (r.exitCode !== 0)
      throw new Error(
        r.stderr
          .split("\n")
          .find((l) => /error/i.test(l))
          ?.trim() ?? `bun exited ${r.exitCode}`,
      );
    return JSON.parse(r.stdout) as unknown;
  };
  try {
    if (!(await $.fs.exists(path))) {
      // the switches lived in $.store as `rune:<name>` before the config file
      const keys = RUNES.map((r) => `rune:${r}`);
      const stored = await Promise.all(keys.map((k) => $.store.get(k)));
      const enabled = Object.fromEntries(
        RUNES.map((r, i) => [r, stored[i] === undefined ? DEFAULTS.enabled[r] : stored[i] !== false]),
      ) as Record<Rune, boolean>;
      const text = TEMPLATE(enabled);
      await $.fs.write(path, text);
      await Promise.all(keys.map((k) => $.store.delete(k)));
      Object.assign(config, DEFAULTS, { enabled });
      return { path, text, problems: [], parse };
    }
    let text = String(await $.fs.read(path));
    let raw = await parse(text);
    const filled = upgrade(text, raw);
    if (filled !== text) {
      // checked by meaning: a text comparison passed a file whose duplicate key won over the edited one
      const back = await parse(filled).catch(() => undefined);
      if (isComplete(back)) {
        await $.fs.write(path, filled);
        text = filled;
        raw = back;
      }
    }
    const loaded = normalize(raw);
    Object.assign(config, loaded.config);
    return { path, text, problems: loaded.problems, parse };
  } catch (err) {
    Object.assign(config, DEFAULTS);
    const broken = err instanceof Error ? err.message : String(err);
    return { path, broken, problems: [], parse };
  }
};

const notice = (l: Loaded) =>
  l.broken
    ? `runes: ${l.path} could not be read, so every rune uses its defaults — ${l.broken}`
    : l.problems.length
      ? `runes: config.yaml — using the default for ${l.problems.join("; ")}`
      : undefined;

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    where.cwd = e.cwd;
    const [loaded] = await Promise.all([
      load($),
      $.command.register({
        name: "runes",
        description: "Turn runes (UI mods) on or off",
        argumentHint: USAGE,
      }),
    ]);
    const said = notice(loaded);
    // a toast raised during session.start is dropped (seen live after /reload-plugins), so it waits a beat
    if (said) $.clock.after(1000, () => $.ui.toast(said));
    $.ui.invalidate("ui.render");
    // the transcript bubbles' glow runs here, outside any draw, so no superseded redraw aborts it
    glow.work(
      (argv, init) => $.process.run(argv, init),
      () => $.ui.invalidate("ui.render"),
    );
    return next(e);
  });

  on("command.run", { command: "runes" }, async ($, e, next) => {
    const [first, second] = e.args.trim().split(/\s+/).filter(Boolean);
    const isRune = (RUNES as readonly string[]).includes(first ?? "");
    const targets = isRune ? [first as Rune] : RUNES;
    const state = isRune ? second : first;
    if (!["on", "off", "status", "reload", undefined].includes(state))
      return { text: `Usage: /runes ${USAGE}` };

    const loaded = await load($);
    $.ui.invalidate("ui.render");
    const said = notice(loaded);
    const answer = (text: string) => ({
      text: said ? `${text}\n${said}` : text,
    });
    if (state === "status" || state === "reload")
      return answer(`Runes — ${status()}`);
    if (loaded.text === undefined)
      return answer("Runes — config.yaml did not parse, so nothing written");

    // no state toggles: on while any target is off, off once they are all on
    const value = state ? state === "on" : targets.some((r) => !config.enabled[r]);
    const text = targets.reduce((t, r) => setSwitch(t, r, value), loaded.text);
    const want = { ...config.enabled };
    for (const r of targets) want[r] = value;
    // a flow mapping or a duplicate key further down would swallow the edit, so read it back first
    const parsed = await loaded.parse(text).catch((err: Error) => err);
    if (parsed instanceof Error)
      return answer(
        `Runes — the edit could not be read back (${parsed.message}), so nothing written`,
      );
    const back = normalize(parsed).config.enabled;
    const wrong = RUNES.filter((r) => back[r] !== want[r]);
    if (wrong.length)
      return answer(
        `Runes — the edit did not read back as ${wrong.map((r) => `${r}: ${want[r]}`).join(", ")} (a flow mapping or a duplicate key?), so nothing written`,
      );
    await $.fs.write(loaded.path, text);
    config.enabled = back;
    $.ui.invalidate("ui.render");
    return answer(`Runes — ${status()}`);
  });

  mascot(on);
  band(on);
  prompt(on);
  reply(on);
  bash(on);
  read(on);
  edit(on);
  agent(on);
  skill(on);
  peer(on);
  minimap(on);
};
