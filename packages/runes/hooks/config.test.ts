import { expect, test } from "claude-code/testing";

import {
  DEFAULTS,
  isComplete,
  normalize,
  RUNES,
  setSwitch,
  TEMPLATE,
  upgrade,
} from "./config";

// what bun's parser makes of the current template
const CURRENT = () => ({
  clawd: { enabled: true },
  transcript: {
    enabled: true,
    prompt: { enabled: true },
    reply: { enabled: true },
    bash: { enabled: true },
    read: { enabled: true },
    edit: { enabled: true },
    write: { enabled: true },
    agent: { enabled: true },
    skill: { enabled: true },
    peer: { enabled: true },
    glow: null,
  },
  minimap: { enabled: true },
  teacher: { enabled: true },
});

test("normalize fills every missing field from the defaults", () => {
  expect(normalize(null)).toEqual({ config: DEFAULTS, problems: [] });
  const { config, problems } = normalize({
    transcript: { prompt: { side: "left" } },
  });
  expect(config.prompt).toEqual({ ...DEFAULTS.prompt, side: "left" });
  expect(config.reply).toEqual(DEFAULTS.reply);
  expect(problems).toEqual([]);
});

test("normalize reads each switch and field under transcript, and drops only an invalid one", () => {
  const { config, problems } = normalize({
    clawd: { enabled: "off" },
    transcript: {
      enabled: false,
      prompt: { enabled: false, color: "blue", side: "middle", fold_lines: 3 },
      glow: { style: 7 },
    },
  });
  // YAML 1.2 reads off as a string, so it must not count as false
  expect(config.enabled.clawd).toBe(true);
  expect(config.enabled.transcript).toBe(false);
  expect(config.enabled.prompt).toBe(false);
  expect(config.prompt.color).toBe(DEFAULTS.prompt.color);
  expect(config.prompt.side).toBe("right");
  expect(config.prompt.fold_lines).toBe(3);
  expect(config.glow.style).toBe("dark");
  expect(problems.join("\n")).toContain("clawd.enabled");
  expect(problems.join("\n")).toContain("transcript.prompt.color");
  expect(problems.join("\n")).toContain("transcript.prompt.side");
  expect(problems.join("\n")).toContain("transcript.glow.style");
  expect(problems).toHaveLength(4);
});

test("normalize still reads both older layouts, the nested one winning", () => {
  const { config, problems } = normalize({
    enabled: { clawd: false, bash: false, reply: false },
    bash: { enabled: true, side: "right" },
    reply: { side: "right" },
    transcript: { reply: { enabled: true } },
  });
  expect(config.enabled.clawd).toBe(false);
  expect(config.enabled.bash).toBe(true);
  expect(config.bash.side).toBe("right");
  expect(config.enabled.reply).toBe(true);
  // a nested section, even a bare one, is the one read; the flat one beside it is ignored
  expect(config.reply.side).toBe(DEFAULTS.reply.side);
  expect(problems).toEqual([]);
});

test("normalize refuses a file that is not a mapping", () => {
  const { config, problems } = normalize(["a"]);
  expect(config).toEqual(DEFAULTS);
  expect(problems).toHaveLength(1);
});

test("TEMPLATE nests the bubbles and glow under transcript, setting only the switches", () => {
  const text = TEMPLATE({ ...DEFAULTS.enabled, clawd: false, bash: false });
  expect(text).toContain("clawd:\n  enabled: false\n");
  expect(text).toContain("transcript:\n  enabled: true");
  expect(text).toContain("  prompt:\n    enabled: true");
  expect(text).toContain("  bash:\n    enabled: false");
  expect(text).toContain("  glow:\n    # style: dark");
  expect(text).toContain('    # color: "#5f8f6a"');
  const set = text.split("\n").filter((l) => /^\s+\w+:\s*\S/.test(l));
  expect(set.every((l) => /^\s+enabled:/.test(l))).toBe(true);
  expect(text).not.toMatch(/^(enabled|prompt|reply|bash|peer|glow):/m);
});

test("setSwitch edits only the switch's own line, top-level or nested, keeping its comment", () => {
  const text = TEMPLATE(DEFAULTS.enabled);
  const out = setSwitch(text, "prompt", false);
  expect(out).toContain(
    "  prompt:\n    enabled: false    # the person's bubble",
  );
  expect(
    out.split("\n").filter((l, i) => l !== text.split("\n")[i]),
  ).toHaveLength(1);
  expect(setSwitch(text, "transcript", false)).toContain(
    "transcript:\n  enabled: false",
  );
  expect(setSwitch(text, "transcript", false)).toContain(
    "  prompt:\n    enabled: true",
  );
});

test("setSwitch opens a section without a switch with one", () => {
  expect(
    setSwitch("transcript:\n  bash:\n    side: right\n", "bash", false),
  ).toBe("transcript:\n  bash:\n    enabled: false\n    side: right\n");
});

test("setSwitch adds a missing section in the template's order, and transcript when it is missing too", () => {
  expect(
    setSwitch(
      "transcript:\n  enabled: true\n  prompt:\n    enabled: true\n  bash:\n    side: right\n",
      "reply",
      false,
    ),
  ).toBe(
    "transcript:\n  enabled: true\n  prompt:\n    enabled: true\n  reply:\n    enabled: false\n  bash:\n    side: right\n",
  );
  expect(setSwitch("clawd:\n  enabled: true\n", "peer", false)).toBe(
    "clawd:\n  enabled: true\ntranscript:\n  peer:\n    enabled: false\n",
  );
});

