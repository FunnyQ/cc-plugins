// every rune; a new rune adds its name here and its section to TEMPLATE, any settings to DEFAULTS, and gates its hooks on `config.enabled[name]`
export const RUNES = [
  "clawd",
  "transcript",
  "prompt",
  "reply",
  "bash",
  "peer",
] as const;
export type Rune = (typeof RUNES)[number];
export type Side = "left" | "right";

type Config = {
  enabled: Record<Rune, boolean>;
  prompt: { color: string; icon: string; side: Side; fold_lines: number };
  reply: { color: string; icon: string; side: Side };
  bash: {
    color: string;
    error_color: string;
    icon: string;
    output_icon: string;
    side: Side;
    fold_lines: number;
  };
  peer: { color: string; icon: string; side: Side; fold_lines: number };
  glow: { style: string };
};

export const DEFAULTS: Config = {
  enabled: Object.fromEntries(RUNES.map((r) => [r, true])) as Record<
    Rune,
    boolean
  >,
  // nf-md icon U+F064C, needs a Nerd Font
  prompt: { color: "#1b5ea6", icon: "\u{F064C}", side: "right", fold_lines: 6 },
  // nf-cod icon U+EC82, needs a Nerd Font
  reply: { color: "#d97757", icon: "\u{EC82}", side: "left" },
  // nf-oct-terminal icon U+F489, needs a Nerd Font
  bash: {
    color: "#5f8f6a",
    error_color: "#c94f4f",
    icon: "\u{F489}",
    // nf-cod icon U+EF11
    output_icon: "\u{EF11}",
    side: "left",
    fold_lines: 8,
  },
  // nf-md-robot U+F06A9, needs a Nerd Font
  peer: { color: "#9b7fd1", icon: "\u{F06A9}", side: "left", fold_lines: 8 },
  glow: { style: "dark" },
};

export const configPath = (home: string) =>
  `${home}/.config/q-lab/cc-plugins/runes/config.yaml`;

// what renders read; register.tsx replaces its sections at session.start and on every /runes
export const config: Config = { ...DEFAULTS };

export const TEMPLATE = (
  enabled: Config["enabled"],
) => `# runes — edits apply at the next session start, or right away after any /runes
clawd:
  enabled: ${enabled.clawd}
transcript:
  enabled: ${enabled.transcript}    # every bubble below needs it
prompt:
  enabled: ${enabled.prompt}    # the person's bubble
  color: "${DEFAULTS.prompt.color}"
  icon: "\\U000F064C"   # Nerd Font glyph
  side: ${DEFAULTS.prompt.side}          # left | right
  fold_lines: ${DEFAULTS.prompt.fold_lines}
reply:
  enabled: ${enabled.reply}    # Claude's bubble
  color: "${DEFAULTS.reply.color}"
  icon: "\\uEC82"       # Nerd Font glyph
  side: ${DEFAULTS.reply.side}
bash:
  enabled: ${enabled.bash}    # Bash calls and their output
  color: "${DEFAULTS.bash.color}"
  error_color: "${DEFAULTS.bash.error_color}"
  icon: "\\uF489"       # Nerd Font glyph
  output_icon: "\\uEF11"   # Nerd Font glyph
  side: ${DEFAULTS.bash.side}
  fold_lines: ${DEFAULTS.bash.fold_lines}
peer:
  enabled: ${enabled.peer}    # subagents' and other sessions' messages
  color: "${DEFAULTS.peer.color}"
  icon: "\\U000F06A9"   # Nerd Font glyph
  side: ${DEFAULTS.peer.side}
  fold_lines: ${DEFAULTS.peer.fold_lines}
glow:
  style: ${DEFAULTS.glow.style}          # glow -s: dark | light | a style file path
`;

// the file's top-level keys in the order the template writes them
const SECTIONS = [...RUNES, "glow"] as const;

// bun's YAML parser runs in a child, since a mod has no Bun global; an empty file parses to null
export const PARSE = [
  "bun",
  "-e",
  "process.stdout.write(JSON.stringify(Bun.YAML.parse(await Bun.stdin.text()) ?? null))",
];

const isMap = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

type Check = (v: unknown) => boolean;
const isBool: Check = (v) => typeof v === "boolean";
const isColor: Check = (v) =>
  typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);
const isText: Check = (v) => typeof v === "string" && v.length > 0;
const isSide: Check = (v) => v === "left" || v === "right";
const isCount: Check = (v) => Number.isInteger(v) && (v as number) > 0;

const RULES: {
  [S in Exclude<keyof Config, "enabled">]: {
    [F in keyof Config[S]]: [Check, string];
  };
} = {
  prompt: {
    color: [isColor, "#rrggbb"],
    icon: [isText, "a glyph"],
    side: [isSide, "left | right"],
    fold_lines: [isCount, "a whole number above 0"],
  },
  reply: {
    color: [isColor, "#rrggbb"],
    icon: [isText, "a glyph"],
    side: [isSide, "left | right"],
  },
  bash: {
    color: [isColor, "#rrggbb"],
    error_color: [isColor, "#rrggbb"],
    icon: [isText, "a glyph"],
    output_icon: [isText, "a glyph"],
    side: [isSide, "left | right"],
    fold_lines: [isCount, "a whole number above 0"],
  },
  peer: {
    color: [isColor, "#rrggbb"],
    icon: [isText, "a glyph"],
    side: [isSide, "left | right"],
    fold_lines: [isCount, "a whole number above 0"],
  },
  glow: { style: [isText, "dark | light | a style file path"] },
};

