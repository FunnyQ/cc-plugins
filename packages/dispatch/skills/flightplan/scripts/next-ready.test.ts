import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadAllTasks,
  findReady,
  findReadyDetailed,
  summarizeTree,
} from "./next-ready";
import { refToString } from "./lib/parse-task";

/** A real `done` task carries ticked gate boxes; anything else carries empty ones. */
const box = (status: string) => (status === "done" ? "[x]" : "[ ]");

const FINAL_TASK = (
  bucket: string,
  nn: string,
  deps: string,
  status: string,
) => `# ${bucket.toUpperCase()}-${nn}: Final review

> **Required reading**:
> - \`../_context/shared.md\`
>
> **Depends on**: ${deps}
> **Status**: ${status}
> **Final review**: true

## Goal
Holistic gate.

## Acceptance criteria
- ${box(status)} Integrates

## Verification
- ${box(status)} Check
`;

const TASK = (
  bucket: string,
  nn: string,
  deps: string,
  status: string,
) => `# ${bucket.toUpperCase()}-${nn}: Title ${bucket}/${nn}

> **Required reading**:
> - \`../_context/shared.md\`
>
> **Depends on**: ${deps}
> **Status**: ${status}

## Goal
A line.

## Acceptance criteria
- ${box(status)} One

## Verification
- ${box(status)} Check
`;

/** `Status: done` over an unticked Verification box — the malformed fingerprint. */
const MALFORMED_DONE = (bucket: string, nn: string, deps: string) =>
  TASK(bucket, nn, deps, "done").replace("- [x] Check", "- [ ] Check");

/** A decorated Status value — not a status at all, so the task is invalid. */
const DECORATED_STATUS = (bucket: string, nn: string, deps: string) =>
  TASK(bucket, nn, deps, "todo").replace(
    "> **Status**: todo",
    "> **Status**: in-progress (attempt 3)",
  );

async function writeScenario(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flightplan-ready-"));
  await mkdir(join(root, "tasks/_context"), { recursive: true });
  await writeFile(join(root, "tasks/_context/shared.md"), "# Shared\n");
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, "tasks", rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, body);
  }
  return root;
}

describe("findReady", () => {
  test("foundation tasks (no deps) are ready", async () => {
    const root = await writeScenario({
      "ui/01-foo.md": TASK("ui", "01", "none", "todo"),
      "ui/02-bar.md": TASK("ui", "02", "ui/01", "todo"),
    });
    const { byRef, errors } = await loadAllTasks(join(root, "tasks"));
    expect(errors).toEqual([]);
    const ready = findReady(byRef).map(refToString);
    expect(ready).toEqual(["ui/01"]);
    await rm(root, { recursive: true });
  });

  test("downstream task is ready when upstream is done", async () => {
    const root = await writeScenario({
      "ui/01-foo.md": TASK("ui", "01", "none", "done"),
      "ui/02-bar.md": TASK("ui", "02", "ui/01", "todo"),
    });
    const { byRef } = await loadAllTasks(join(root, "tasks"));
    const ready = findReady(byRef).map(refToString);
    expect(ready).toEqual(["ui/02"]);
    await rm(root, { recursive: true });
  });

  test("downstream is NOT ready when upstream is in-progress or blocked", async () => {
    const root = await writeScenario({
      "ui/01-foo.md": TASK("ui", "01", "none", "in-progress"),
      "ui/02-bar.md": TASK("ui", "02", "ui/01", "todo"),
    });
    const { byRef } = await loadAllTasks(join(root, "tasks"));
    const ready = findReady(byRef).map(refToString);
    expect(ready).toEqual([]);
    await rm(root, { recursive: true });
  });

  test("cross-bucket deps work", async () => {
    const root = await writeScenario({
      "ui/01.md": TASK("ui", "01", "none", "done"),
      "backend/01.md": TASK("backend", "01", "none", "done"),
      "api/01.md": TASK("api", "01", "ui/01, backend/01", "todo"),
    });
    const { byRef } = await loadAllTasks(join(root, "tasks"));
    const ready = findReady(byRef).map(refToString);
    expect(ready).toContain("api/01");
    await rm(root, { recursive: true });
  });

  test("already in-progress/done tasks are excluded", async () => {
    const root = await writeScenario({
      "ui/01.md": TASK("ui", "01", "none", "in-progress"),
      "ui/02.md": TASK("ui", "02", "none", "done"),
      "ui/03.md": TASK("ui", "03", "none", "todo"),
    });
    const { byRef } = await loadAllTasks(join(root, "tasks"));
    const ready = findReady(byRef).map(refToString);
    expect(ready).toEqual(["ui/03"]);
    await rm(root, { recursive: true });
  });

  test("blocked status is excluded even if deps satisfied", async () => {
    const root = await writeScenario({
      "ui/01.md": TASK("ui", "01", "none", "blocked"),
    });
    const { byRef } = await loadAllTasks(join(root, "tasks"));
    const ready = findReady(byRef).map(refToString);
    expect(ready).toEqual([]);
    await rm(root, { recursive: true });
  });
});

