import { expect, test } from "claude-code/testing";

import { DEFAULTS, fillMissing, normalize, setSwitch, TEMPLATE } from "./config";

test("normalize fills every missing field from the defaults", () => {
  expect(normalize(null)).toEqual({ config: DEFAULTS, problems: [] });
  const { config, problems } = normalize({ prompt: { side: "left" } });
  expect(config.prompt).toEqual({ ...DEFAULTS.prompt, side: "left" });
  expect(config.reply).toEqual(DEFAULTS.reply);
  expect(problems).toEqual([]);
});

test("normalize drops only the invalid field and names it", () => {
  const { config, problems } = normalize({
    enabled: { clawd: "off", transcript: false },
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
  expect(problems.join("\n")).toContain("enabled.clawd");
  expect(problems.join("\n")).toContain("prompt.color");
  expect(problems.join("\n")).toContain("prompt.side");
  expect(problems.join("\n")).toContain("glow.style");
  expect(problems).toHaveLength(4);
});

test("normalize refuses a file that is not a mapping", () => {
  const { config, problems } = normalize(["a"]);
  expect(config).toEqual(DEFAULTS);
  expect(problems).toHaveLength(1);
});

test("setSwitch edits only the matching line and keeps its comment", () => {
  const text = TEMPLATE(DEFAULTS.enabled);
  const out = setSwitch(text, "prompt", false);
  expect(out).toContain(
    "  prompt: false    # the person's bubble; needs transcript",
  );
  expect(
    out.split("\n").filter((l, i) => l !== text.split("\n")[i]),
  ).toHaveLength(1);
});

test("setSwitch inserts a missing key after the rune before it", () => {
  const out = setSwitch(
    "# top\nenabled:\n  clawd: true\nglow:\n  style: dark\n",
    "reply",
    false,
  );
  expect(out).toBe(
    "# top\nenabled:\n  clawd: true\n  reply: false\nglow:\n  style: dark\n",
  );
});

test("setSwitch adds the enabled: block when the file has none", () => {
  expect(setSwitch("glow:\n  style: dark\n", "clawd", false)).toBe(
    "glow:\n  style: dark\nenabled:\n  clawd: false\n",
  );
});

test("setSwitch leaves a flow mapping alone, so the read-back refuses it", () => {
  const text = "enabled: { clawd: true }\n";
  expect(setSwitch(text, "clawd", false)).toBe(text);
});

test("setSwitch ignores a same-named key outside enabled:", () => {
  const text = "enabled:\n  clawd: true\nprompt:\n  clawd: true\n";
  expect(setSwitch(text, "clawd", false)).toBe(
    "enabled:\n  clawd: false\nprompt:\n  clawd: true\n",
  );
});

test("TEMPLATE writes the switches it is given", () => {
  const text = TEMPLATE({ ...DEFAULTS.enabled, clawd: false });
  expect(text).toContain("  clawd: false\n");
  expect(text).toContain('icon: "\\U000F064C"');
});

test("fillMissing adds the switches and sections an older file lacks, with the template's text", () => {
  const old = "enabled:\n  clawd: false\nprompt:\n  side: left\n";
  const out = fillMissing(old, { enabled: { clawd: false }, prompt: { side: "left" } });
  expect(out.startsWith("enabled:\n")).toBe(true);
  expect(out).toContain("  clawd: false\n");
  expect(out).toContain("  peer: true\n");
  expect(out).toContain("prompt:\n  side: left\n");
  expect(out).toContain('bash:\n  color: "#5f8f6a"\n');
  expect(out).toContain("  output_icon: \"\\uEF11\"   # Nerd Font glyph\n");
  expect(out).toContain("peer:\n");
  expect(out).not.toContain('prompt:\n  color:');
});

test("fillMissing leaves a complete file alone", () => {
  const full = TEMPLATE(DEFAULTS.enabled);
  expect(fillMissing(full, DEFAULTS)).toBe(full);
});

test("fillMissing puts the switches it adds in RUNES order", () => {
  const out = fillMissing("enabled:\n  prompt: false\n", { enabled: { prompt: false } });
  const block = out.slice(0, out.indexOf("\nprompt:"));
  expect(block).toBe(
    "enabled:\n  clawd: true\n  transcript: true\n  prompt: false\n  reply: true\n  bash: true\n  peer: true",
  );
});
