import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatEntry,
  parseLog,
  renderRunlog,
  appendEntry,
  type FlightlogEntry,
  type ScoreEntry,
  type NoteEntry,
  type StateEntry,
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
    { name: "Correctness", weight: 3, score: 5 },
    { name: "Test coverage", weight: 2, score: 4 },
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

  test("parseLog skips malformed lines rather than throwing, so a trail cut mid-write still reads", () => {
    const content = [formatEntry(NOTE), "{not json", formatEntry(SCORE)].join(
      "\n",
    );
    const entries = parseLog(content);
    expect(entries).toHaveLength(2);
  });

  test("parseLog accepts phase entries and legacy notes without phase", () => {
    const start: NoteEntry = { ...NOTE, phase: "start", message: "" };
    const entries = parseLog(
      [formatEntry(start), formatEntry(NOTE)].join("\n"),
    );
    expect(entries).toEqual([start, NOTE]);
    expect(entries[1]).not.toHaveProperty("phase");
  });
});

describe("renderRunlog", () => {
  test("groups entries by task in chronological order", () => {
    const md = renderRunlog([NOTE, SCORE], { slug: "demo" });
    expect(md).toContain("# Run log — demo");
    expect(md).toContain("## ui/03");
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
    expect(md).toMatch(/veto/i);
  });

  test("folds a judge rationale under the verdict line", () => {
    const md = renderRunlog(
      [{ ...SCORE, rationale: "Correctness 5/5.\n\n`kind.rs:68` is wrong." }],
      { slug: "demo" },
    );
    expect(md).toContain("<details><summary>judge rationale</summary>");
    expect(md).toContain("Correctness 5/5.\n\n`kind.rs:68` is wrong.");
    expect(md).toContain("</details>");
    expect(md.indexOf("4.40")).toBeLessThan(md.indexOf("<details>"));
  });

  test("emits no details block when a score has no rationale", () => {
    expect(renderRunlog([SCORE], { slug: "demo" })).not.toContain("<details>");
  });

  test("separates multiple tasks under their own headings", () => {
    const other: NoteEntry = { ...NOTE, task: "backend/01" };
    const md = renderRunlog([NOTE, other], { slug: "demo" });
    expect(md).toContain("## ui/03");
    expect(md).toContain("## backend/01");
  });

  test("skips start entries and tasks containing only start entries", () => {
    const start: NoteEntry = {
      ...NOTE,
      task: "ui/starting",
      phase: "start",
      message: "",
    };
    const md = renderRunlog([start, NOTE], { slug: "demo" });
    expect(md).not.toContain("## ui/starting");
    expect(md).toContain("## ui/03");
  });

  for (const slug of [
    "chronicle",
    "cockpit-autolog",
    "cockpit-thoughtful",
    "relay",
  ]) {
    test(`re-renders the committed ${slug} trail byte for byte`, async () => {
      const dir = join(import.meta.dir, "fixtures", "runlog", slug);
      const entries = parseLog(await readFile(join(dir, "run.jsonl"), "utf-8"));
      const expected = await readFile(join(dir, "RUNLOG.md"), "utf-8");
      expect(renderRunlog(entries, { slug })).toBe(expected);
    });
  }
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

const STATE: StateEntry = {
  kind: "state",
  ts: "2026-06-01T10:01:00.000Z",
  task: "ui/03",
  state: "blocked",
  agentLabel: "workflow",
  message: "Waiting for credentials",
};

describe("state entries", () => {
  test("round-trips state while dropping foreign and malformed lines", () => {
    const unknownState = { ...STATE, state: "future-state" };
    expect<unknown[]>(
      parseLog(
        [
          formatEntry(STATE),
          '{"kind":"future"}',
          "{broken",
          JSON.stringify(unknownState),
          formatEntry(NOTE),
        ].join("\n"),
      ),
    ).toEqual([STATE, unknownState, NOTE]);
  });

  test("renders declarations under their task and preserves legacy output", () => {
    const legacy =
      "# Run log — demo\n\n## ui/03\n\n" +
      "- attempt 2 · dev — Fixed the boundary case the judge flagged. _(agent: dev-ui-03-a2)_\n" +
      "- attempt 2 · judge — score 4.40 > 4 → PASS ✅ _(agent: judge-ui-03-a2)_\n";
    expect(
      renderRunlog([SCORE, NOTE, { ...NOTE, phase: "start" }], {
        slug: "demo",
      }),
    ).toBe(legacy);
    expect(renderRunlog([STATE, SCORE, NOTE], { slug: "demo" })).toBe(
      legacy +
        "- state — blocked: Waiting for credentials _(agent: workflow)_\n",
    );
    expect(
      renderRunlog(
        [
          {
            ...STATE,
            task: "api/01",
            state: "done",
            message: undefined,
            agentLabel: undefined,
          },
          NOTE,
        ],
        { slug: "demo" },
      ),
    ).toBe(
      "# Run log — demo\n\n## ui/03\n\n" +
        "- attempt 2 · dev — Fixed the boundary case the judge flagged. _(agent: dev-ui-03-a2)_\n\n" +
        "## api/01\n\n- state — done\n",
    );
  });

  test("appends state without overwriting other kinds", async () => {
    const root = await newDir();
    try {
      const logFile = join(root, ".flightlog", "run.jsonl");
      await appendEntry(logFile, NOTE);
      await appendEntry(logFile, STATE);
      await appendEntry(logFile, SCORE);
      expect(parseLog(await readFile(logFile, "utf-8"))).toEqual([
        NOTE,
        STATE,
        SCORE,
      ]);
    } finally {
      await rm(root, { recursive: true });
    }
  });
});
