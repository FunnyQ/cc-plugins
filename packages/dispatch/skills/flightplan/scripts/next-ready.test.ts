import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAllTasks, findReady, findReadyDetailed } from "./next-ready";
import { refToString } from "./lib/parse-task";

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
- [ ] Integrates

## Verification
- [ ] Check
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
- [ ] One

## Verification
- [ ] Check
`;

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
    const { byRef } = await loadAllTasks(join(root, "tasks"));
    expect(findReadyDetailed(byRef)).toEqual([
      { ref: "ui/02", finalReview: true },
    ]);
    await rm(root, { recursive: true });
  });

  test("is empty when nothing is ready (the all-done case)", async () => {
    const root = await writeScenario({
      "ui/01.md": TASK("ui", "01", "none", "done"),
      "ui/02.md": TASK("ui", "02", "ui/01", "done"),
    });
    const { byRef } = await loadAllTasks(join(root, "tasks"));
    expect(findReadyDetailed(byRef)).toEqual([]);
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
    const code = await proc.exited;
    return { out: out.trim(), code };
  };

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
    expect(JSON.parse(out)).toEqual([{ ref: "ui/01", finalReview: false }]);
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
