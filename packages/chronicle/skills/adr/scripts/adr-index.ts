import { readFile, readdir } from "node:fs/promises";

export type AdrStatus =
  | "Proposed"
  | "Accepted"
  | "Superseded"
  | "Deprecated";

export type AdrMeta = {
  id: string;
  number: number;
  title: string;
  status: AdrStatus | null;
  date: string | null;
  supersedes: string[];
  supersededBy: string[];
  path: string;
  /** H2 headings present, in document order — e.g. ["Context", "Decision", "Evidence"]. */
  sections: string[];
  /** Top-level list items under `## Evidence`. 0 when the section is absent or empty. */
  evidenceEntries: number;
};

export type BrokenLink = {
  from: string;
  to: string;
  reason: "missing" | "not-mutual" | "self";
};

export type AdrIndex = {
  dir: string;
  exists: boolean;
  adrs: AdrMeta[];
  nextNumber: number;
  brokenLinks: BrokenLink[];
  /** Markdown files in the directory that `parseAdr` could not read, with why. Never dropped. */
  skipped: {
    path: string;
    reason: "no-h1" | "bad-h1" | "unreadable";
  }[];
};

type SkipReason = AdrIndex["skipped"][number]["reason"];

type ParseResult =
  | { adr: AdrMeta; reason: null }
  | { adr: null; reason: SkipReason };

const ADR_STATUSES: AdrStatus[] = [
  "Proposed",
  "Accepted",
  "Superseded",
  "Deprecated",
];

export function formatAdrId(n: number): string {
  return `ADR-${String(n).padStart(4, "0")}`;
}

export function adrFilename(n: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replaceAll(" ", "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `${String(n).padStart(4, "0")}-${slug}.md`;
}

function metadataValue(lines: string[], label: string): string | null {
  const prefix = `- ${label}:`;
  const line = lines.find((candidate) => candidate.startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : null;
}

function adrIds(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

function parseAdrResult(content: string, path: string): ParseResult {
  try {
    const lines = content.split(/\r?\n/);
    const h1 = lines.find((line) => /^# ADR-/.test(line));
    if (!h1) return { adr: null, reason: "no-h1" };

    const heading = /^# ADR-(\d{4}): (.+)$/.exec(h1);
    if (!heading) return { adr: null, reason: "bad-h1" };

    const sections: string[] = [];
    let evidenceEntries = 0;
    let inEvidence = false;
    for (const line of lines) {
      const h2 = /^##\s+(.+?)\s*$/.exec(line);
      if (h2) {
        sections.push(h2[1]);
        inEvidence = h2[1] === "Evidence";
        continue;
      }
      if (inEvidence && /^(?:[-*+] |\d+[.)] )/.test(line)) {
        evidenceEntries += 1;
      }
    }

    const statusValue = metadataValue(lines, "Status");
    const status = ADR_STATUSES.includes(statusValue as AdrStatus)
      ? (statusValue as AdrStatus)
      : null;
    const number = Number.parseInt(heading[1], 10);

    return {
      adr: {
        id: formatAdrId(number),
        number,
        title: heading[2],
        status,
        date: metadataValue(lines, "Date"),
        supersedes: adrIds(metadataValue(lines, "Supersedes")),
        supersededBy: adrIds(metadataValue(lines, "Superseded by")),
        path,
        sections,
        evidenceEntries,
      },
      reason: null,
    };
  } catch {
    return { adr: null, reason: "unreadable" };
  }
}

export function parseAdr(content: string, path: string): AdrMeta | null {
  return parseAdrResult(content, path).adr;
}

function linkIssue(
  from: AdrMeta,
  toId: string,
  reciprocalField: "supersedes" | "supersededBy",
  byId: Map<string, AdrMeta>,
): BrokenLink | null {
  if (from.id === toId) {
    return { from: from.id, to: toId, reason: "self" };
  }

  const target = byId.get(toId);
  if (!target) {
    return { from: from.id, to: toId, reason: "missing" };
  }
  if (!target[reciprocalField].includes(from.id)) {
    return { from: from.id, to: toId, reason: "not-mutual" };
  }
  return null;
}

function brokenLinks(adrs: AdrMeta[]): BrokenLink[] {
  const byId = new Map(adrs.map((adr) => [adr.id, adr]));
  const links: BrokenLink[] = [];
  const seen = new Set<string>();

  function record(issue: BrokenLink | null): void {
    if (!issue) return;
    const key = `${issue.from}\0${issue.to}\0${issue.reason}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push(issue);
  }

  for (const adr of adrs) {
    for (const to of adr.supersedes) {
      record(linkIssue(adr, to, "supersededBy", byId));
    }
    for (const to of adr.supersededBy) {
      record(linkIssue(adr, to, "supersedes", byId));
    }
  }
  return links;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

export async function buildIndex(dir: string): Promise<AdrIndex> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) {
      return {
        dir,
        exists: false,
        adrs: [],
        nextNumber: 1,
        brokenLinks: [],
        skipped: [],
      };
    }
    throw error;
  }

  const adrs: AdrMeta[] = [];
  const skipped: AdrIndex["skipped"] = [];
  const markdownFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of markdownFiles) {
    let content: string;
    try {
      content = await readFile(`${dir}/${entry.name}`, "utf8");
    } catch {
      skipped.push({ path: entry.name, reason: "unreadable" });
      continue;
    }

    const result = parseAdrResult(content, entry.name);
    if (result.adr) {
      adrs.push(result.adr);
    } else {
      // Silently dropping a file would be a file no validation rule could ever fire on. By recording it in skipped, we let the validator discover it and decide whether it is harmless (e.g., a README) or a violation (e.g., a malformed record).
      skipped.push({ path: entry.name, reason: result.reason });
    }
  }

  adrs.sort((a, b) => a.number - b.number);
  // Gaps are never reused because reusing a number would make an id ambiguous across git history.
  const nextNumber =
    adrs.length === 0 ? 1 : adrs[adrs.length - 1].number + 1;
  return {
    dir,
    exists: true,
    adrs,
    nextNumber,
    brokenLinks: brokenLinks(adrs),
    skipped,
  };
}

if (import.meta.main) {
  const index = await buildIndex(process.argv[2] ?? "docs/adr");
  console.log(JSON.stringify(index, null, 2));
}
