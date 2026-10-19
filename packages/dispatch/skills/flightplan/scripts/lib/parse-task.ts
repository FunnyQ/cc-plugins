export type TaskRef = {
  bucket: string;
  nn: string; // zero-padded, e.g. "01"
};

const MODEL_ROLES = ["dev", "verify", "judge", "fix"] as const;
const MODEL_NAMES = ["haiku", "sonnet", "opus", "fable"] as const;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];
export type ModelName = (typeof MODEL_NAMES)[number];
export type Effort = (typeof EFFORTS)[number];
export type ModelChoice = { model: ModelName; effort: Effort | null };
export type TaskModels = Partial<Record<ModelRole, ModelChoice>>;

export type ParsedTask = {
  bucket: string;
  nn: string;
  title: string;
  h1: string;
  requiredReading: string[];
  dependsOn: TaskRef[];
  blocks: TaskRef[];
  status: TaskStatus | null;
  finalReview: boolean;
  models: TaskModels;
  modelsRaw: string | null;
  modelErrors: string[];
  sections: string[];
  body: string;
  rubric: Rubric | null;
};

export type RubricDimension = {
  name: string;
  weight: number;
};

export type RubricHardFail = {
  dimension: string;
  op: "<" | "<=";
  value: number;
};

export type Rubric = {
  passThreshold: number;
  passOp: ">" | ">=";
  scaleMax: number;
  hardFail: RubricHardFail | null;
  dimensions: RubricDimension[];
};

