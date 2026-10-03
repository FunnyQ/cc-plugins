import { expect, test } from "claude-code/testing";

import { DEFAULTS, isComplete, normalize, setSwitch, TEMPLATE, upgrade } from "./config";

test("normalize fills every missing field from the defaults", () => {
  expect(normalize(null)).toEqual({ config: DEFAULTS, problems: [] });
  const { config, problems } = normalize({ prompt: { side: "left" } });
  expect(config.prompt).toEqual({ ...DEFAULTS.prompt, side: "left" });
  expect(config.reply).toEqual(DEFAULTS.reply);
  expect(problems).toEqual([]);
});

test("normalize reads each rune's switch from its own section and drops only an invalid field", () => {
  const { config, problems } = normalize({
    clawd: { enabled: "off" },
    transcript: { enabled: false },
    prompt: { color: "blue", side: "middle", fold_lines: 3 },
    glow: { style: 7 },
  });
  // YAML 1.2 reads off as a string, so it must not count as false
  expect(config.enabled.clawd).toBe(true);
  expect(config.enabled.transcript).toBe(false);
  expect(config.prompt.color).toBe(DEFAULTS.prompt.color);
  expect(config.prompt.side).toBe("right");
  expect(config.prompt.fold_lines).toBe(3);
  expect(config.glow.style).toBe("dark");
  expect(problems.join("\n")).toContain("clawd.enabled");
  expect(problems.join("\n")).toContain("prompt.color");
  expect(problems.join("\n")).toContain("prompt.side");
  expect(problems.join("\n")).toContain("glow.style");
  expect(problems).toHaveLength(4);
});

test("normalize still reads an older file's top-level enabled block, a section's own switch winning", () => {
  const { config, problems } = normalize({
    enabled: { clawd: false, bash: false },
    bash: { enabled: true },
  });
  expect(config.enabled.clawd).toBe(false);
  expect(config.enabled.bash).toBe(true);
  expect(problems).toEqual([]);
});

test("normalize refuses a file that is not a mapping", () => {
  const { config, problems } = normalize(["a"]);
  expect(config).toEqual(DEFAULTS);
  expect(problems).toHaveLength(1);
});

test("TEMPLATE gives every rune a section that opens with its switch", () => {
  const text = TEMPLATE({ ...DEFAULTS.enabled, clawd: false });
  expect(text).toContain("clawd:\n  enabled: false\n");
  expect(text).toContain("transcript:\n  enabled: true");
  expect(text).toContain("bash:\n  enabled: true");
  expect(text).not.toMatch(/^enabled:/m);
  expect(text).toContain('icon: "\\U000F064C"');
});

test("setSwitch edits only the switch's line in its section and keeps its comment", () => {
  const text = TEMPLATE(DEFAULTS.enabled);
  const out = setSwitch(text, "prompt", false);
  expect(out).toContain("prompt:\n  enabled: false    # the person's bubble");
  expect(out.split("\n").filter((l, i) => l !== text.split("\n")[i])).toHaveLength(1);
});

test("setSwitch never touches another section's enabled line", () => {
  const text = "clawd:\n  enabled: true\nprompt:\n  enabled: true\n";
  expect(setSwitch(text, "prompt", false)).toBe("clawd:\n  enabled: true\nprompt:\n  enabled: false\n");
});

test("setSwitch opens a section that has no switch with one", () => {
  expect(setSwitch("bash:\n  side: right\n", "bash", false)).toBe("bash:\n  enabled: false\n  side: right\n");
});

test("setSwitch adds a missing section before the next one in order", () => {
  expect(setSwitch("clawd:\n  enabled: true\nbash:\n  side: right\nglow:\n  style: dark\n", "reply", false)).toBe(
    "clawd:\n  enabled: true\nreply:\n  enabled: false\nbash:\n  side: right\nglow:\n  style: dark\n",
  );
  expect(setSwitch("# top\n", "peer", false)).toBe("# top\npeer:\n  enabled: false\n");
});

test("setSwitch leaves a flow mapping alone, so the read-back refuses it", () => {
  const text = "clawd: { enabled: true }\n";
  expect(setSwitch(text, "clawd", false)).toBe(text);
});

test("upgrade moves an older file's switches into their sections, keeping the person's lines", () => {
  const old = "# mine\nenabled:\n  clawd: false   # off for now\n  bash: false\nprompt:\n  side: left\n";
  const raw = { enabled: { clawd: false, bash: false }, prompt: { side: "left" } };
  const out = upgrade(old, raw);
  expect(out).not.toMatch(/^enabled:/m);
  expect(out).toContain("# mine\n");
  expect(out).toContain("clawd:\n  enabled: false\n");
  expect(out).toContain("prompt:\n  enabled: true\n  side: left\n");
  expect(out).toContain("bash:\n  enabled: false    # Bash calls");
  expect(out).toContain('peer:\n  enabled: true');
  const order = ["clawd:", "transcript:", "prompt:", "reply:", "bash:", "peer:", "glow:"].map((s) => out.indexOf(`\n${s}`));
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(order.every((i) => i >= 0)).toBe(true);
});

test("upgrade leaves a current file alone, and isComplete tells the two apart", () => {
  const full = TEMPLATE(DEFAULTS.enabled);
  const parsed = Object.fromEntries(
    Object.entries({ ...DEFAULTS, enabled: undefined }).filter(([k]) => k !== "enabled"),
  ) as Record<string, unknown>;
  for (const r of Object.keys(DEFAULTS.enabled)) parsed[r] = { ...(parsed[r] as object), enabled: true };
  expect(upgrade(full, parsed)).toBe(full);
  expect(isComplete(parsed)).toBe(true);
  expect(isComplete({ ...parsed, enabled: { clawd: true } })).toBe(false);
});

test("TEMPLATE sets only the switches, every other field a commented default", () => {
  const text = TEMPLATE(DEFAULTS.enabled);
  const set = text.split("\n").filter((l) => /^\s+\w+:/.test(l));
  expect(set.every((l) => /^\s+enabled:/.test(l))).toBe(true);
  expect(text).toContain('  # color: "#5f8f6a"');
  expect(text).toContain("  # style: dark");
});

test("a section holding only comments reads as YAML null, which is neither a problem nor incomplete", () => {
  const raw: Record<string, unknown> = { glow: null };
  for (const r of Object.keys(DEFAULTS.enabled)) raw[r] = { enabled: true };
  expect(normalize(raw).problems).toEqual([]);
  expect(normalize(raw).config.glow).toEqual(DEFAULTS.glow);
  expect(isComplete(raw)).toBe(true);
});

test("a rune section left empty gets its switch back, and never throws", () => {
  const raw: Record<string, unknown> = { glow: null };
  for (const r of Object.keys(DEFAULTS.enabled)) raw[r] = { enabled: true };
  raw.clawd = null;
  expect(isComplete(raw)).toBe(false);
  const text = TEMPLATE(DEFAULTS.enabled).replace("clawd:\n  enabled: true\n", "clawd:\n");
  expect(upgrade(text, raw)).toContain("clawd:\n  enabled: true\n");
});
