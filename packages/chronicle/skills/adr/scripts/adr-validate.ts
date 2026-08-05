#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  adrFilename,
  buildIndex,
  formatAdrId,
  parseAdr,
  type AdrMeta,
} from "./adr-index";

export type Severity = "error" | "warning";

export type Violation = {
  rule:
    | "filename"
    | "id-mismatch"
    | "missing-section"
    | "bad-status"
    | "bad-date"
    | "superseded-no-link"
    | "deprecated-linked"
    | "link-missing"
    | "link-not-mutual"
    | "self-link"
    | "empty-evidence"
    | "unreadable";
  severity: Severity;
  path: string;
  detail: string;
};

export type ValidateResult = {
  checked: number;
  violations: Violation[];
  ok: boolean;
};

// adr-index.ts owns filename construction; this expression validates its kebab-case output shape.
const ADR_FILENAME = /^\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const REQUIRED_SECTIONS = [
  "Context",
  "Considered alternatives",
  "Decision",
  "Consequences",
  "Evidence",
];

function violation(
  rule: Violation["rule"],
  path: string,
  detail: string,
  severity: Severity = "error",
): Violation {
  return { rule, severity, path, detail };
}

function filenameViolations(filename: string): Violation[] {
  if (ADR_FILENAME.test(filename)) return [];
  return [
    violation(
      "filename",
      filename,
      `Expected ${adrFilename(1, "kebab title").replace("0001", "NNNN")}.`,
    ),
  ];
}

// A calendar round-trip, not just the YYYY-MM-DD shape: 2026-99-99 and 2025-02-30
// match the pattern and do not exist, and a validator that passes them reports
// success on already-corrupt metadata.
function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** Pure. Every rule an already-parsed record can answer without reading its siblings. */
export function validateMeta(adr: AdrMeta, filename: string): Violation[] {
  const violations = filenameViolations(filename);
  const filenameMatch = /^(\d{4})-/.exec(filename);

  if (filenameMatch) {
    const filenameId = formatAdrId(Number.parseInt(filenameMatch[1], 10));
    if (filenameId !== adr.id) {
      violations.push(
        violation(
          "id-mismatch",
          filename,
          `Filename id ${filenameId} does not match H1 id ${adr.id}.`,
        ),
      );
    }
  }

  for (const section of REQUIRED_SECTIONS) {
    if (!adr.sections.includes(section)) {
      violations.push(violation("missing-section", filename, section));
    }
  }

  if (adr.status === null) {
    violations.push(
      violation(
        "bad-status",
        filename,
        "Status must be Accepted, Proposed, Superseded, or Deprecated.",
      ),
    );
  }

  if (adr.date === null || !isCalendarDate(adr.date)) {
    violations.push(
      violation("bad-date", filename, "Date must be a real YYYY-MM-DD date."),
    );
  }

  if (adr.status === "Superseded" && adr.supersededBy.length === 0) {
    violations.push(
      violation(
        "superseded-no-link",
        filename,
        "A Superseded ADR must name its successor.",
      ),
    );
  }

  if (adr.status === "Deprecated" && adr.supersededBy.length > 0) {
    violations.push(
      violation(
        "deprecated-linked",
        filename,
        "A Deprecated ADR must not name a successor.",
      ),
    );
  }

  if ([...adr.supersedes, ...adr.supersededBy].includes(adr.id)) {
    violations.push(
      violation("self-link", filename, `${adr.id} references itself.`),
    );
  }

  if (adr.evidenceEntries === 0) {
    // Hand-written ADRs may have nothing to cite; failing them would encourage invented evidence.
    violations.push(
      violation(
        "empty-evidence",
        filename,
        "Evidence must contain a top-level list item.",
        "warning",
      ),
    );
  }

  return violations;
}

/** Pure. Parses one record, then applies every rule that needs no directory context. */
export function validateOne(content: string, path: string): Violation[] {
  const filename = basename(path);
  const adr = parseAdr(content, path);
  if (!adr) {
    return [
      ...filenameViolations(filename),
      violation("id-mismatch", filename, "The ADR H1 is missing or malformed."),
    ];
  }

  return validateMeta(adr, filename);
}

function toResult(checked: number, violations: Violation[]): ValidateResult {
  return {
    checked,
    violations,
    ok: violations.every((item) => item.severity !== "error"),
  };
}

/** Adds the cross-file link rules on top of validateMeta. */
export async function validateDir(dir: string): Promise<ValidateResult> {
  const index = await buildIndex(dir);
  const violations: Violation[] = [];

  // buildIndex already read and parsed every record. Re-reading them here cost a
  // second disk read and a second parse per file for information already in hand.
  for (const adr of index.adrs) {
    violations.push(...validateMeta(adr, adr.path));
  }

  for (const skipped of index.skipped) {
    if (skipped.path === "README.md") continue;
    const rule = skipped.reason === "unreadable" ? "unreadable" : "id-mismatch";
    violations.push(
      violation(
        rule,
        skipped.path,
        `Index skipped this file: ${skipped.reason}.`,
      ),
    );
  }

  const pathById = new Map(index.adrs.map((adr) => [adr.id, adr.path]));
  for (const link of index.brokenLinks) {
    if (link.reason === "self") continue;
    const rule = link.reason === "missing" ? "link-missing" : "link-not-mutual";
    violations.push(
      violation(
        rule,
        pathById.get(link.from) ?? link.from,
        `${link.from} references ${link.to}.`,
      ),
    );
  }

  return toResult(index.adrs.length, violations);
}

async function main(): Promise<void> {
  const fileIndex = Bun.argv.indexOf("--file");
  let result: ValidateResult;

  // --file skips sibling-dependent link rules, while validateOne still catches self-links from the record alone.
  if (fileIndex !== -1) {
    const path = Bun.argv[fileIndex + 1];
    if (!path) throw new Error("Missing required --file <path>");
    result = toResult(1, validateOne(await readFile(path, "utf8"), path));
  } else {
    result = await validateDir(Bun.argv[2] ?? "docs/adr");
  }

  for (const item of result.violations) {
    console.log(`${item.path}:${item.rule}: ${item.detail}`);
  }
  process.exitCode = result.ok ? 0 : 1;
}

if (import.meta.main) {
  await main();
}
