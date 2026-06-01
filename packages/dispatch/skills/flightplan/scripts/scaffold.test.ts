import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, access, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCollision, scaffold, validateInput } from "./scaffold";

async function newRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "flightplan-scaffold-"));
}

describe("checkCollision", () => {
  test("returns exists:false when dir is absent", async () => {
    const root = await newRoot();
    const result = await checkCollision("nope", root);
    expect(result.exists).toBe(false);
    expect(result.suggestedAlt).toBeNull();
    await rm(root, { recursive: true });
  });

  test("returns exists:true + suggests -v2 when dir exists", async () => {
    const root = await newRoot();
    await mkdir(join(root, "course-player"));
    const result = await checkCollision("course-player", root);
    expect(result.exists).toBe(true);
    expect(result.suggestedAlt).toBe("course-player-v2");
    await rm(root, { recursive: true });
  });

  test("skips to -v3 when -v2 also taken", async () => {
    const root = await newRoot();
    await mkdir(join(root, "course-player"));
    await mkdir(join(root, "course-player-v2"));
    const result = await checkCollision("course-player", root);
    expect(result.suggestedAlt).toBe("course-player-v3");
    await rm(root, { recursive: true });
  });
});

describe("validateInput", () => {
  test("rejects non-kebab slugs", () => {
    expect(
      validateInput({
        slug: "Course Player",
        buckets: ["ui"],
        docsRoot: "docs",
      }),
    ).toMatch(/kebab/);
    expect(
      validateInput({
        slug: "course_player",
        buckets: ["ui"],
        docsRoot: "docs",
      }),
    ).toMatch(/kebab/);
  });

  test("rejects empty buckets", () => {
    expect(
      validateInput({ slug: "ok", buckets: [], docsRoot: "docs" }),
    ).toMatch(/bucket/);
  });

  test("rejects uppercase bucket", () => {
    expect(
      validateInput({ slug: "ok", buckets: ["UI"], docsRoot: "docs" }),
    ).toMatch(/single kebab/);
  });

  test("rejects bucket with internal dash", () => {
    // The H1 parser does not accept dashes inside BUCKET, so dashed buckets
    // would scaffold but never lint/build.
    expect(
      validateInput({
        slug: "ok",
        buckets: ["my-bucket"],
        docsRoot: "docs",
      }),
    ).toMatch(/single kebab/);
  });

  test("accepts single-token buckets", () => {
    expect(
      validateInput({
        slug: "course-player",
        buckets: ["ui", "backend", "api", "work"],
        docsRoot: "docs",
      }),
    ).toBeNull();
  });
});

describe("scaffold", () => {
  test("creates dir tree only (no stub files)", async () => {
    const root = await newRoot();
    const result = await scaffold({
      slug: "course-player",
      buckets: ["ui", "backend"],
      docsRoot: root,
    });

    expect(result.rootDir).toBe(join(root, "course-player"));
    expect(result.bucketDirs).toHaveLength(2);

    // Directories exist
    const planDir = await stat(join(root, "course-player"));
    expect(planDir.isDirectory()).toBe(true);
    const contextDir = await stat(join(root, "course-player/tasks/_context"));
    expect(contextDir.isDirectory()).toBe(true);
    const uiDir = await stat(join(root, "course-player/tasks/ui"));
    expect(uiDir.isDirectory()).toBe(true);
    const backendDir = await stat(join(root, "course-player/tasks/backend"));
    expect(backendDir.isDirectory()).toBe(true);

    // No stub files
    await expect(access(join(root, "course-player/PLAN.md"))).rejects.toThrow();
    await expect(
      access(join(root, "course-player/tasks/_context/shared.md")),
    ).rejects.toThrow();

    await rm(root, { recursive: true });
  });

  test("refuses when target dir already exists", async () => {
    const root = await newRoot();
    await mkdir(join(root, "course-player"));
    await expect(
      scaffold({
        slug: "course-player",
        buckets: ["ui"],
        docsRoot: root,
      }),
    ).rejects.toThrow(/already exists/);
    await rm(root, { recursive: true });
  });

  test("error includes suggested alt slug", async () => {
    const root = await newRoot();
    await mkdir(join(root, "course-player"));
    try {
      await scaffold({
        slug: "course-player",
        buckets: ["ui"],
        docsRoot: root,
      });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain("course-player-v2");
    }
    await rm(root, { recursive: true });
  });

  test("validation runs before any filesystem op", async () => {
    const root = await newRoot();
    await expect(
      scaffold({
        slug: "course-player",
        buckets: ["My-Bucket"],
        docsRoot: root,
      }),
    ).rejects.toThrow(/single kebab/);
    // course-player dir was NOT created
    await expect(access(join(root, "course-player"))).rejects.toThrow();
    await rm(root, { recursive: true });
  });
});
