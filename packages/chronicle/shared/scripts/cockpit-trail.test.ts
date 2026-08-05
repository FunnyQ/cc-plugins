import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  collectDecisions,
  logRoot,
  projectMatches,
  readDecisionLog,
  type DecisionRecord,
} from "./cockpit-trail";

const tempDirs: string[] = [];

function tempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "chronicle-cockpit-trail-"));
  tempDirs.push(path);
  return path;
}

function decision(id: string): DecisionRecord {
  return {
    id,
    type: "decision",
    decision: id,
    reason: "reason",
    tradeoff: "tradeoff",
    facets: [],
    needs_your_call: false,
    options: [],
    files: [],
    timestamp: "2026-08-06T00:00:00.000Z",
  };
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("logRoot", () => {
  test("never walks above the git root", () => {
    const parent = tempDir();
    const root = join(parent, "repo");
    const cwd = join(root, "packages", "chronicle");
    mkdirSync(join(parent, ".cockpit"));
    mkdirSync(cwd, { recursive: true });

    expect(logRoot(cwd, { gitRoot: () => root })).toBe(realpathSync(root));
  });

  test("returns the nearest .cockpit between cwd and the git root", () => {
    const root = tempDir();
    const nearer = join(root, "packages");
    const cwd = join(nearer, "chronicle", "scripts");
    mkdirSync(join(root, ".cockpit"));
    mkdirSync(join(nearer, ".cockpit"), { recursive: true });
    mkdirSync(cwd, { recursive: true });

    expect(logRoot(cwd, { gitRoot: () => root })).toBe(realpathSync(nearer));
  });

  test("normalizes a symlinked temporary directory", () => {
    const parent = tempDir();
    const root = join(parent, "repo");
    const cwd = join(root, "nested");
    const link = join(parent, "repo-link");
    mkdirSync(cwd, { recursive: true });
    symlinkSync(root, link);

    expect(
      logRoot(join(link, "nested"), { gitRoot: () => realpathSync(root) }),
    ).toBe(realpathSync(root));
  });

  test("returns cwd unchanged when git root resolution returns null", () => {
    const cwd = tempDir();
    const parentCockpit = join(resolve(cwd, ".."), ".cockpit");

    expect(logRoot(cwd, { gitRoot: () => null })).toBe(realpathSync(cwd));
    expect(logRoot(cwd, { gitRoot: () => null })).not.toBe(parentCockpit);
  });

  test("returns the reported root when cwd is outside it", () => {
    const cwd = tempDir();
    const root = tempDir();
    mkdirSync(join(cwd, ".cockpit"));

    expect(logRoot(cwd, { gitRoot: () => root })).toBe(realpathSync(root));
  });
});

describe("readDecisionLog", () => {
  test("keeps valid records around blank, malformed, and invalid lines", async () => {
    const path = join(tempDir(), "decisions.jsonl");
    const valid = decision("kept");
    writeFileSync(
      path,
      [
        "",
        "not json",
        JSON.stringify({ type: "decision" }),
        JSON.stringify(valid),
      ].join("\n"),
    );

    expect(await readDecisionLog(path)).toEqual([valid]);
  });
});

// A cockpit registry can list several session logs. One of them being unreadable —
// deleted out from under us, half-written, wrong permissions — used to discard every
// decision harvested from its siblings and report hasCockpit:false, silently gutting
// the PR body's "Why" section.
describe("collectDecisions", () => {
  test("continues after a reader throws", async () => {
    const records = await collectDecisions(
      ["broken", "valid"],
      async (path) => {
        if (path === "broken") throw new Error("unreadable");
        return [decision("kept")];
      },
    );

    expect(records.map((record) => record.id)).toEqual(["kept"]);
  });

  test("returns empty when every log fails", async () => {
    const read = async () => {
      throw new Error("EACCES");
    };

    expect(await collectDecisions(["a.jsonl"], read)).toEqual([]);
  });
});

describe("projectMatches", () => {
  test("normalizes relative segments and trailing slashes", () => {
    const root = tempDir();

    expect(projectMatches(`${root}/nested/../`, `${root}/`)).toBe(true);
    expect(projectMatches(root, `${root}-other`)).toBe(false);
  });
});
