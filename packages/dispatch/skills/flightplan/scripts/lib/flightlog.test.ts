import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatEntry,
  parseLog,
  renderRunlog,
  ensureFlightlogDir,
  appendEntry,
  type FlightlogEntry,
  type ScoreEntry,
  type NoteEntry,
} from "./flightlog";

async function newDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "flightlog-"));
}

const SCORE: ScoreEntry = {
  kind: "score",
  ts: "2026-06-01T10:00:00.000Z",
  task: "ui/03",
  attempt: 2,
  agentLabel: "judge-ui-03-a2",
  weighted: 4.4,
  passed: true,
  hardFailed: false,
  missing: [],
  threshold: 4.0,
  passOp: ">",
  breakdown: [
    { name: "正確性", weight: 3, score: 5 },
    { name: "測試涵蓋", weight: 2, score: 4 },
  ],
};

const NOTE: NoteEntry = {
  kind: "note",
  ts: "2026-06-01T09:59:00.000Z",
  task: "ui/03",
  role: "dev",
  attempt: 2,
  agentLabel: "dev-ui-03-a2",
  message: "Fixed the boundary case the judge flagged.",
};

describe("formatEntry / parseLog", () => {
  test("formatEntry is a single newline-free JSON line", () => {
    const line = formatEntry(SCORE);
    expect(line).not.toContain("\n");
    expect(JSON.parse(line).task).toBe("ui/03");
  });

  test("parseLog round-trips entries and tolerates blank lines", () => {
    const content = [formatEntry(NOTE), "", formatEntry(SCORE), ""].join("\n");
    const entries = parseLog(content);
    expect(entries).toHaveLength(2);
    expect(entries[0].kind).toBe("note");
    expect(entries[1].kind).toBe("score");
  });

  test("parseLog skips malformed lines rather than throwing", () => {
    const content = [formatEntry(NOTE), "{not json", formatEntry(SCORE)].join(
      "\n",
    );
    const entries = parseLog(content);
    expect(entries).toHaveLength(2);
  });
});

describe("renderRunlog", () => {
  test("groups entries by task in chronological order", () => {
    const md = renderRunlog([NOTE, SCORE], { slug: "demo" });
    expect(md).toContain("# Run log — demo");
    expect(md).toContain("## ui/03");
    // note (09:59) appears before score (10:00)
    expect(md.indexOf("Fixed the boundary")).toBeLessThan(md.indexOf("4.4"));
  });

  test("renders a PASS verdict with the agent label for drill-down", () => {
    const md = renderRunlog([SCORE], { slug: "demo" });
    expect(md).toMatch(/PASS/i);
    expect(md).toContain("judge-ui-03-a2");
  });

  test("renders a FAIL verdict and flags a hard-fail veto", () => {
    const failed: ScoreEntry = {
      ...SCORE,
      passed: false,
      hardFailed: true,
      weighted: 3.9,
    };
    const md = renderRunlog([failed], { slug: "demo" });
    expect(md).toMatch(/FAIL/i);
    expect(md).toMatch(/veto|否決/i);
  });

  test("separates multiple tasks under their own headings", () => {
    const other: NoteEntry = { ...NOTE, task: "backend/01" };
    const md = renderRunlog([NOTE, other], { slug: "demo" });
    expect(md).toContain("## ui/03");
    expect(md).toContain("## backend/01");
  });
});

describe("ensureFlightlogDir", () => {
  test("creates .flightlog/ with a self-ignoring .gitignore", async () => {
    const root = await newDir();
    const dir = await ensureFlightlogDir(root);
    expect(dir).toBe(join(root, ".flightlog"));
    const gi = await readFile(join(dir, ".gitignore"), "utf-8");
    expect(gi.trim()).toBe("*");
    await rm(root, { recursive: true });
  });

  test("is idempotent — does not clobber an existing .gitignore", async () => {
    const root = await newDir();
    await ensureFlightlogDir(root);
    const dir = await ensureFlightlogDir(root);
    const gi = await readFile(join(dir, ".gitignore"), "utf-8");
    expect(gi.trim()).toBe("*");
    await rm(root, { recursive: true });
  });
});

describe("appendEntry", () => {
  test("appends JSONL lines without overwriting prior entries", async () => {
    const root = await newDir();
    const logFile = join(root, ".flightlog", "run.jsonl");
    await appendEntry(logFile, NOTE);
    await appendEntry(logFile, SCORE);
    const entries = parseLog(await readFile(logFile, "utf-8"));
    expect(entries).toHaveLength(2);
    await rm(root, { recursive: true });
  });

  test("creates the parent dir and a self-ignore when logging into .flightlog/", async () => {
    const root = await newDir();
    const logFile = join(root, ".flightlog", "run.jsonl");
    await appendEntry(logFile, SCORE);
    const gi = await readFile(join(root, ".flightlog", ".gitignore"), "utf-8");
    expect(gi.trim()).toBe("*");
    await rm(root, { recursive: true });
  });

  test("works when the parent dir is not named .flightlog (no .gitignore forced)", async () => {
    const root = await newDir();
    const logFile = join(root, "logs", "run.jsonl");
    await appendEntry(logFile, SCORE);
    const s = await stat(logFile);
    expect(s.isFile()).toBe(true);
    await expect(stat(join(root, "logs", ".gitignore"))).rejects.toThrow();
    await rm(root, { recursive: true });
  });
});
