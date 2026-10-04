// every rune; a new rune adds its name here and its section to TEMPLATE, any settings to DEFAULTS, and gates its hooks on `config.enabled[name]`
export const RUNES = [
  "clawd",
  "transcript",
  "prompt",
  "reply",
  "bash",
  "read",
  "edit",
  "write",
  "agent",
  "skill",
  "peer",
  "minimap",
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
  read: { color: string; error_color: string; icon: string; side: Side };
  edit: {
    color: string;
    error_color: string;
    icon: string;
    side: Side;
    fold_lines: number;
  };
  write: {
    color: string;
    error_color: string;
    icon: string;
    replace_icon: string;
    side: Side;
    fold_lines: number;
  };
  agent: { color: string; error_color: string; icon: string; side: Side };
  skill: { color: string; error_color: string; icon: string; side: Side };
  peer: { color: string; icon: string; side: Side; fold_lines: number };
  glow: { style: string };
  minimap: { bar_rows: number; gap: number; marker_color: string };
};

export const DEFAULTS: Config = {
  // every rune starts on but the minimap, which re-reads the transcript every 3s and so waits to be asked for
  enabled: Object.fromEntries(RUNES.map((r) => [r, r !== "minimap"])) as Record<
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
  // nf-md-file_document U+F0219, needs a Nerd Font
  read: { color: "#6b8fb3", error_color: "#c94f4f", icon: "\u{F0219}", side: "left" },
  // nf-md-pencil U+F03EB, needs a Nerd Font
  edit: {
    color: "#b8954a",
    error_color: "#c94f4f",
    icon: "\u{F03EB}",
    side: "left",
    fold_lines: 12,
  },
  // nf-md-file_plus U+F0752, needs a Nerd Font
  write: {
    color: "#4f9a94",
    error_color: "#c94f4f",
    icon: "\u{F0752}",
    // nf-md-file_edit U+F11E7, for a Write over an existing file
    replace_icon: "\u{F11E7}",
    side: "left",
    fold_lines: 12,
  },
  // nf-md-robot_outline U+F167A, needs a Nerd Font; peer's filled robot draws the hand-back
  agent: { color: "#7f8fd1", error_color: "#c94f4f", icon: "\u{F167A}", side: "left" },
  // nf-md-arm_flex U+F0FD7, needs a Nerd Font
  skill: { color: "#d4a72c", error_color: "#c94f4f", icon: "\u{F0FD7}", side: "left" },
  // nf-md-robot U+F06A9, needs a Nerd Font
  peer: { color: "#9b7fd1", icon: "\u{F06A9}", side: "left", fold_lines: 8 },
  glow: { style: "dark" },
  // gap is the columns kept clear between the map and Clawd
  minimap: { bar_rows: 3, gap: 2, marker_color: "#ff8c00" },
};

export const configPath = (home: string) =>
  `${home}/.config/q-lab/cc-plugins/runes/config.yaml`;

// what renders read; register.tsx replaces its sections at session.start and on every /runes
export const config: Config = { ...DEFAULTS };

