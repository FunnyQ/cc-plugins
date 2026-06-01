import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markDone } from "./mark-done";

const TASK = `# UI-03: Sample task

> **Required reading**:
> - \`../_context/shared.md\`
>
> **Depends on**: none — foundation task
> **Status**: in-progress

## Goal

Do the thing.

## Implementation notes

- [ ] this is NOT a checkbox to tick (prose bullet in notes)

## Acceptance criteria

- [ ] Renders the empty state
- [ ] Handles the error path
- [x] Already verified earlier

## Verification

- [ ] \`bun test\` passes
- [ ] Manual smoke check

## Out of scope

- [ ] deferred item — must stay unchecked
`;

describe("markDone", () => {
  test("sets Status to done", () => {
    expect(markDone(TASK)).toContain("**Status**: done");
    expect(markDone(TASK)).not.toContain("**Status**: in-progress");
  });

  test("ticks every box in Acceptance criteria", () => {
    const out = markDone(TASK);
    expect(out).toContain("- [x] Renders the empty state");
    expect(out).toContain("- [x] Handles the error path");
  });

  test("ticks every box in Verification", () => {
    const out = markDone(TASK);
    expect(out).toContain("- [x] `bun test` passes");
    expect(out).toContain("- [x] Manual smoke check");
  });

  test("leaves boxes in other sections untouched", () => {
    const out = markDone(TASK);
    expect(out).toContain(
      "- [ ] this is NOT a checkbox to tick (prose bullet in notes)",
    );
    expect(out).toContain("- [ ] deferred item — must stay unchecked");
  });

  test("leaves already-checked boxes alone", () => {
    expect(markDone(TASK)).toContain("- [x] Already verified earlier");
  });

  test("is idempotent", () => {
    const once = markDone(TASK);
    expect(markDone(once)).toBe(once);
  });

  test("handles todo and blocked starting status", () => {
    expect(markDone(TASK.replace("in-progress", "todo"))).toContain(
      "**Status**: done",
    );
    expect(markDone(TASK.replace("in-progress", "blocked"))).toContain(
      "**Status**: done",
    );
  });

  test("CLI rewrites the file in place", async () => {
    const root = await mkdtemp(join(tmpdir(), "mark-done-"));
    const file = join(root, "03-sample.md");
    await writeFile(file, TASK);
    const proc = Bun.spawn(
      ["bun", join(import.meta.dir, "mark-done.ts"), file],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await proc.exited).toBe(0);
    const out = await readFile(file, "utf-8");
    expect(out).toContain("**Status**: done");
    expect(out).toContain("- [x] Renders the empty state");
    expect(out).toContain("- [ ] deferred item — must stay unchecked");
    await rm(root, { recursive: true });
  });
});