// each invalid field falls back alone, so one typo never resets the rest of the file
export const normalize = (
  raw: unknown,
): { config: Config; problems: string[] } => {
  if (raw === null || raw === undefined)
    return { config: DEFAULTS, problems: [] };
  if (!isMap(raw))
    return { config: DEFAULTS, problems: ["the file is not a mapping"] };
  const problems: string[] = [];
  const out: Record<string, Record<string, unknown>> = {};
  for (const [section, fields] of Object.entries(RULES)) {
    const given = isMap(raw[section]) ? raw[section] : {};
    if (raw[section] !== undefined && !isMap(raw[section]))
      problems.push(`${section}: not a mapping`);
    out[section] = { ...DEFAULTS[section as keyof Config] };
    for (const [field, [check, want]] of Object.entries(
      fields as Record<string, [Check, string]>,
    )) {
      const v = given[field];
      if (v === undefined) continue;
      if (check(v)) out[section][field] = v;
      else problems.push(`${section}.${field}: ${JSON.stringify(v)} (${want})`);
    }
  }
  // an older file kept every switch in one top-level enabled: block; a section's own switch wins over it
  const legacy = isMap(raw.enabled) ? raw.enabled : {};
  const enabled = { ...DEFAULTS.enabled };
  for (const r of RUNES) {
    const own = isMap(raw[r]) ? raw[r].enabled : undefined;
    const [v, name] = own !== undefined ? [own, `${r}.enabled`] : [legacy[r], `enabled.${r}`];
    if (v === undefined) continue;
    if (isBool(v)) enabled[r] = v as boolean;
    else problems.push(`${name}: ${JSON.stringify(v)} (true | false)`);
  }
  return { config: { ...out, enabled } as Config, problems };
};

// where a top-level key's block ends: the next line that starts a key of its own
const blockEnd = (lines: string[], head: number) => {
  let end = head + 1;
  while (end < lines.length && !/^[^\s#]/.test(lines[end]!)) end++;
  return end;
};

// a block goes in before the first section the template writes after it, so the file keeps the template's order
const insertBlock = (text: string, section: string, block: string): string => {
  const lines = text.split("\n");
  const later = SECTIONS.slice(SECTIONS.indexOf(section as never) + 1);
  const at = lines.findIndex((l) => later.some((s) => l.startsWith(`${s}:`)));
  if (at === -1) {
    const body = text === "" || text.endsWith("\n") ? text : `${text}\n`;
    return `${body}${block}\n`;
  }
  lines.splice(at, 0, ...block.split("\n"));
  return lines.join("\n");
};

// rewrites only the switch's own line in its section, so comments and layout survive;
// a flow mapping is left as it is, and the caller's read-back refuses the result
export const setSwitch = (text: string, name: Rune, value: boolean): string => {
  const lines = text.split("\n");
  const head = lines.findIndex((l) => l.startsWith(`${name}:`));
  if (head === -1) return insertBlock(text, name, `${name}:\n  enabled: ${value}`);
  if (!new RegExp(`^${name}:\\s*(#.*)?$`).test(lines[head]!)) return text;
  const end = blockEnd(lines, head);
  for (let i = head + 1; i < end; i++) {
    const m = lines[i]!.match(/^(\s+enabled\s*:\s*)([^#]*?)(\s*#.*)?$/);
    if (!m) continue;
    lines[i] = `${m[1]}${value}${m[3] ?? ""}`;
    return lines.join("\n");
  }
  const indent = lines.slice(head + 1, end).find((l) => /^\s+\w/.test(l))?.match(/^\s+/)?.[0] ?? "  ";
  lines.splice(head + 1, 0, `${indent}enabled: ${value}`);
  return lines.join("\n");
};

// true once a parsed file has every section, each rune's with its switch, and no older enabled: block;
// an addition a flow mapping or a duplicate key swallowed fails it
export const isComplete = (raw: unknown): boolean =>
  isMap(raw) &&
  raw.enabled === undefined &&
  SECTIONS.every((s) => isMap(raw[s])) &&
  RUNES.every((r) => (raw[r] as Record<string, unknown>).enabled !== undefined);

// brings a file an older runes wrote up to the template: the top-level enabled: block moves into each rune's
// section, and every missing section goes in with the template's text, in the template's order
export const upgrade = (text: string, raw: unknown): string => {
  const given = raw === null || raw === undefined ? {} : raw;
  if (!isMap(given)) return text;
  const legacy = isMap(given.enabled) ? given.enabled : {};
  const carried = Object.fromEntries(
    RUNES.map((r) => [r, isBool(legacy[r]) ? legacy[r] : DEFAULTS.enabled[r]]),
  ) as Config["enabled"];
  let lines = text.split("\n");
  const old = lines.findIndex((l) => /^enabled:\s*(#.*)?$/.test(l));
  if (old !== -1) lines.splice(old, blockEnd(lines, old) - old);
  let out = lines.join("\n");
  const template = TEMPLATE(carried).split("\n");
  for (const section of SECTIONS) {
    const own = given[section];
    if (own === undefined) {
      const head = template.findIndex((l) => l.startsWith(`${section}:`));
      const block = template.slice(head, blockEnd(template, head)).join("\n").replace(/\n+$/, "");
      out = insertBlock(out, section, block);
    } else if (section !== "glow" && isMap(own) && own.enabled === undefined) {
      out = setSwitch(out, section, carried[section]);
    }
  }
  return out;
};
