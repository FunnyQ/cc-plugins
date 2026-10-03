// every rune; a new rune adds its name here and to TEMPLATE, any settings to DEFAULTS, and gates its hooks on `config.enabled[name]`
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
  enabled: Object.fromEntries(RUNES.map((r) => [r, true])) as Record<Rune, boolean>,
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
enabled:
  clawd: ${enabled.clawd}
  transcript: ${enabled.transcript}
  prompt: ${enabled.prompt}    # the person's bubble; needs transcript
  reply: ${enabled.reply}     # Claude's bubble; needs transcript
  bash: ${enabled.bash}      # Bash calls and their output; needs transcript
  peer: ${enabled.peer}      # subagents' and other sessions' messages; needs transcript
prompt:
  color: "${DEFAULTS.prompt.color}"
  icon: "\\U000F064C"   # Nerd Font glyph
  side: ${DEFAULTS.prompt.side}          # left | right
  fold_lines: ${DEFAULTS.prompt.fold_lines}
reply:
  color: "${DEFAULTS.reply.color}"
  icon: "\\uEC82"       # Nerd Font glyph
  side: ${DEFAULTS.reply.side}
bash:
  color: "${DEFAULTS.bash.color}"
  error_color: "${DEFAULTS.bash.error_color}"
  icon: "\\uF489"       # Nerd Font glyph
  output_icon: "\\uEF11"   # Nerd Font glyph
  side: ${DEFAULTS.bash.side}
  fold_lines: ${DEFAULTS.bash.fold_lines}
peer:
  color: "${DEFAULTS.peer.color}"
  icon: "\\U000F06A9"   # Nerd Font glyph
  side: ${DEFAULTS.peer.side}
  fold_lines: ${DEFAULTS.peer.fold_lines}
glow:
  style: ${DEFAULTS.glow.style}          # glow -s: dark | light | a style file path
`;

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
  [S in keyof Config]: { [F in keyof Config[S]]: [Check, string] };
} = {
  enabled: Object.fromEntries(RUNES.map((r) => [r, [isBool, "true | false"]])) as Record<
    Rune,
    [Check, string]
  >,
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
  return { config: out as Config, problems };
};

// rewrites only the switch's own line under `enabled:`, so comments and layout survive;
// a flow mapping is left as it is, and the caller's read-back refuses the result
export const setSwitch = (text: string, name: Rune, value: boolean): string => {
  const lines = text.split("\n");
  const head = lines.findIndex((l) => /^enabled:/.test(l));
  if (head === -1) {
    const body = text === "" || text.endsWith("\n") ? text : `${text}\n`;
    return `${body}enabled:\n  ${name}: ${value}\n`;
  }
  if (!/^enabled:\s*(#.*)?$/.test(lines[head])) return text;
  let end = head + 1;
  while (end < lines.length && !/^[^\s#]/.test(lines[end])) end++;
  const key = new RegExp(`^(\\s+${name}\\s*:\\s*)([^#]*?)(\\s*#.*)?$`);
  for (let i = head + 1; i < end; i++) {
    const m = lines[i].match(key);
    if (!m) continue;
    lines[i] = `${m[1]}${value}${m[3] ?? ""}`;
    return lines.join("\n");
  }
  const indent =
    lines
      .slice(head + 1, end)
      .find((l) => /^\s+\w/.test(l))
      ?.match(/^\s+/)?.[0] ?? "  ";
  lines.splice(head + 1, 0, `${indent}${name}: ${value}`);
  return lines.join("\n");
};
