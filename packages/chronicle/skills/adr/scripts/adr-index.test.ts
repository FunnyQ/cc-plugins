import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adrFilename, buildIndex, formatAdrId, parseAdr } from "./adr-index";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "chronicle-adr-index-"));
  tempDirs.push(dir);
  return dir;
}

async function writeAdr(
  dir: string,
  filename: string,
  content: string,
): Promise<void> {
  await writeFile(join(dir, filename), content);
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("formatAdrId", () => {
  test("pads ADR numbers to four digits", () => {
    expect(formatAdrId(1)).toBe("ADR-0001");
    expect(formatAdrId(42)).toBe("ADR-0042");
  });
});

describe("adrFilename", () => {
  test("applies the specified title slug rules", () => {
    expect(adrFilename(1, "Cockpit trail is an inbox")).toBe(
      "0001-cockpit-trail-is-an-inbox.md",
    );
    expect(adrFilename(12, "  API: Ready -- Now!  ")).toBe(
      "0012-api-ready-now.md",
    );
  });
});

describe("parseAdr", () => {
  test("parses metadata, H2 sections, and top-level evidence entries", () => {
    const adr = parseAdr(
      `# ADR-0002: ADR status reports implementation state

- Status: Accepted
- Date: 2026-08-06
- Supersedes: ADR-0001, ADR-0003
- Superseded by: ADR-0007

## Context

Text.

## Evidence

- First entry
  - Nested entry
1. Second entry

### Detail

* Third entry

## Decision
`,
      "0002-status.md",
    );

    expect(adr).toEqual({
      id: "ADR-0002",
      number: 2,
      title: "ADR status reports implementation state",
      status: "Accepted",
      date: "2026-08-06",
      supersedes: ["ADR-0001", "ADR-0003"],
      supersededBy: ["ADR-0007"],
      path: "0002-status.md",
      sections: ["Context", "Evidence", "Decision"],
      evidenceEntries: 3,
    });
  });

  test("uses null and empty defaults for missing or unrecognized metadata", () => {
    expect(
      parseAdr("# ADR-0001: Minimal\n\n- Status: accepted\n", "a.md"),
    ).toEqual({
      id: "ADR-0001",
      number: 1,
      title: "Minimal",
      status: null,
      date: null,
      supersedes: [],
      supersededBy: [],
      path: "a.md",
      sections: [],
      evidenceEntries: 0,
    });
  });

  test("rejects missing and malformed H1 headings", () => {
    expect(parseAdr("## Context\n", "no-h1.md")).toBeNull();
    expect(parseAdr("# Decision record\n", "bad-h1.md")).toBeNull();
  });
});

describe("buildIndex", () => {
  test("returns the empty shape for a missing directory", async () => {
    const parent = await tempDir();
    const dir = join(parent, "missing");

    expect(await buildIndex(dir)).toEqual({
      dir,
      exists: false,
      adrs: [],
      nextNumber: 1,
      brokenLinks: [],
      skipped: [],
    });
  });

  test("returns the empty shape for an empty directory", async () => {
    const dir = await tempDir();

    expect(await buildIndex(dir)).toEqual({
      dir,
      exists: true,
      adrs: [],
      nextNumber: 1,
      brokenLinks: [],
      skipped: [],
    });
  });

  test("keeps stray Markdown files in skipped with a reason", async () => {
    const dir = await tempDir();
    await writeAdr(dir, "README.md", "## ADRs\n");
    await writeAdr(dir, "malformed.md", "# ADR-4: Broken\n");

    expect((await buildIndex(dir)).skipped).toEqual([
      { path: "malformed.md", reason: "bad-h1" },
      { path: "README.md", reason: "no-h1" },
    ]);
  });

  test("sorts ADRs and advances past numbering gaps", async () => {
    const dir = await tempDir();
    await writeAdr(dir, "0004-b.md", "# ADR-0004: B\n");
    await writeAdr(dir, "0001-a.md", "# ADR-0001: A\n");

    const index = await buildIndex(dir);

    expect(index.adrs.map((adr) => adr.number)).toEqual([1, 4]);
    expect(index.nextNumber).toBe(5);
  });

  test("ignores non-Markdown files and subdirectories", async () => {
    const dir = await tempDir();
    await writeAdr(dir, "0001-a.md", "# ADR-0001: A\n");
    await writeAdr(dir, "0002-b.txt", "# ADR-0002: B\n");
    await mkdir(join(dir, "0003-c.md"));

    const index = await buildIndex(dir);

    expect(index.adrs.map((adr) => adr.id)).toEqual(["ADR-0001"]);
    expect(index.skipped).toEqual([]);
  });

  test("reports one-directional supersession as not mutual", async () => {
    const dir = await tempDir();
    await writeAdr(dir, "0001-a.md", "# ADR-0001: A\n");
    await writeAdr(
      dir,
      "0002-b.md",
      "# ADR-0002: B\n\n- Supersedes: ADR-0001\n",
    );

    expect((await buildIndex(dir)).brokenLinks).toEqual([
      { from: "ADR-0002", to: "ADR-0001", reason: "not-mutual" },
    ]);
  });

  test("accepts reciprocal supersession links", async () => {
    const dir = await tempDir();
    await writeAdr(
      dir,
      "0001-a.md",
      "# ADR-0001: A\n\n- Superseded by: ADR-0002\n",
    );
    await writeAdr(
      dir,
      "0002-b.md",
      "# ADR-0002: B\n\n- Supersedes: ADR-0001\n",
    );

    expect((await buildIndex(dir)).brokenLinks).toEqual([]);
  });

  test("reports references to missing ADRs", async () => {
    const dir = await tempDir();
    await writeAdr(
      dir,
      "0002-b.md",
      "# ADR-0002: B\n\n- Supersedes: ADR-0099\n",
    );

    expect((await buildIndex(dir)).brokenLinks).toEqual([
      { from: "ADR-0002", to: "ADR-0099", reason: "missing" },
    ]);
  });

  test("reports self references", async () => {
    const dir = await tempDir();
    await writeAdr(
      dir,
      "0002-b.md",
      "# ADR-0002: B\n\n- Supersedes: ADR-0002\n",
    );

    expect((await buildIndex(dir)).brokenLinks).toEqual([
      { from: "ADR-0002", to: "ADR-0002", reason: "self" },
    ]);
  });
});