// only the switches are set; every other field is its default, commented, so a changed default reaches every file
export const TEMPLATE = (
  enabled: Config["enabled"],
) => `# runes — edits apply at the next session start, or right away after any /runes
# a commented field uses its default; uncomment it to change it
clawd:
  enabled: ${enabled.clawd}
transcript:
  enabled: ${enabled.transcript}    # the bubbles below need it
  prompt:
    enabled: ${enabled.prompt}    # the person's bubble
    # color: "${DEFAULTS.prompt.color}"
    # icon: "\\U000F064C"   # Nerd Font glyph
    # side: ${DEFAULTS.prompt.side}          # left | right
    # fold_lines: ${DEFAULTS.prompt.fold_lines}
  reply:
    enabled: ${enabled.reply}    # Claude's bubble
    # color: "${DEFAULTS.reply.color}"
    # icon: "\\uEC82"       # Nerd Font glyph
    # side: ${DEFAULTS.reply.side}
  bash:
    enabled: ${enabled.bash}    # Bash calls and their output
    # color: "${DEFAULTS.bash.color}"
    # error_color: "${DEFAULTS.bash.error_color}"
    # icon: "\\uF489"       # Nerd Font glyph
    # output_icon: "\\uEF11"   # Nerd Font glyph
    # side: ${DEFAULTS.bash.side}
    # fold_lines: ${DEFAULTS.bash.fold_lines}
  read:
    enabled: ${enabled.read}    # Read calls
    # color: "${DEFAULTS.read.color}"
    # error_color: "${DEFAULTS.read.error_color}"
    # icon: "\\U000F0219"   # Nerd Font glyph
    # side: ${DEFAULTS.read.side}
  edit:
    enabled: ${enabled.edit}    # Edit and Write calls, as a diff
    # color: "${DEFAULTS.edit.color}"
    # error_color: "${DEFAULTS.edit.error_color}"
    # icon: "\\U000F03EB"   # Nerd Font glyph
    # side: ${DEFAULTS.edit.side}
    # fold_lines: ${DEFAULTS.edit.fold_lines}
  write:
    enabled: ${enabled.write}    # Write calls: a new file's head, a replaced one as a diff; both fold past fold_lines
    # color: "${DEFAULTS.write.color}"
    # error_color: "${DEFAULTS.write.error_color}"
    # icon: "\\U000F0752"   # Nerd Font glyph, a new file
    # replace_icon: "\\U000F11E7"   # Nerd Font glyph, a replaced file
    # side: ${DEFAULTS.write.side}
    # fold_lines: ${DEFAULTS.write.fold_lines}
  agent:
    enabled: ${enabled.agent}    # Agent calls: the task, its totals, and its prompt and report folded
    # color: "${DEFAULTS.agent.color}"
    # error_color: "${DEFAULTS.agent.error_color}"
    # icon: "\\U000F167A"   # Nerd Font glyph
    # side: ${DEFAULTS.agent.side}
  skill:
    enabled: ${enabled.skill}    # Skill calls: the skill, its args, and a forked run's result folded
    # color: "${DEFAULTS.skill.color}"
    # error_color: "${DEFAULTS.skill.error_color}"
    # icon: "\\U000F0FD7"   # Nerd Font glyph
    # side: ${DEFAULTS.skill.side}
  peer:
    enabled: ${enabled.peer}    # subagents' and other sessions' messages
    # color: "${DEFAULTS.peer.color}"
    # icon: "\\U000F06A9"   # Nerd Font glyph
    # side: ${DEFAULTS.peer.side}
    # fold_lines: ${DEFAULTS.peer.fold_lines}
  glow:
    # style: ${DEFAULTS.glow.style}          # glow -s: dark | light | a style file path
minimap:
  enabled: ${enabled.minimap}    # the whole transcript as coloured bars left of Clawd; click the line under a bar to jump there
  # bar_rows: ${DEFAULTS.minimap.bar_rows}          # how many blocks tall the bars are
  # gap: ${DEFAULTS.minimap.gap}               # columns kept clear between the map and Clawd
  # marker_color: "${DEFAULTS.minimap.marker_color}"   # the mark for where you are
`;

// the keys at each level in the order the template writes them; the bubbles and glow live under transcript
const TOP = ["clawd", "transcript", "minimap"] as const;
const UNDER = [
  "prompt",
  "reply",
  "bash",
  "read",
  "edit",
  "write",
  "agent",
  "skill",
  "peer",
  "glow",
] as const;
type Section = Rune | "glow";
const pathOf = (s: Section): string[] =>
  (UNDER as readonly string[]).includes(s) ? ["transcript", s] : [s];

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
  read: {
    color: [isColor, "#rrggbb"],
    error_color: [isColor, "#rrggbb"],
    icon: [isText, "a glyph"],
    side: [isSide, "left | right"],
  },
  edit: {
    color: [isColor, "#rrggbb"],
    error_color: [isColor, "#rrggbb"],
    icon: [isText, "a glyph"],
    side: [isSide, "left | right"],
    fold_lines: [isCount, "a whole number above 0"],
  },
  write: {
    color: [isColor, "#rrggbb"],
    error_color: [isColor, "#rrggbb"],
    icon: [isText, "a glyph"],
    replace_icon: [isText, "a glyph"],
    side: [isSide, "left | right"],
    fold_lines: [isCount, "a whole number above 0"],
  },
  agent: {
    color: [isColor, "#rrggbb"],
    error_color: [isColor, "#rrggbb"],
    icon: [isText, "a glyph"],
    side: [isSide, "left | right"],
  },
  skill: {
    color: [isColor, "#rrggbb"],
    error_color: [isColor, "#rrggbb"],
    icon: [isText, "a glyph"],
    side: [isSide, "left | right"],
  },
  peer: {
    color: [isColor, "#rrggbb"],
    icon: [isText, "a glyph"],
    side: [isSide, "left | right"],
    fold_lines: [isCount, "a whole number above 0"],
  },
  glow: { style: [isText, "dark | light | a style file path"] },
  minimap: {
    bar_rows: [isCount, "a whole number above 0"],
    gap: [isCount, "a whole number above 0"],
    marker_color: [isColor, "#rrggbb"],
  },
};