export const TASK_STATUSES = [
  "todo",
  "in-progress",
  "done",
  "blocked",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

const H1_REGEX = /^#\s+([A-Z][A-Z0-9]*)-(\d{2})\s*:\s*(.+?)\s*$/;
const TASK_REF_REGEX = /([a-z][a-z0-9-]*)\/(\d{2})/g;
const STATUS_LINE_REGEX = /^(\s*>?\s*\*\*Status\*\*\s*:\s*)(.*)$/i;

export function matchStatusLine(
  line: string,
): { prefix: string; raw: string } | null {
  const match = STATUS_LINE_REGEX.exec(line);
  return match ? { prefix: match[1], raw: match[2] } : null;
}

export function parseStatusValue(raw: string): TaskStatus | null {
  const value = raw.trim().toLowerCase();
  return (TASK_STATUSES as readonly string[]).includes(value)
    ? (value as TaskStatus)
    : null;
}

export function parseModels(value: string): { models: TaskModels; errors: string[] } {
  const models: TaskModels = {};
  const errors: string[] = [];
  const roles: readonly string[] = MODEL_ROLES;
  const names: readonly string[] = MODEL_NAMES;
  const efforts: readonly string[] = EFFORTS;
  if (!value.trim()) {
    return { models, errors: ['Models entry "": malformed empty value'] };
  }

  for (const entry of value.split(",").map((piece) => piece.trim()).filter(Boolean)) {
    const match = /^([a-z]+)\s*=\s*([a-z]+)(?:\s*\/\s*([a-z]+))?$/.exec(entry);
    const prefix = `Models entry "${entry}": `;
    if (!match) {
      errors.push(`${prefix}malformed (expected role=model[/effort])`);
      continue;
    }
    const [, role, model, effort] = match;
    if (!roles.includes(role)) {
      errors.push(`${prefix}unknown role "${role}" (expected ${roles.join(", ")})`);
      continue;
    }
    if (!names.includes(model)) {
      errors.push(`${prefix}unknown model "${model}" (expected ${names.join(", ")})`);
      continue;
    }
    if (effort !== undefined && !efforts.includes(effort)) {
      errors.push(`${prefix}unknown effort "${effort}" (expected ${efforts.join(", ")})`);
      continue;
    }
    const key = role as ModelRole;
    if (models[key]) {
      errors.push(`${prefix}duplicate role "${role}"`);
      continue;
    }
    models[key] = { model: model as ModelName, effort: (effort as Effort | undefined) ?? null };
  }
  return { models, errors };
}

export function parseTask(
  content: string,
): { ok: true; task: ParsedTask } | { ok: false; reason: string } {
  const lines = content.split("\n");

  const h1Line = lines.find((l) => l.startsWith("# "));
  if (!h1Line) {
    return { ok: false, reason: "missing H1" };
  }
  const h1Match = H1_REGEX.exec(h1Line);
  if (!h1Match) {
    return {
      ok: false,
      reason: `H1 does not match \"# BUCKET-NN: Title\": ${h1Line}`,
    };
  }
  const [, bucketUpper, nn, title] = h1Match;
  const bucket = bucketUpper.toLowerCase();

  const quoteStart = lines.findIndex((l) => l.trim().startsWith(">"));
  if (quoteStart === -1) {
    return { ok: false, reason: "missing header blockquote" };
  }
  let quoteEnd = quoteStart;
  while (quoteEnd < lines.length && lines[quoteEnd].trim().startsWith(">")) {
    quoteEnd++;
  }
  const quote = lines.slice(quoteStart, quoteEnd).join("\n");
  const bodyLines = lines.slice(quoteEnd);
  const body = bodyLines.join("\n");
  const modelsRaw = extractModelsRaw(quote);
  const { models, errors: modelErrors } =
    modelsRaw === null ? { models: {}, errors: [] } : parseModels(modelsRaw);

  return {
    ok: true,
    task: {
      bucket,
      nn,
      title,
      h1: h1Line,
      requiredReading: extractRequiredReading(quote),
      dependsOn: extractRefs(quote, "Depends on"),
      blocks: extractRefs(quote, "Blocks"),
      status: extractStatus(quote),
      finalReview: extractFinalReview(quote),
      models,
      modelsRaw,
      modelErrors,
      sections: extractSections(bodyLines),
      body,
      rubric: parseRubric(body),
    },
  };
}

const RUBRIC_HEADING = "Eval rubric";

export function parseRubric(body: string): Rubric | null {
  const section = extractHeadingSection(body, RUBRIC_HEADING);
  if (section === null) return null;

  const quote = section
    .split("\n")
    .filter((l) => l.trim().startsWith(">"))
    .map((l) => l.replace(/^\s*>\s?/, ""))
    .join("\n");
  if (!quote.trim()) return null;

  const passMatch = /(>=|≥|>)\s*([0-9]+(?:\.[0-9]+)?)/.exec(quote);
  if (!passMatch) return null;
  const passOp: ">" | ">=" = passMatch[1] === ">" ? ">" : ">=";
  const passThreshold = parseFloat(passMatch[2]);

  const scaleMatch = /\b0\s*[–-]\s*([0-9]+)\b/.exec(quote);
  const scaleMax = scaleMatch ? parseInt(scaleMatch[1], 10) : 5;

  const hardMatch =
    /([\p{L}\p{N}_-]+)\s*(<=|≤|<)\s*([0-9]+(?:\.[0-9]+)?)/u.exec(quote);
  const hardFail: RubricHardFail | null = hardMatch
    ? {
        dimension: hardMatch[1],
        op: hardMatch[2] === "<" ? "<" : "<=",
        value: parseFloat(hardMatch[3]),
      }
    : null;

  const dimensions = parseRubricTable(section);
  if (dimensions.length === 0) return null;

  return { passThreshold, passOp, scaleMax, hardFail, dimensions };
}

function parseRubricTable(section: string): RubricDimension[] {
  const rows = section.split("\n").filter((l) => l.trim().startsWith("|"));
  if (rows.length < 2) return [];

  const cells = (line: string) =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());

  const header = cells(rows[0]);
  const weightCol = header.findIndex((c) => /weight/i.test(c));
  if (weightCol === -1) return [];
  const nameColGuess = header.findIndex((c) => /dimension/i.test(c));
  const nameCol = nameColGuess === -1 ? 0 : nameColGuess;

  const dims: RubricDimension[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = cells(rows[r]);
    if (row.every((c) => c === "" || /^:?-+:?$/.test(c))) continue;
    const name = (row[nameCol] ?? "").trim();
    if (!name) continue;
    const weightCell = row[weightCol] ?? "";
    const wMatch = /(\d+(?:\.\d+)?)/.exec(weightCell);
    const weight = wMatch ? parseFloat(wMatch[1]) : 0;
    if (weight <= 0) continue;
    dims.push({ name, weight });
  }
  return dims;
}

function extractHeadingSection(body: string, heading: string): string | null {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n");
}