describe("findReadyDetailed", () => {
  test("carries the finalReview flag per ready ref", async () => {
    const root = await writeScenario({
      "ui/01.md": TASK("ui", "01", "none", "done"),
      "ui/02-final.md": FINAL_TASK("ui", "02", "ui/01", "todo"),
    });
    const { byRef, pathByRef } = await loadAllTasks(join(root, "tasks"));
    expect(findReadyDetailed(byRef, pathByRef)).toEqual([
      {
        ref: "ui/02",
        finalReview: true,
        path: join(root, "tasks", "ui", "02-final.md"),
      },
    ]);
    await rm(root, { recursive: true });
  });

  test("is empty when nothing is ready (the all-done case)", async () => {
    const root = await writeScenario({
      "ui/01.md": TASK("ui", "01", "none", "done"),
      "ui/02.md": TASK("ui", "02", "ui/01", "done"),
    });
    const { byRef, pathByRef } = await loadAllTasks(join(root, "tasks"));
    expect(findReadyDetailed(byRef, pathByRef)).toEqual([]);
    await rm(root, { recursive: true });
  });
});

describe("malformed completion state", () => {
  test("a dependent is never returned when its dependency is malformed", async () => {
    const root = await writeScenario({
      "ui/01.md": MALFORMED_DONE("ui", "01", "none"),
      "ui/02.md": TASK("ui", "02", "ui/01", "todo"),
    });
    const { byRef, invalid } = await loadAllTasks(join(root, "tasks"));
    expect(invalid.map((i) => i.ref)).toEqual(["ui/01"]);
    expect(invalid[0].rule).toBe("completion-state");
    expect(findReady(byRef).map(refToString)).toEqual([]);
    await rm(root, { recursive: true });
  });

  test("a decorated Status fails readiness instead of vanishing from the graph", async () => {
    const root = await writeScenario({
      "ui/01.md": DECORATED_STATUS("ui", "01", "none"),
      "ui/02.md": TASK("ui", "02", "ui/01", "todo"),
    });
    const { byRef, invalid, errors } = await loadAllTasks(join(root, "tasks"));
    expect(errors).toEqual([]);
    expect(byRef["ui/01"]).toBeDefined();
    expect(invalid.map((i) => i.ref)).toEqual(["ui/01"]);
    expect(invalid[0].rule).toBe("status");
    expect(findReady(byRef).map(refToString)).toEqual([]);
    await rm(root, { recursive: true });
  });
});

