import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  collectContext,
  fetchBodies,
  parseCliArgs,
  toSkeleton,
  type DecisionRecord,
} from "./collect-adr-context";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

function temporaryRoot(parent = tmpdir()): string {
  const root = mkdtempSync(join(parent, "collect-adr-context-"));
  roots.push(root);
  return root;
}

function record(id: string): DecisionRecord {
  return {
    id,
    type: "decision",
    kind: "rationale",
    decision: `Choose ${id}`,
    reason: `Reason ${id}`,
    tradeoff: `Tradeoff ${id}`,
    facets: [{ label: "scope", text: id }],
    needs_your_call: false,
    options: ["one", "two"],
    files: [`src/${id}.ts`],
    diagram: `graph TD; ${id}`,
    timestamp: "2026-08-06T00:00:00.000Z",
  };
}

function writeSession(
  root: string,
  directory: "logs" | "archive/watch" | "archive/done",
  sessionId: string,
  lines: string[],
): string {
  const sessionDir = join(root, ".cockpit", directory);
  mkdirSync(sessionDir, { recursive: true });
  const path = join(sessionDir, `${sessionId}.jsonl`);
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

describe("toSkeleton", () => {
  test("strips every full-body field", () => {
    const skeleton = toSkeleton(record("adr-1"), "session-1");

    expect(skeleton).toEqual({
      id: "adr-1",
      sessionId: "session-1",
      kind: "rationale",
      decision: "Choose adr-1",
      timestamp: "2026-08-06T00:00:00.000Z",
      files: ["src/adr-1.ts"],
    });
    expect(skeleton).not.toHaveProperty("reason");
    expect(skeleton).not.toHaveProperty("tradeoff");
    expect(skeleton).not.toHaveProperty("facets");
    expect(skeleton).not.toHaveProperty("options");
    expect(skeleton).not.toHaveProperty("diagram");
  });
});

describe("collectContext", () => {
  test("returns an empty context when no trail exists", async () => {
    const root = temporaryRoot();

    expect(await collectContext(root)).toEqual({
      trailRoot: "",
      hasTrail: false,
      sessions: [],
      skeletons: [],
      adrDir: join(root, "docs", "adr"),
    });
  });

  test("reports an existing trail with an empty log directory", async () => {
    const root = temporaryRoot();
    mkdirSync(join(root, ".cockpit", "logs"), { recursive: true });

    const context = await collectContext(root);

    expect(context.hasTrail).toBe(true);
    expect(context.trailRoot).toBe(realpathSync(root));
    expect(context.sessions).toEqual([]);
    expect(context.skeletons).toEqual([]);
  });

  test("skips malformed JSONL lines and keeps valid records", async () => {
    const root = temporaryRoot();
    writeSession(root, "logs", "mixed", [
      JSON.stringify(record("valid")),
      "{not-json",
      JSON.stringify({ type: "message", text: "ignored" }),
    ]);

    const context = await collectContext(root);

    expect(context.skeletons.map(({ id }) => id)).toEqual(["valid"]);
    expect(context.sessions[0]?.entryCount).toBe(1);
  });

  test("includes watch by default and done only when requested", async () => {
    const root = temporaryRoot();
    writeSession(root, "logs", "inbox", [JSON.stringify(record("inbox-id"))]);
    writeSession(root, "archive/watch", "watched", [
      JSON.stringify(record("watch-id")),
    ]);
    writeSession(root, "archive/done", "archived", [
      JSON.stringify(record("done-id")),
    ]);

    expect(
      (await collectContext(root)).sessions.map(({ bucket }) => bucket),
    ).toEqual(["inbox", "watch"]);
    expect(
      (await collectContext(root, { includeDone: true })).sessions.map(
        ({ bucket }) => bucket,
      ),
    ).toEqual(["inbox", "watch", "done"]);
  });

  test("uses the git root for adrDir when a nested trail exists", async () => {
    const repositoryRoot = join(import.meta.dir, "../../../../..");
    const nested = temporaryRoot(repositoryRoot);
    mkdirSync(join(nested, ".cockpit", "logs"), { recursive: true });

    const context = await collectContext(nested);

    expect(context.trailRoot).toBe(nested);
    expect(context.adrDir).toBe(join(repositoryRoot, "docs", "adr"));
  });

  test("collects multiple entries from multiple sessions", async () => {
    const root = temporaryRoot();
    writeSession(root, "logs", "first", [
      JSON.stringify(record("one")),
      JSON.stringify(record("two")),
    ]);
    writeSession(root, "logs", "second", [JSON.stringify(record("three"))]);

    const context = await collectContext(root);

    expect(context.sessions).toHaveLength(2);
    expect(context.skeletons.map(({ id }) => id).sort()).toEqual([
      "one",
      "three",
      "two",
    ]);
  });

  test("reports session filename, path, bucket, mtime, and entry count", async () => {
    const root = temporaryRoot();
    const path = writeSession(root, "logs", "metadata", [
      JSON.stringify(record("one")),
      JSON.stringify(record("two")),
    ]);
    const modified = new Date("2026-08-05T12:34:56.000Z");
    utimesSync(path, modified, modified);

    const session = (await collectContext(root)).sessions[0];

    expect(session).toEqual({
      sessionId: "metadata",
      path: realpathSync(path),
      bucket: "inbox",
      mtimeMs: modified.getTime(),
      entryCount: 2,
    });
  });
});

describe("fetchBodies", () => {
  test("ignores unknown ids and finds records in every archive bucket", async () => {
    const root = temporaryRoot();
    writeSession(root, "logs", "active", [JSON.stringify(record("inbox-id"))]);
    writeSession(root, "archive/watch", "watching", [
      JSON.stringify(record("watch-id")),
    ]);
    writeSession(root, "archive/done", "finished", [
      JSON.stringify(record("done-id")),
    ]);

    const bodies = await fetchBodies(root, ["unknown", "done-id", "inbox-id"]);

    expect(bodies.map(({ id }) => id).sort()).toEqual(["done-id", "inbox-id"]);
    expect(bodies.find(({ id }) => id === "done-id")?.sessionId).toBe(
      "finished",
    );
    expect(bodies.find(({ id }) => id === "done-id")?.reason).toBe(
      "Reason done-id",
    );
  });
});

// Every agent file that reaches this script names its flags in prose. A drifted flag
// used to be ignored, so `--ids` silently produced a skeleton run and the caller only
// noticed three steps later, by the evidence that never arrived.
describe("parseCliArgs", () => {
  test("accepts the two supported flags", () => {
    expect(parseCliArgs([])).toEqual({ includeDone: false, bodyIds: null });
    expect(parseCliArgs(["--include-done"])).toEqual({
      includeDone: true,
      bodyIds: null,
    });
    expect(parseCliArgs(["--bodies", "a, b ,,c"])).toEqual({
      includeDone: false,
      bodyIds: ["a", "b", "c"],
    });
  });

  test("rejects an unknown flag instead of ignoring it", () => {
    expect(() => parseCliArgs(["--ids", "a"])).toThrow(/Usage/);
    expect(() => parseCliArgs(["--include-archived"])).toThrow(/Usage/);
  });

  test("rejects --bodies with no value", () => {
    expect(() => parseCliArgs(["--bodies"])).toThrow(/Usage/);
  });
});

describe("CLI", () => {
  test("exits non-zero on an unknown flag", async () => {
    const script = join(import.meta.dir, "collect-adr-context.ts");
    const run = Bun.spawn([process.execPath, script, "--ids", "a"], {
      cwd: temporaryRoot(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const stderr = await new Response(run.stderr).text();
    expect(await run.exited).toBe(1);
    expect(stderr).toContain("Usage");
  });

  test("exits successfully and writes an empty context without a trail", async () => {
    const root = temporaryRoot();
    const script = join(import.meta.dir, "collect-adr-context.ts");
    const run = Bun.spawn([process.execPath, script], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(run.stdout).text();
    expect(await run.exited).toBe(0);
    const summary = JSON.parse(stdout);
    expect(summary).toMatchObject({
      hasTrail: false,
      sessionCount: 0,
      entryCount: 0,
    });
    const payload = await Bun.file(summary.outputPath).json();
    expect(payload).toMatchObject({
      trailRoot: "",
      hasTrail: false,
      sessions: [],
      skeletons: [],
    });

    rmSync(summary.outputPath);
  });

  test("writes skeleton and body payloads and prints one-line summaries", async () => {
    const root = temporaryRoot();
    writeSession(root, "logs", "cli-session", [
      JSON.stringify(record("cli-id")),
    ]);
    const script = join(import.meta.dir, "collect-adr-context.ts");

    const skeletonRun = Bun.spawn([process.execPath, script], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const skeletonStdout = await new Response(skeletonRun.stdout).text();
    expect(await skeletonRun.exited).toBe(0);
    expect(skeletonStdout.trim().split("\n")).toHaveLength(1);
    const skeletonSummary = JSON.parse(skeletonStdout);
    expect(skeletonSummary).toMatchObject({
      hasTrail: true,
      sessionCount: 1,
      entryCount: 1,
      adrDir: join(realpathSync(root), "docs", "adr"),
    });
    expect(basename(skeletonSummary.outputPath)).toMatch(
      /^context-\d+-\d+\.json$/,
    );
    const skeletonPayload = await Bun.file(skeletonSummary.outputPath).json();
    expect(skeletonPayload.skeletons[0].id).toBe("cli-id");
    expect(skeletonPayload.skeletons[0]).not.toHaveProperty("reason");

    writeSession(root, "archive/watch", "cli-watch", [
      JSON.stringify(record("cli-watch-id")),
    ]);
    const defaultRun = Bun.spawn([process.execPath, script], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const defaultStdout = await new Response(defaultRun.stdout).text();
    expect(await defaultRun.exited).toBe(0);
    const defaultSummary = JSON.parse(defaultStdout);
    expect(defaultSummary).toMatchObject({
      sessionCount: 2,
      entryCount: 2,
    });

    writeSession(root, "archive/done", "cli-done", [
      JSON.stringify(record("cli-done-id")),
    ]);
    const includeDoneRun = Bun.spawn(
      [process.execPath, script, "--include-done"],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    const includeDoneStdout = await new Response(includeDoneRun.stdout).text();
    expect(await includeDoneRun.exited).toBe(0);
    const includeDoneSummary = JSON.parse(includeDoneStdout);
    expect(includeDoneSummary).toMatchObject({
      sessionCount: 3,
      entryCount: 3,
    });

    const bodyRun = Bun.spawn(
      [process.execPath, script, "--bodies", "cli-id,unknown"],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    const bodyStdout = await new Response(bodyRun.stdout).text();
    expect(await bodyRun.exited).toBe(0);
    const bodySummary = JSON.parse(bodyStdout);
    const bodyPayload = await Bun.file(bodySummary.outputPath).json();
    expect(bodyPayload).toHaveLength(1);
    expect(bodyPayload[0]).toMatchObject({
      id: "cli-id",
      sessionId: "cli-session",
      reason: "Reason cli-id",
    });

    rmSync(skeletonSummary.outputPath);
    rmSync(includeDoneSummary.outputPath);
    rmSync(bodySummary.outputPath);
  });
});