function extractRequiredReading(quote: string): string[] {
  const required: string[] = [];
  const lines = quote.split("\n");
  let inBlock = false;

  for (const raw of lines) {
    const line = raw.replace(/^>\s?/, "");
    if (/^\*\*Required reading\*\*/i.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock) {
      const bullet = line.match(/^-\s+`([^`]+)`/);
      if (bullet) {
        required.push(bullet[1]);
        continue;
      }
      if (line.trim() && !line.trim().startsWith("-")) {
        inBlock = false;
      }
    }
  }
  return required;
}

function extractRefs(quote: string, label: string): TaskRef[] {
  const labelRegex = new RegExp(`\\*\\*${label}\\*\\*\\s*:\\s*(.+?)$`, "im");
  const lines = quote.split("\n").map((l) => l.replace(/^>\s?/, ""));
  for (const line of lines) {
    const match = labelRegex.exec(line);
    if (!match) continue;
    const value = match[1].trim();
    if (/^(none|—|-|n\/a)\b/i.test(value)) return [];
    const refs: TaskRef[] = [];
    TASK_REF_REGEX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TASK_REF_REGEX.exec(value)) !== null) {
      refs.push({ bucket: m[1], nn: m[2] });
    }
    return refs;
  }
  return [];
}

function extractStatus(quote: string): TaskStatus | null {
  const lines = quote.split("\n").map((l) => l.replace(/^>\s?/, ""));
  for (const line of lines) {
    const match = matchStatusLine(line);
    if (match) return parseStatusValue(match.raw);
  }
  return null;
}

function extractFinalReview(quote: string): boolean {
  const lines = quote.split("\n").map((l) => l.replace(/^>\s?/, ""));
  for (const line of lines) {
    if (/^\*\*Final review\*\*\s*:\s*(true|yes)\s*$/i.test(line.trim())) {
      return true;
    }
  }
  return false;
}

function extractModelsRaw(quote: string): string | null {
  const lines = quote.split("\n").map((l) => l.replace(/^>\s?/, ""));
  for (const line of lines) {
    const match = /^\*\*Models\*\*\s*:\s*(.*)$/.exec(line.trim());
    if (match) return match[1].trim();
  }
  return null;
}

function extractSections(bodyLines: string[]): string[] {
  return bodyLines
    .filter((l) => /^##\s+/.test(l))
    .map((l) => l.replace(/^##\s+/, "").trim());
}

export function refToString(ref: TaskRef): string {
  return `${ref.bucket}/${ref.nn}`;
}

export const GATE_SECTIONS = ["Acceptance criteria", "Verification"] as const;

export function uncheckedGateItems(body: string): string[] {
  const unchecked: string[] = [];
  for (const heading of GATE_SECTIONS) {
    const section = extractHeadingSection(body, heading);
    if (section === null) continue;
    for (const line of section.split("\n")) {
      const item = /^\s*[-*]\s+\[ \]\s*(.*)$/.exec(line);
      if (item) unchecked.push(`${heading}: ${item[1].trim()}`);
    }
  }
  return unchecked;
}

export const COMPLETION_STATE_FIX =
  "Do NOT tick the boxes by hand — that fakes a gate that never ran. Reset `> **Status**:` to `in-progress` or `todo`, then rerun the task's gates. Only mark-done.ts may write `done`, and it ticks the boxes in the same step.";

export type TaskValidity =
  | { kind: "unfinished"; status: Exclude<TaskStatus, "done"> }
  | { kind: "complete" }
  | { kind: "invalid"; rule: "status" | "completion-state"; reason: string };

export function taskValidity(task: ParsedTask): TaskValidity {
  if (task.status === null) {
    return {
      kind: "invalid",
      rule: "status",
      reason:
        "Status missing or not one of todo/in-progress/done/blocked — write the value bare, with run notes on their own line",
    };
  }
  if (task.status !== "done") {
    return { kind: "unfinished", status: task.status };
  }
  const unchecked = uncheckedGateItems(task.body);
  if (unchecked.length > 0) {
    return {
      kind: "invalid",
      rule: "completion-state",
      reason: `Status is done but ${unchecked.length} gate checkbox(es) are still unticked — ${unchecked.join("; ")}. ${COMPLETION_STATE_FIX}`,
    };
  }
  return { kind: "complete" };
}
