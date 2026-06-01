/**
 * Parser for flightplan task files.
 *
 * Task file shape (excerpt):
 *
 *   # UI-01: Fixture state shell
 *
 *   > **Required reading**:
 *   > - `../_context/shared.md`
 *   > - `../_context/api-contract.md`
 *   >
 *   > **Depends on**: ui/02, backend/01
 *   > **Blocks**: ui/05
 *   > **Status**: todo
 *
 *   ## Goal
 *   ...
 */

export type TaskRef = {
  bucket: string;
  nn: string; // zero-padded, e.g. "01"
};

export type ParsedTask = {
  /** Bucket directory name as found in the path (e.g. "ui"). */
  bucket: string;
  /** Two-digit zero-padded sequence (e.g. "01"). */
  nn: string;
  /** Title from the H1, e.g. "Fixture state shell". */
  title: string;
  /** Raw H1 line for diagnostics. */
  h1: string;
  /** Required reading paths as written in the file (kept relative). */
  requiredReading: string[];
  /** Tasks this depends on. */
  dependsOn: TaskRef[];
  /** Tasks this blocks (optional). */
  blocks: TaskRef[];
  /** Status value, lowercased. */
  status: TaskStatus | null;
  /** Section headings present in the body (e.g. ["Goal", "Acceptance criteria"]). */
  sections: string[];
  /** Body text after the header blockquote, used by self-containment checks. */
  body: string;
  /** Parsed `## Eval rubric`, or null if absent / unparseable. */
  rubric: Rubric | null;
};

export type RubricDimension = {
  /** Dimension name as written, e.g. "正確性" / "correctness". */
  name: string;
  /** Weight multiplier (the `×N` value). Always > 0. */
  weight: number;
};

export type RubricHardFail = {
  /** Dimension that vetoes the whole task when below `value`. */
  dimension: string;
  op: "<" | "<=";
  value: number;
};

export type Rubric = {
  /** Weighted-average pass line, e.g. 4.0. */
  passThreshold: number;
  /** Comparison operator on the pass line. */
  passOp: ">" | ">=";
  /** Top of the scoring scale (e.g. 5 for "0–5"). Defaults to 5. */
  scaleMax: number;
  /** Optional veto: a dimension below `value` fails regardless of the average. */
  hardFail: RubricHardFail | null;
  /** Weighted dimensions from the rubric table (weight > 0 only). */
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

/**
 * Parse a task-file string into structured fields.
 * Returns null + a reason if the file is too malformed to parse.
 */
export function parseTask(
  content: string,
): { ok: true; task: ParsedTask } | { ok: false; reason: string } {
  const lines = content.split("\n");

  // H1
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

  // Find header blockquote — contiguous lines that start with ">"
  const quoteStart = lines.findIndex((l) => l.trim().startsWith(">"));
  if (quoteStart === -1) {
    return { ok: false, reason: "missing header blockquote" };
  }
  let quoteEnd = quoteStart;
  while (quoteEnd < lines.length && lines[quoteEnd].trim().startsWith(">")) {
    quoteEnd++;
  }
  const quote = lines.slice(quoteStart, quoteEnd).join("\n");

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
      sections: extractSections(lines.slice(quoteEnd)),
      body: lines.slice(quoteEnd).join("\n"),
      rubric: parseRubric(lines.slice(quoteEnd).join("\n")),
    },
  };
}

const RUBRIC_HEADING = "Eval rubric";

/**
 * Parse a `## Eval rubric` section into structured form. Pure string parsing —
 * no YAML/markdown dependency. Returns null when the section is missing, has no
 * `>`-quoted pass-threshold line, or has no weighted dimension table.
 *
 * The contract is operator-anchored (language-neutral): the pass line carries a
 * `>` / `>=` / `≥` comparison; an optional veto carries `<dim> < N` (`<` / `≤`).
 */
export function parseRubric(body: string): Rubric | null {
  const section = extractHeadingSection(body, RUBRIC_HEADING);
  if (section === null) return null;

  // Threshold/scale/veto all live on the `>`-quoted line(s) — parse them there
  // so the dimension table's "0–1 / 2–3 / 4–5" header cells can't contaminate
  // the scale or threshold reads.
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

/** Pull the weighted dimensions out of the rubric's markdown table. */
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
  const weightCol = header.findIndex((c) => /權重|weight/i.test(c));
  if (weightCol === -1) return [];
  const nameColGuess = header.findIndex((c) => /維度|dimension/i.test(c));
  const nameCol = nameColGuess === -1 ? 0 : nameColGuess;

  const dims: RubricDimension[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = cells(rows[r]);
    // Skip the markdown separator row (|---|:--:|...).
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

/** Return the text under a `## Heading`, or null if the heading is absent. */
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
      // End of bulleted block once we hit a non-bullet, non-empty line
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
    // Anchor the trailing $ so trailing junk like "todo maybe" or
    // "todo | in-progress | done" is rejected, not silently treated as todo.
    const match = /^\*\*Status\*\*\s*:\s*([a-z-]+)\s*$/i.exec(line);
    if (match) {
      const value = match[1].toLowerCase() as TaskStatus;
      return (TASK_STATUSES as readonly string[]).includes(value)
        ? value
        : null;
    }
  }
  return null;
}

function extractSections(bodyLines: string[]): string[] {
  return bodyLines
    .filter((l) => /^##\s+/.test(l))
    .map((l) => l.replace(/^##\s+/, "").trim());
}

/** Format a task ref as "bucket/NN". */
export function refToString(ref: TaskRef): string {
  return `${ref.bucket}/${ref.nn}`;
}
