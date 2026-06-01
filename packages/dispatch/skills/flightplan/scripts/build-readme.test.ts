import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadTasks,
  renderGenerated,
  renderGlobalGraph,
  spliceGenerated,
  defaultSkeleton,
  GEN_START,
  GEN_END,
} from "./build-readme";
import { parseTask, type ParsedTask } from "./lib/parse-task";

function parseAll(headers: string[]): ParsedTask[] {
  return headers.map((h) => {
    const r = parseTask(h);
    if (!r.ok) throw new Error(`fixture parse fail: ${r.reason}`);
    return r.task;
  });
}

const RUBRIC_BLOCK = `
## Eval rubric

> 各項 0–5,加權平均 > 4.0 通過。

| 維度 | 權重 | 4–5(過關) |
|---|---|---|
| 正確性 | ×3 | ok |
| 測試涵蓋 | ×1 | ok |
`;

const HEADER = (
  bucket: string,
  nn: string,
  title: string,
  deps: string,
  status = "todo",
  rubric = "",
) => `# ${bucket.toUpperCase()}-${nn}: ${title}

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
${rubric}`;

async function writeTasks(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flightplan-readme-"));
  await mkdir(join(root, "tasks/_context"), { recursive: true });
  await writeFile(join(root, "tasks/_context/shared.md"), "# Shared\n");

  await mkdir(join(root, "tasks/ui"), { recursive: true });
  await writeFile(
    join(root, "tasks/ui/01-foo.md"),
    HEADER("ui", "01", "Foundation", "none", "todo", RUBRIC_BLOCK),
  );
  await writeFile(
    join(root, "tasks/ui/02-bar.md"),
    HEADER("ui", "02", "Second", "ui/01", "in-progress"),
  );

  await mkdir(join(root, "tasks/backend"), { recursive: true });
  await writeFile(
    join(root, "tasks/backend/01-baz.md"),
    HEADER("backend", "01", "Backend foundation", "none"),
  );
  await writeFile(
    join(root, "tasks/backend/02-cross.md"),
    HEADER("backend", "02", "Cross-bucket", "backend/01, ui/02"),
  );
  return root;
}

describe("loadTasks", () => {
  test("loads all task files under tasks/<bucket>/", async () => {
    const root = await writeTasks();
    const { tasks, errors } = await loadTasks(join(root, "tasks"));
    expect(errors).toEqual([]);
    expect(Object.keys(tasks).sort()).toEqual([
      "backend/01",
      "backend/02",
      "ui/01",
      "ui/02",
    ]);
    await rm(root, { recursive: true });
  });

  test("skips _context/ directory", async () => {
    const root = await writeTasks();
    await writeFile(
      join(root, "tasks/_context/99-fake.md"),
      HEADER("ui", "99", "fake", "none"),
    );
    const { tasks } = await loadTasks(join(root, "tasks"));
    expect(tasks["ui/99"]).toBeUndefined();
    await rm(root, { recursive: true });
  });

  test("skips README.md in bucket dirs", async () => {
    const root = await writeTasks();
    await writeFile(join(root, "tasks/ui/README.md"), "# Local notes\n");
    const { errors } = await loadTasks(join(root, "tasks"));
    expect(errors).toEqual([]);
    await rm(root, { recursive: true });
  });

  test("reports malformed task files as errors, doesn't index them", async () => {
    const root = await writeTasks();
    await writeFile(
      join(root, "tasks/ui/99-broken.md"),
      "just text, no h1, no quote\n",
    );
    const { tasks, errors } = await loadTasks(join(root, "tasks"));
    expect(tasks["ui/99"]).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0].file).toContain("99-broken.md");
    await rm(root, { recursive: true });
  });

  test("reports duplicate bucket/NN refs as errors", async () => {
    const root = await writeTasks();
    // Two files claiming ui/01
    await writeFile(
      join(root, "tasks/ui/01-dup.md"),
      HEADER("ui", "01", "Dup", "none"),
    );
    const { errors } = await loadTasks(join(root, "tasks"));
    expect(errors.some((e) => /duplicate ref ui\/01/.test(e.reason))).toBe(
      true,
    );
    await rm(root, { recursive: true });
  });
});

