import type { Register } from "claude-code";

import { mascot } from "./clawd/mascot";
import { enabled, RUNES } from "./switch";
import { glow } from "./transcript/glow";
import { prompt } from "./transcript/prompt";
import { reply } from "./transcript/reply";

const USAGE = `on|off|status, or <${RUNES.join("|")}> on|off`;
const status = () =>
  RUNES.map((r) => `${r}: ${enabled[r] === false ? "off" : "on"}`).join(", ");

// each switch persists across sessions in $.store as `rune:<name>`; a rune never switched off is on
export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    const [stored] = await Promise.all([
      Promise.all(RUNES.map((r) => $.store.get(`rune:${r}`))),
      $.command.register({
        name: "runes",
        description: "Turn runes (UI mods) on or off",
        argumentHint: USAGE,
      }),
    ]);
    RUNES.forEach((r, i) => {
      enabled[r] = stored[i] !== false;
    });
    // the transcript bubbles' glow runs here, outside any draw, so no superseded redraw aborts it
    glow.work(
      (argv, init) => $.process.run(argv, init),
      () => $.ui.invalidate("ui.render"),
    );
    return next(e);
  });

  on("command.run", { command: "runes" }, async ($, e) => {
    const [first = "status", second] = e.args
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const isRune = (RUNES as readonly string[]).includes(first);
    const targets = isRune ? [first] : RUNES;
    const state = isRune ? second : first;
    if (state === "status" || state === undefined)
      return { text: `Runes — ${status()}` };
    if (state !== "on" && state !== "off")
      return { text: `Usage: /runes ${USAGE}` };
    await Promise.all(
      targets.map((r) => {
        enabled[r] = state === "on";
        return $.store.set(`rune:${r}`, enabled[r]);
      }),
    );
    $.ui.invalidate("ui.render");
    return { text: `Runes — ${status()}` };
  });

  mascot(on);
  prompt(on);
  reply(on);
};