test("setSwitch leaves a flow mapping alone, so the read-back refuses it", () => {
  const text = "transcript: { prompt: { enabled: true } }\n";
  expect(setSwitch(text, "prompt", false)).toBe(text);
});

test("upgrade nests 0.5.0's flat sections under transcript, every line and comment moving with them", () => {
  const old = [
    "# mine",
    "clawd:",
    "  enabled: true",
    "transcript:",
    "  enabled: true    # every bubble below needs it",
    "prompt:",
    "  enabled: false",
    "  side: left   # I like it here",
    "glow:",
    "  style: light",
    "bash:",
    "  enabled: true",
    "",
  ].join("\n");
  const raw = {
    clawd: { enabled: true },
    transcript: { enabled: true },
    prompt: { enabled: false, side: "left" },
    glow: { style: "light" },
    bash: { enabled: true },
  };
  const out = upgrade(old, raw);
  expect(out).not.toMatch(/^(prompt|reply|bash|peer|glow):/m);
  expect(out).toContain("# mine\n");
  expect(out).toContain(
    "  prompt:\n    enabled: false\n    side: left   # I like it here\n",
  );
  expect(out).toContain("  glow:\n    style: light\n");
  expect(out).toContain("  reply:\n    enabled: true");
  expect(out).toContain("  peer:\n    enabled: true");
  const order = ["  prompt:", "  reply:", "  bash:", "  peer:", "  glow:"].map(
    (s) => out.indexOf(`\n${s}\n`),
  );
  expect(order.every((i) => i > out.indexOf("\ntranscript:"))).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
});

test("upgrade moves the oldest top-level enabled block into the nested sections", () => {
  const old = "enabled:\n  clawd: false\n  bash: false\n";
  const out = upgrade(old, { enabled: { clawd: false, bash: false } });
  expect(out).not.toMatch(/^enabled:/m);
  expect(out).toContain("clawd:\n  enabled: false\n");
  expect(out).toContain("  bash:\n    enabled: false    # Bash calls");
  expect(out).toContain("transcript:\n  enabled: true");
  // the commented defaults come with each block the template supplies
  expect(out).toContain(
    '  bash:\n    enabled: false    # Bash calls and their output\n    # color: "#5f8f6a"\n',
  );
  expect(out).toContain("  glow:\n    # style: dark");
});

test("upgrade leaves a current file alone, and isComplete tells current from older", () => {
  const full = TEMPLATE(DEFAULTS.enabled);
  expect(upgrade(full, CURRENT())).toBe(full);
  expect(isComplete(CURRENT())).toBe(true);
  expect(isComplete({ ...CURRENT(), enabled: { clawd: true } })).toBe(false);
  expect(isComplete({ ...CURRENT(), bash: { enabled: true } })).toBe(false);
  const bare = CURRENT();
  bare.transcript.bash = null as never;
  expect(isComplete(bare)).toBe(false);
});

test("a section left empty gets its switch back, and never throws", () => {
  const raw = CURRENT() as Record<string, unknown>;
  raw.clawd = null;
  expect(isComplete(raw)).toBe(false);
  const text = TEMPLATE(DEFAULTS.enabled).replace(
    "clawd:\n  enabled: true\n",
    "clawd:\n",
  );
  expect(upgrade(text, raw)).toContain("clawd:\n  enabled: true\n");
});

test("a section holding only comments reads as null, which is neither a problem nor incomplete", () => {
  expect(normalize(CURRENT()).problems).toEqual([]);
  expect(normalize(CURRENT()).config.glow).toEqual(DEFAULTS.glow);
  expect(RUNES.every((r) => normalize(CURRENT()).config.enabled[r])).toBe(true);
});

test("the minimap rune starts off and its section sits at the top level", () => {
  expect(DEFAULTS.enabled.minimap).toBe(false);
  expect(TEMPLATE(DEFAULTS.enabled)).toContain("\nminimap:\n  enabled: false");
});

test("the minimap's look is read from its own section, each invalid field falling back alone", () => {
  const { config, problems } = normalize({
    minimap: { enabled: true, bar_rows: 4, gap: 0, marker_color: "#112233" },
  });
  expect(config.minimap).toEqual({ bar_rows: 4, gap: 2, marker_color: "#112233" });
  expect(config.enabled.minimap).toBe(true);
  expect(problems.join("\n")).toContain("minimap.gap");
  expect(normalize(null).config.minimap).toEqual({ bar_rows: 3, gap: 2, marker_color: "#ff8c00" });
});

test("TEMPLATE lists the minimap's fields commented, so a changed default reaches every file", () => {
  const text = TEMPLATE(DEFAULTS.enabled);
  expect(text).toContain('\n  # bar_rows: 3');
  expect(text).toContain('\n  # gap: 2');
  expect(text).toContain('\n  # marker_color: "#ff8c00"');
});

test("bash.jev is on by default, is read as a switch, and an invalid value falls back alone", () => {
  expect(DEFAULTS.bash.jev).toBe(true);
  expect(normalize({ transcript: { bash: { jev: false } } }).config.bash.jev).toBe(false);
  const { config, problems } = normalize({ transcript: { bash: { jev: "off", fold_lines: 4 } } });
  expect(config.bash.jev).toBe(true);
  expect(config.bash.fold_lines).toBe(4);
  expect(problems.join("\n")).toContain("transcript.bash.jev");
  expect(TEMPLATE(DEFAULTS.enabled)).toContain("\n    # jev: true");
});