describe("renderGenerated", () => {
  test("emits status conventions, task index, global graph, and cross-bucket table", async () => {
    const root = await writeTasks();
    const input = await loadTasks(join(root, "tasks"));
    const out = renderGenerated(input);

    expect(out).toContain("## Status conventions");
    expect(out).toContain("## Task index");
    expect(out).toContain("| ui | 01 | Foundation | todo | > 4 | — |");
    expect(out).toContain("| ui | 02 | Second | in-progress | — | ui/01 |");
    expect(out).toContain("## Dependency graph");
    // Tree shape: roots flush-left, children with ├─→ / └─→
    expect(out).toMatch(/^backend\/01$/m);
    expect(out).toMatch(/^ui\/01$/m);
    expect(out).toContain("└─→ ui/02");
    expect(out).toContain("## Cross-bucket dependencies");
    expect(out).toContain("| backend/02 | ui/02 |");
    await rm(root, { recursive: true });
  });

  test("single bucket → no Cross-bucket table", async () => {
    const root = await mkdtemp(join(tmpdir(), "flightplan-readme-single-"));
    await mkdir(join(root, "tasks/work"), { recursive: true });
    await writeFile(
      join(root, "tasks/work/01-only.md"),
      HEADER("work", "01", "Only", "none"),
    );
    const input = await loadTasks(join(root, "tasks"));
    const out = renderGenerated(input);
    expect(out).not.toContain("## Cross-bucket dependencies");
    await rm(root, { recursive: true });
  });

  test("escapes pipe characters in titles so the table doesn't break", async () => {
    const root = await mkdtemp(join(tmpdir(), "flightplan-readme-pipe-"));
    await mkdir(join(root, "tasks/work"), { recursive: true });
    await writeFile(
      join(root, "tasks/work/01-pipe.md"),
      HEADER("work", "01", "Title | with pipe", "none"),
    );
    const input = await loadTasks(join(root, "tasks"));
    const out = renderGenerated(input);
    expect(out).toContain("Title \\| with pipe");
    await rm(root, { recursive: true });
  });
});