// where a section's fields are read from and the name a problem gives it: under transcript, or where 0.5.0 kept it,
// at the top level; a nested section, even a bare one, is the one read
const sectionOf = (
  raw: Record<string, unknown>,
  s: Section,
): [string, unknown] => {
  const path = pathOf(s);
  if (path.length === 1) return [s, raw[s]];
  const t = raw.transcript;
  return isMap(t) && s in t ? [path.join("."), t[s]] : [s, raw[s]];
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
    const [name, found] = sectionOf(raw, section as Section);
    const given = isMap(found) ? found : {};
    // a section holding only comments parses to null
    if (found !== undefined && found !== null && !isMap(found))
      problems.push(`${name}: not a mapping`);
    out[section] = { ...DEFAULTS[section as keyof Config] };
    for (const [field, [check, want]] of Object.entries(
      fields as Record<string, [Check, string]>,
    )) {
      const v = given[field];
      if (v === undefined) continue;
      if (check(v)) out[section][field] = v;
      else problems.push(`${name}.${field}: ${JSON.stringify(v)} (${want})`);
    }
  }
  // the oldest files kept every switch in one top-level enabled: block; a section's own switch wins over it
  const legacy = isMap(raw.enabled) ? raw.enabled : {};
  const enabled = { ...DEFAULTS.enabled };
  for (const r of RUNES) {
    const [section, found] = sectionOf(raw, r);
    const own = isMap(found) ? found.enabled : undefined;
    const [v, name] =
      own !== undefined
        ? [own, `${section}.enabled`]
        : [legacy[r], `enabled.${r}`];
    if (v === undefined) continue;
    if (isBool(v)) enabled[r] = v as boolean;
    else problems.push(`${name}: ${JSON.stringify(v)} (true | false)`);
  }
  return { config: { ...out, enabled } as Config, problems };
};

const indentOf = (l: string) => l.length - l.trimStart().length;
const isNote = (l: string) => !l.trim() || l.trimStart().startsWith("#");

// a key's block: its header line, where the block ends (the next key at its indent or less), and the indent its keys sit at
type Block = {
  head: number;
  end: number;
  indent: number;
  inner: number;
  isOpen: boolean;
};