describe("--json CLI", () => {
  const run = async (tasksDir: string) => {
    const proc = Bun.spawn(
      ["bun", join(import.meta.dir, "next-ready.ts"), tasksDir, "--json"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    const code = await proc.exited;
    return { out: out.trim(), err, code };
  };

  test("fails loudly on a malformed completion state", async () => {
    const root = await writeScenario({
      "ui/01.md": MALFORMED_DONE("ui", "01", "none"),
      "ui/02.md": TASK("ui", "02", "ui/01", "todo"),
    });
    const { out, err, code } = await run(join(root, "tasks"));
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toContain("ui/01");
    expect(err).toContain("completion-state");
    expect(err).toMatch(/Do NOT tick the boxes by hand/);
    await rm(root, { recursive: true });
  });

  test("prints `[]` (not blank) when every task is done", async () => {
    const root = await writeScenario({
      "ui/01.md": TASK("ui", "01", "none", "done"),
      "ui/02.md": TASK("ui", "02", "none", "done"),
    });
    const { out, code } = await run(join(root, "tasks"));
    expect(code).toBe(0);
    expect(out).toBe("[]");
    expect(JSON.parse(out)).toEqual([]);
    await rm(root, { recursive: true });
  });

  test("prints ready refs with finalReview flags", async () => {
    const root = await writeScenario({
      "ui/01.md": TASK("ui", "01", "none", "todo"),
      "ui/02-final.md": FINAL_TASK("ui", "02", "ui/01", "todo"),
    });
    const { out, code } = await run(join(root, "tasks"));
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual([
      {
        ref: "ui/01",
        finalReview: false,
        path: join(root, "tasks", "ui", "01.md"),
      },
    ]);
    await rm(root, { recursive: true });
  });
});

describe("loadAllTasks", () => {
  test("reports malformed files as errors instead of silently dropping them", async () => {
    const root = await writeScenario({
      "ui/01.md": TASK("ui", "01", "none", "todo"),
      "ui/02-broken.md": "just text\n",
    });
    const { byRef, errors } = await loadAllTasks(join(root, "tasks"));
    expect(byRef["ui/01"]).toBeDefined();
    expect(errors).toHaveLength(1);
    expect(errors[0].file).toContain("02-broken.md");
    await rm(root, { recursive: true });
  });

  test("reports duplicate bucket/NN as errors", async () => {
    const root = await writeScenario({
      "ui/01-a.md": TASK("ui", "01", "none", "todo"),
      "ui/01-b.md": TASK("ui", "01", "none", "todo"),
    });
    const { errors } = await loadAllTasks(join(root, "tasks"));
    expect(errors.some((e) => /duplicate ref ui\/01/.test(e.reason))).toBe(
      true,
    );
    await rm(root, { recursive: true });
  });

  test("skips README.md placed inside a bucket dir", async () => {
    const root = await writeScenario({
      "ui/01.md": TASK("ui", "01", "none", "todo"),
      "ui/README.md": "# Notes\n",
    });
    const { errors } = await loadAllTasks(join(root, "tasks"));
    expect(errors).toEqual([]);
    await rm(root, { recursive: true });
  });
});

describe("summarizeTree", () => {
  const summarize = async (files: Record<string, string>) => {
    const root = await mkdtemp(join(tmpdir(), "flightplan-summary-"));
    await mkdir(join(root, "tasks/_context"), { recursive: true });
    await writeFile(join(root, "tasks/_context/shared.md"), "# Shared\n");
    for (const [rel, body] of Object.entries(files)) {
      const abs = join(root, "tasks", rel);
      await mkdir(join(abs, ".."), { recursive: true });
      await writeFile(abs, body);
    }
    const { byRef, pathByRef, invalid } = await loadAllTasks(
      join(root, "tasks"),
    );
    const snapshot = summarizeTree(byRef, pathByRef);
    await rm(root, { recursive: true });
    return { ...snapshot, invalid };
  };

  /** The identity the wave loop asserts before trusting any bucket. */
  const sumsToTotal = (c: {
    total: number;
    todo: number;
    inProgress: number;
    done: number;
    blocked: number;
    invalid: number;
  }) => c.todo + c.inProgress + c.done + c.blocked + c.invalid === c.total;

  test("a fresh tree is all todo with the foundation ready", async () => {
    const { ready, counts } = await summarize({
      "ui/01.md": TASK("ui", "01", "none", "todo"),
      "ui/02.md": TASK("ui", "02", "ui/01", "todo"),
    });
    expect(counts).toEqual({
      total: 2,
      todo: 2,
      inProgress: 0,
      done: 0,
      blocked: 0,
      invalid: 0,
    });
    expect(sumsToTotal(counts)).toBe(true);
    expect(ready.map((r) => r.ref)).toEqual(["ui/01"]);
  });

  test("a fully completed tree reports done === total and no ready work", async () => {
    const { ready, counts } = await summarize({
      "ui/01.md": TASK("ui", "01", "none", "done"),
      "ui/02.md": TASK("ui", "02", "ui/01", "done"),
    });
    expect(counts.done).toBe(counts.total);
    expect(ready).toEqual([]);
  });

  test("a resumed tree counts earlier-run done tasks toward completion", async () => {
    // Only ui/03 is left; a current-run `completed` array would hold 0 entries.
    const { ready, counts } = await summarize({
      "ui/01.md": TASK("ui", "01", "none", "done"),
      "ui/02.md": TASK("ui", "02", "ui/01", "done"),
      "ui/03.md": TASK("ui", "03", "ui/02", "todo"),
    });
    expect(counts.done).toBe(2);
    expect(counts.total).toBe(3);
    expect(counts.done).not.toBe(counts.total);
    expect(ready.map((r) => r.ref)).toEqual(["ui/03"]);
  });

  test("a stale in-progress task leaves no ready work — the stalled shape", async () => {
    const { ready, counts, unfinished } = await summarize({
      "ui/01.md": TASK("ui", "01", "none", "in-progress"),
      "ui/02.md": TASK("ui", "02", "ui/01", "todo"),
    });
    expect(ready).toEqual([]);
    expect(counts.done).not.toBe(counts.total);
    expect(counts.inProgress).toBe(1);
    expect(counts.todo).toBe(1);
    // The escalation needs the refs, not just the counts.
    expect(unfinished).toEqual([
      { ref: "ui/01", state: "inProgress" },
      { ref: "ui/02", state: "todo" },
    ]);
  });

  test("unfinished lists every non-done task and omits done ones", async () => {
    const { unfinished } = await summarize({
      "ui/01.md": TASK("ui", "01", "none", "done"),
      "ui/02.md": TASK("ui", "02", "ui/01", "blocked"),
      "ui/03.md": MALFORMED_DONE("ui", "03", "none"),
    });
    expect(unfinished).toEqual([
      { ref: "ui/02", state: "blocked" },
      { ref: "ui/03", state: "invalid" },
    ]);
  });

  test("a blocked dependency chain leaves no ready work", async () => {
    const { ready, counts } = await summarize({
      "ui/01.md": TASK("ui", "01", "none", "blocked"),
      "ui/02.md": TASK("ui", "02", "ui/01", "todo"),
      "ui/03.md": TASK("ui", "03", "ui/02", "todo"),
    });
    expect(ready).toEqual([]);
    expect(counts.blocked).toBe(1);
    expect(counts.todo).toBe(2);
    expect(sumsToTotal(counts)).toBe(true);
  });

  test("a mixed tree still offers independent ready work", async () => {
    const { ready, counts } = await summarize({
      "ui/01.md": TASK("ui", "01", "none", "blocked"),
      "ui/02.md": TASK("ui", "02", "ui/01", "todo"),
      "api/01.md": TASK("api", "01", "none", "done"),
      "api/02.md": TASK("api", "02", "api/01", "todo"),
    });
    expect(ready.map((r) => r.ref)).toEqual(["api/02"]);
    expect(counts).toEqual({
      total: 4,
      todo: 2,
      inProgress: 0,
      done: 1,
      blocked: 1,
      invalid: 0,
    });
  });

  test("a malformed Status counts as invalid, never as its written status", async () => {
    const { ready, counts, invalid } = await summarize({
      "ui/01.md": MALFORMED_DONE("ui", "01", "none"),
      "ui/02.md": DECORATED_STATUS("ui", "02", "none"),
      "ui/03.md": TASK("ui", "03", "ui/01", "todo"),
    });
    expect(counts.invalid).toBe(2);
    expect(counts.done).toBe(0);
    expect(sumsToTotal(counts)).toBe(true);
    expect(ready).toEqual([]);
    expect(invalid.map((i) => i.ref).sort()).toEqual(["ui/01", "ui/02"]);
  });

  test("--summary CLI prints the snapshot, then exits 1 on an invalid tree", async () => {
    const root = await writeScenario({
      "ui/01.md": MALFORMED_DONE("ui", "01", "none"),
      "ui/02.md": TASK("ui", "02", "ui/01", "todo"),
    });
    const proc = Bun.spawn(
      [
        "bun",
        join(import.meta.dir, "next-ready.ts"),
        join(root, "tasks"),
        "--summary",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(1);
    const payload = JSON.parse(out);
    expect(payload.counts.invalid).toBe(1);
    expect(payload.counts.total).toBe(2);
    expect(payload.ready).toEqual([]);
    expect(payload.invalid.map((i: { ref: string }) => i.ref)).toEqual([
      "ui/01",
    ]);
    await rm(root, { recursive: true });
  });

  test("--summary CLI exits 0 on a clean tree", async () => {
    const root = await writeScenario({
      "ui/01.md": TASK("ui", "01", "none", "done"),
      "ui/02.md": TASK("ui", "02", "ui/01", "todo"),
    });
    const proc = Bun.spawn(
      [
        "bun",
        join(import.meta.dir, "next-ready.ts"),
        join(root, "tasks"),
        "--summary",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.counts).toEqual({
      total: 2,
      todo: 1,
      inProgress: 0,
      done: 1,
      blocked: 0,
      invalid: 0,
    });
    expect(payload.ready.map((r: { ref: string }) => r.ref)).toEqual(["ui/02"]);
    await rm(root, { recursive: true });
  });
});