describe("renderGlobalGraph", () => {
  test("linear chain renders as └─→ descent", () => {
    const tasks = parseAll([
      HEADER("setup", "01", "T1", "none"),
      HEADER("setup", "02", "T2", "setup/01"),
      HEADER("setup", "03", "T3", "setup/02"),
    ]);
    const { graph, hasMultiParent } = renderGlobalGraph(tasks);
    expect(hasMultiParent).toBe(false);
    expect(graph).toBe(
      ["setup/01", "└─→ setup/02", "    └─→ setup/03"].join("\n"),
    );
  });

  test("fan-out uses ├─→ for non-last, └─→ for last", () => {
    const tasks = parseAll([
      HEADER("setup", "01", "T1", "none"),
      HEADER("setup", "02", "T2", "setup/01"),
      HEADER("setup", "03", "T3", "setup/01"),
      HEADER("setup", "04", "T4", "setup/01"),
    ]);
    const { graph } = renderGlobalGraph(tasks);
    expect(graph).toContain("├─→ setup/02");
    expect(graph).toContain("├─→ setup/03");
    expect(graph).toContain("└─→ setup/04");
  });

  test("cross-bucket flows are honored — sections hang off setup", () => {
    const tasks = parseAll([
      HEADER("setup", "01", "T1", "none"),
      HEADER("setup", "02", "T2", "setup/01"),
      HEADER("sections", "01", "S1", "setup/02"),
    ]);
    const { graph } = renderGlobalGraph(tasks);
    // Single global tree starting at setup/01
    expect(graph.startsWith("setup/01")).toBe(true);
    expect(graph).toContain("└─→ setup/02");
    expect(graph).toContain("    └─→ sections/01");
  });

  test("multi-parent task appears once under primary parent with * marker", () => {
    const tasks = parseAll([
      HEADER("polish", "01", "P1", "none"),
      HEADER("polish", "03", "P3", "none"),
      // First-listed dep wins: polish/06 hangs under polish/01
      HEADER("polish", "06", "P6", "polish/01, polish/03"),
    ]);
    const { graph, hasMultiParent } = renderGlobalGraph(tasks);
    expect(hasMultiParent).toBe(true);
    // polish/06 appears exactly once
    const occurrences = graph.split("polish/06").length - 1;
    expect(occurrences).toBe(1);
    // And it's under polish/01 (first dep), with * suffix
    expect(graph).toContain("└─→ polish/06 *");
    // polish/03 appears as its own root with no children
    expect(graph).toMatch(/^polish\/03$/m);
  });

  test("root with external/cross-bucket-only deps gets * marker", () => {
    const tasks = parseAll([
      // api/01 deps on external buckets that aren't in the set → effectively root
      HEADER("api", "01", "A1", "ui/99, backend/99"),
    ]);
    const { graph } = renderGlobalGraph(tasks);
    expect(graph).toBe("api/01 *");
  });

  test("true start (no deps) has no * marker", () => {
    const tasks = parseAll([HEADER("setup", "01", "T1", "none")]);
    const { graph, hasMultiParent } = renderGlobalGraph(tasks);
    expect(graph).toBe("setup/01");
    expect(hasMultiParent).toBe(false);
  });

  test("empty input doesn't throw", () => {
    const { graph } = renderGlobalGraph([]);
    expect(graph).toBe("(no tasks)");
  });

  test("cycle is broken (no infinite loop)", () => {
    // Mutual deps would be a lint error, but render must not hang.
    const tasks = parseAll([
      HEADER("ui", "01", "T1", "ui/02"),
      HEADER("ui", "02", "T2", "ui/01"),
    ]);
    // Both have primary parents, so both are non-roots in the strict sense;
    // but with the cycle, neither qualifies. We still render *something*
    // without hanging. The exact output is not load-bearing — just survives.
    const { graph } = renderGlobalGraph(tasks);
    expect(typeof graph).toBe("string");
  });
});

describe("spliceGenerated", () => {
  test("replaces between markers when present", () => {
    const existing = `# Title\n\nIntro.\n\n${GEN_START}\nOLD\n${GEN_END}\n\n## Known gaps\nx\n`;
    const next = spliceGenerated(existing, "NEW");
    expect(next).toContain(`${GEN_START}\nNEW\n${GEN_END}`);
    expect(next).not.toContain("OLD");
    expect(next).toContain("## Known gaps\nx\n");
    expect(next).toContain("Intro.");
  });

  test("appends block when markers are missing", () => {
    const existing = "# Title\n\nIntro.\n";
    const next = spliceGenerated(existing, "NEW");
    expect(next).toContain(GEN_START);
    expect(next).toContain("NEW");
    expect(next).toContain(GEN_END);
    expect(next.startsWith("# Title")).toBe(true);
  });
});

describe("defaultSkeleton", () => {
  test("includes title, all template sections, and markers", () => {
    const out = defaultSkeleton("course-player");
    expect(out).toContain("# course-player — Task System");
    expect(out).toContain("## Purpose");
    expect(out).toContain("## Directory layout");
    expect(out).toContain("## Reading order for executors");
    expect(out).toContain("## Naming convention");
    expect(out).toContain("## Where to start");
    expect(out).toContain(GEN_START);
    expect(out).toContain(GEN_END);
    expect(out).toContain("## Known gaps");
  });

  test("Where-to-start and Known-gaps come with placeholders for humans", () => {
    const out = defaultSkeleton("x");
    expect(out).toMatch(/Where to start[\s\S]+<!--/);
    expect(out).toMatch(/Known gaps[\s\S]+<!--/);
  });
});