const blockAt = (lines: string[], head: number): Block => {
  const indent = indentOf(lines[head]!);
  let end = head + 1;
  while (
    end < lines.length &&
    (isNote(lines[end]!) || indentOf(lines[end]!) > indent)
  )
    end++;
  // a trailing blank line, or a comment no deeper than the header, belongs to whatever comes next;
  // a deeper one is a commented field of this block
  while (
    end > head + 1 &&
    isNote(lines[end - 1]!) &&
    (!lines[end - 1]!.trim() || indentOf(lines[end - 1]!) <= indent)
  )
    end--;
  const child = lines.slice(head + 1, end).find((l) => !isNote(l));
  return {
    head,
    end,
    indent,
    inner: child ? indentOf(child) : indent + 2,
    // a flow mapping (`key: { … }`) or a scalar holds no block to edit
    isOpen: /^\s*[\w-]+:\s*(#.*)?$/.test(lines[head]!),
  };
};

// finds a section by its path, each key a direct child of the one before
const locate = (lines: string[], path: string[]): Block | undefined => {
  let from = 0;
  let to = lines.length;
  let at = 0;
  let found: Block | undefined;
  for (const key of path) {
    const head = lines.findIndex(
      (l, i) =>
        i >= from &&
        i < to &&
        indentOf(l) === at &&
        !isNote(l) &&
        new RegExp(`^\\s*${key}\\s*:`).test(l),
    );
    if (head === -1) return undefined;
    found = blockAt(lines, head);
    if (!found.isOpen && key !== path.at(-1)) return undefined;
    [from, to, at] = [head + 1, found.end, found.inner];
  }
  return found;
};

// a block, written with its key at column 0, goes in under its parent before the first sibling the template writes
// after it, so the file keeps the template's order
const insertBlock = (
  lines: string[],
  parent: string[],
  key: string,
  block: string[],
): string[] => {
  const order: readonly string[] = parent.length ? UNDER : TOP;
  const later = order.slice(order.indexOf(key) + 1);
  const home = parent.length ? locate(lines, parent) : undefined;
  const [from, to, inner] = home
    ? [home.head + 1, home.end, home.inner]
    : [0, lines.length, 0];
  let at = lines.findIndex(
    (l, i) =>
      i >= from &&
      i < to &&
      indentOf(l) === inner &&
      later.some((k) => new RegExp(`^\\s*${k}\\s*:`).test(l)),
  );
  if (at === -1) at = to === lines.length && lines.at(-1) === "" ? to - 1 : to;
  const pad = " ".repeat(inner);
  return [
    ...lines.slice(0, at),
    ...block.map((l) => (l ? pad + l : l)),
    ...lines.slice(at),
  ];
};

const switchAt = (lines: string[], b: Block) =>
  lines.findIndex(
    (l, i) =>
      i > b.head &&
      i < b.end &&
      indentOf(l) === b.inner &&
      /^\s*enabled\s*:/.test(l),
  );

// rewrites only the switch's own line in its section, so comments and layout survive;
// a flow mapping is left as it is, and the caller's read-back refuses the result
export const setSwitch = (text: string, name: Rune, value: boolean): string => {
  let lines = text.split("\n");
  const path = pathOf(name);
  if (path.length === 2) {
    const parent = locate(lines, ["transcript"]);
    if (!parent)
      return insertBlock(lines, [], "transcript", [
        "transcript:",
        `  ${name}:`,
        `    enabled: ${value}`,
      ]).join("\n");
    if (!parent.isOpen) return text;
  }
  const b = locate(lines, path);
  if (!b)
    return insertBlock(lines, path.slice(0, -1), name, [
      `${name}:`,
      `  enabled: ${value}`,
    ]).join("\n");
  if (!b.isOpen) return text;
  const i = switchAt(lines, b);
  if (i !== -1) {
    lines[i] = lines[i]!.replace(
      /^(\s*enabled\s*:\s*)([^#]*?)(\s*#.*)?$/,
      `$1${value}$3`,
    );
    return lines.join("\n");
  }
  lines.splice(b.head + 1, 0, `${" ".repeat(b.inner)}enabled: ${value}`);
  return lines.join("\n");
};

// true once a parsed file has the current layout: every section nested where the template puts it, each rune's
// with its switch, and nothing left of an older layout; an addition a flow mapping or a duplicate key swallowed fails it
export const isComplete = (raw: unknown): boolean => {
  if (!isMap(raw) || raw.enabled !== undefined) return false;
  if (UNDER.some((s) => raw[s] !== undefined)) return false;
  const t = raw.transcript;
  if (!isMap(t) || !("glow" in t)) return false;
  return RUNES.every((r) => {
    const found = sectionOf(raw, r)[1];
    return isMap(found) && found.enabled !== undefined;
  });
};

// the template's own block for a section, its key at column 0
const templateBlock = (enabled: Config["enabled"], s: Section): string[] => {
  const lines = TEMPLATE(enabled).split("\n");
  const b = locate(lines, pathOf(s))!;
  return lines.slice(b.head, b.end).map((l) => l.slice(b.indent));
};

// moved by text, not rewritten from the parse, so a person's own values and comments survive each layout change
export const upgrade = (text: string, raw: unknown): string => {
  const given = raw === null || raw === undefined ? {} : raw;
  if (!isMap(given)) return text;
  const legacy = isMap(given.enabled) ? given.enabled : {};
  const carried = Object.fromEntries(
    RUNES.map((r) => [r, isBool(legacy[r]) ? legacy[r] : DEFAULTS.enabled[r]]),
  ) as Config["enabled"];
  let lines = text.split("\n");

  const old = locate(lines, ["enabled"]);
  if (old?.isOpen) lines.splice(old.head, old.end - old.head);

  if (!locate(lines, ["transcript"]))
    lines = insertBlock(
      lines,
      [],
      "transcript",
      templateBlock(carried, "transcript").slice(0, 2),
    );

  for (const s of UNDER) {
    const flat = locate(lines, [s]);
    if (!flat?.isOpen || locate(lines, ["transcript", s])) continue;
    const block = lines.slice(flat.head, flat.end);
    lines.splice(flat.head, flat.end - flat.head);
    lines = insertBlock(lines, ["transcript"], s, block);
  }

  for (const s of [...TOP, ...UNDER] as Section[]) {
    const path = pathOf(s);
    const b = locate(lines, path);
    if (!b) {
      const block = templateBlock(carried, s);
      lines = insertBlock(
        lines,
        path.slice(0, -1),
        s,
        s === "transcript" ? block.slice(0, 2) : block,
      );
    } else if (s !== "glow" && b.isOpen && switchAt(lines, b) === -1) {
      lines = setSwitch(lines.join("\n"), s, carried[s]).split("\n");
    }
  }
  return lines.join("\n");
};
