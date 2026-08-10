import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { validateDir, validateOne } from "./adr-validate";

const scriptPath = join(import.meta.dir, "adr-validate.ts");
const tempDirs: string[] = [];

function adr(
  overrides: {
    id?: string;
    status?: string | null;
    date?: string | null;
    links?: string;
    sections?: string[];
    evidence?: string;
    prose?: string;
  } = {},
): string {
  const sections = overrides.sections ?? [
    "Context",
    "Considered alternatives",
    "Decision",
    "Consequences",
    "Evidence",
  ];
  const metadata = [
    overrides.status === null
      ? null
      : `- Status: ${overrides.status ?? "Accepted"}`,
    overrides.date === null
      ? null
      : `- Date: ${overrides.date ?? "2026-08-06"}`,
    overrides.links,
  ]
    .filter(Boolean)
    .join("\n");

  return `# ${overrides.id ?? "ADR-0001"}: Example decision

${metadata}

${sections
  .map(
    (section) =>
      `## ${section}\n\n${
        section === "Evidence"
          ? (overrides.evidence ?? "- Verified")
          : section === "Context"
            ? (overrides.prose ?? "Text.")
            : "Text."
      }`,
  )
  .join("\n\n")}
`;
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "chronicle-adr-validate-"));
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

async function runCli(args: string[]): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  const child = Bun.spawn({
    cmd: [process.execPath, scriptPath, ...args],
    cwd: dirname(scriptPath),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    child.stdout.text(),
    child.stderr.text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("validateOne", () => {
  test("accepts a valid ADR", () => {
    expect(validateOne(adr(), "/tmp/0001-example-decision.md")).toEqual([]);
  });

  test("reports filename", () => {
    expect(
      validateOne(adr(), "1 Example.md").map((item) => item.rule),
    ).toContain("filename");
  });

  test("reports id-mismatch for a different id", () => {
    expect(
      validateOne(adr({ id: "ADR-0002" }), "0001-example.md"),
    ).toContainEqual(expect.objectContaining({ rule: "id-mismatch" }));
  });

  test("reports only id-mismatch after an unparseable H1", () => {
    expect(validateOne("# Broken\n", "0001-broken.md")).toEqual([
      expect.objectContaining({ rule: "id-mismatch" }),
    ]);
  });

  test("reports each missing-section with its heading", () => {
    const violations = validateOne(
      adr({ sections: ["Context", "Evidence"] }),
      "0001-example.md",
    ).filter((item) => item.rule === "missing-section");

    expect(violations.map((item) => item.detail)).toEqual([
      "Considered alternatives",
      "Decision",
      "Consequences",
    ]);
  });

  test("reports bad-status when absent or invalid", () => {
    expect(
      validateOne(adr({ status: null }), "0001-example.md"),
    ).toContainEqual(expect.objectContaining({ rule: "bad-status" }));
    expect(
      validateOne(adr({ status: "accepted" }), "0001-example.md"),
    ).toContainEqual(expect.objectContaining({ rule: "bad-status" }));
  });

  test("reports bad-date when absent or malformed", () => {
    expect(validateOne(adr({ date: null }), "0001-example.md")).toContainEqual(
      expect.objectContaining({ rule: "bad-date" }),
    );
    expect(
      validateOne(adr({ date: "August 6" }), "0001-example.md"),
    ).toContainEqual(expect.objectContaining({ rule: "bad-date" }));
  });

  test("reports bad-date for a YYYY-MM-DD string that is not a real date", () => {
    for (const date of [
      "2026-99-99",
      "2025-02-30",
      "2026-00-10",
      "2026-13-01",
    ]) {
      expect(validateOne(adr({ date }), "0001-example.md")).toContainEqual(
        expect.objectContaining({ rule: "bad-date" }),
      );
    }
  });

  test("accepts a leap day and a month boundary", () => {
    for (const date of ["2024-02-29", "2026-01-31", "2026-12-31"]) {
      expect(validateOne(adr({ date }), "0001-example-decision.md")).toEqual(
        [],
      );
    }
  });

  test("reports superseded-no-link", () => {
    expect(
      validateOne(adr({ status: "Superseded" }), "0001-example.md"),
    ).toContainEqual(expect.objectContaining({ rule: "superseded-no-link" }));
  });

  test("reports deprecated-linked", () => {
    expect(
      validateOne(
        adr({
          status: "Deprecated",
          links: "- Superseded by: ADR-0002",
        }),
        "0001-example.md",
      ),
    ).toContainEqual(expect.objectContaining({ rule: "deprecated-linked" }));
  });

  test("reports self-link from either lifecycle field only once", () => {
    const violations = validateOne(
      adr({
        links: "- Supersedes: ADR-0001\n- Superseded by: ADR-0001",
      }),
      "0001-example.md",
    ).filter((item) => item.rule === "self-link");

    expect(violations).toHaveLength(1);
  });

  test("reports empty-evidence as a warning", () => {
    expect(
      validateOne(adr({ evidence: "No entries." }), "0001-example.md"),
    ).toContainEqual(
      expect.objectContaining({ rule: "empty-evidence", severity: "warning" }),
    );
  });
});

describe("validateDir", () => {
  test("accepts an empty directory", async () => {
    expect(await validateDir(await tempDir())).toEqual({
      checked: 0,
      violations: [],
      ok: true,
    });
  });

  test("accepts a missing directory", async () => {
    const dir = join(await tempDir(), "missing");
    expect(await validateDir(dir)).toEqual({
      checked: 0,
      violations: [],
      ok: true,
    });
  });

  test("reports skipped malformed files but exempts README.md", async () => {
    const dir = await tempDir();
    await writeAdr(dir, "README.md", "## Records\n");
    await writeAdr(dir, "0001-broken.md", "# Broken\n");

    expect((await validateDir(dir)).violations).toEqual([
      expect.objectContaining({ path: "0001-broken.md", rule: "id-mismatch" }),
    ]);
  });

  test("reports link-missing", async () => {
    const dir = await tempDir();
    await writeAdr(
      dir,
      "0001-example.md",
      adr({ links: "- Supersedes: ADR-0099" }),
    );

    expect((await validateDir(dir)).violations).toContainEqual(
      expect.objectContaining({ rule: "link-missing" }),
    );
  });

  test("reports link-not-mutual", async () => {
    const dir = await tempDir();
    await writeAdr(
      dir,
      "0001-first.md",
      adr({ id: "ADR-0001", links: "- Superseded by: ADR-0002" }),
    );
    await writeAdr(dir, "0002-second.md", adr({ id: "ADR-0002" }));

    expect((await validateDir(dir)).violations).toContainEqual(
      expect.objectContaining({ rule: "link-not-mutual" }),
    );
  });

  test("reports stale-prose-ref as a warning naming the dead id", async () => {
    const dir = await tempDir();
    await writeAdr(
      dir,
      "0001-example.md",
      adr({ prose: "The wait cap (ADR-0099) already ruled this out." }),
    );

    const result = await validateDir(dir);

    expect(result.ok).toBe(true);
    expect(result.violations).toContainEqual(
      expect.objectContaining({
        rule: "stale-prose-ref",
        severity: "warning",
        detail: "ADR-0001 mentions ADR-0099, which does not exist.",
      }),
    );
  });

  test("stays silent on a prose reference to a record that exists", async () => {
    const dir = await tempDir();
    await writeAdr(
      dir,
      "0001-first.md",
      adr({
        id: "ADR-0001",
        prose: "Plugins never import each other (ADR-0002).",
      }),
    );
    await writeAdr(dir, "0002-second.md", adr({ id: "ADR-0002" }));

    expect((await validateDir(dir)).violations).not.toContainEqual(
      expect.objectContaining({ rule: "stale-prose-ref" }),
    );
  });

  test("leaves a dead lifecycle link to link-missing alone", async () => {
    const dir = await tempDir();
    await writeAdr(
      dir,
      "0001-example.md",
      adr({ links: "- Supersedes: ADR-0099" }),
    );

    const rules = (await validateDir(dir)).violations.map((item) => item.rule);

    expect(rules).toContain("link-missing");
    expect(rules).not.toContain("stale-prose-ref");
  });

  test("ignores a record's own id in prose", async () => {
    const dir = await tempDir();
    await writeAdr(
      dir,
      "0001-example.md",
      adr({ prose: "ADR-0001 replaces the hand-built page." }),
    );

    expect((await validateDir(dir)).violations).not.toContainEqual(
      expect.objectContaining({ rule: "stale-prose-ref" }),
    );
  });

  test("warnings do not make the result fail", async () => {
    const dir = await tempDir();
    await writeAdr(dir, "0001-example.md", adr({ evidence: "No entries." }));

    expect(await validateDir(dir)).toEqual(
      expect.objectContaining({
        checked: 1,
        ok: true,
        violations: [
          expect.objectContaining({
            rule: "empty-evidence",
            severity: "warning",
          }),
        ],
      }),
    );
  });
});

describe("--file", () => {
  test("does not apply cross-file missing-link validation", async () => {
    const dir = await tempDir();
    const path = join(dir, "0001-example.md");
    await writeFile(path, adr({ links: "- Superseded by: ADR-0099" }));

    const result = await runCli(["--file", path]);

    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("link-missing");
    expect(result.exitCode).toBe(0);
  });

  test("still applies self-link validation", async () => {
    const dir = await tempDir();
    const path = join(dir, "0001-example.md");
    await writeFile(path, adr({ links: "- Supersedes: ADR-0001" }));

    const result = await runCli(["--file", path]);

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("0001-example.md:self-link:");
    expect(result.exitCode).toBe(1);
  });
});
