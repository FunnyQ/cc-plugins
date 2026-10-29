import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASK } from "./comment-core.ts";
import { collect, snapshot, sweep } from "./comment-sweep.ts";
import { recordReported } from "./sweep-state.ts";

delete process.env.TYPESAFE_API_KEY;

let repo: string;
let state: string;
const SESSION = "s-1";

const git = (...args: string[]) =>
  Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe" });

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "sweep-repo-")));
  state = mkdtempSync(join(tmpdir(), "sweep-state-"));
  process.env.GUARD_STATE_DIR = state;
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "core.autocrlf", "false");
});

afterEach(async () => {
  delete process.env.GUARD_STATE_DIR;
  await Bun.$`rm -rf ${repo} ${state}`.quiet();
});

const payload = {
  session_id: SESSION,
  get cwd() {
    return repo;
  },
};
const BLOCK = "const a = 1;\n// one\n// two\n// three\nconst b = 2;\n";

describe("sweep", () => {
  test("reports a block a script wrote into a new file", async () => {
    await snapshot(payload);
    await Bun.write(join(repo, "app.ts"), BLOCK);
    const reason = (await sweep(payload))?.reason;
    expect(reason).toContain(
      "🧹 comment-sweep: 1 comment block(s), 3 lines, in app.ts",
    );
    expect(reason).toContain("+ 2  // one");
    expect(reason).toEndWith(ASK);
  });

  test("reports a block a script grew in a committed file", async () => {
    await Bun.write(
      join(repo, "app.ts"),
      "const a = 1;\n// one\n// two\nconst b = 2;\n",
    );
    git("add", "-A");
    git("commit", "-qm", "init");
    await snapshot(payload);
    await Bun.write(join(repo, "app.ts"), BLOCK);
    const reason = (await sweep(payload))?.reason;
    expect(reason).toContain("+ 4  // three");
    expect(reason).toContain("  2  // one");
  });

  test("re-indenting a block is not an addition", async () => {
    await Bun.write(join(repo, "app.ts"), BLOCK);
    await snapshot(payload);
    await Bun.write(
      join(repo, "app.ts"),
      "if (x) {\n  const a = 1;\n  // one\n  // two\n  // three\n  const b = 2;\n}\n",
    );
    expect(await sweep(payload)).toBeNull();
  });

  test("a block moved to another file is not an addition", async () => {
    await Bun.write(join(repo, "old.ts"), BLOCK);
    await Bun.write(join(repo, "keep.ts"), "export {};\n");
    await snapshot(payload);
    await Bun.write(join(repo, "old.ts"), "const a = 1;\nconst b = 2;\n");
    await Bun.write(join(repo, "keep.ts"), `export {};\n${BLOCK}`);
    expect(await sweep(payload)).toBeNull();
  });

  test("a block moved out of a file deleted in the same turn is not an addition", async () => {
    await Bun.write(join(repo, "old.ts"), BLOCK);
    await snapshot(payload);
    await Bun.$`rm ${join(repo, "old.ts")}`.quiet();
    await Bun.write(join(repo, "new.ts"), BLOCK);
    expect(await sweep(payload)).toBeNull();
  });

  test("a block removed in one file still reports a different block added in another", async () => {
    await Bun.write(join(repo, "old.ts"), BLOCK);
    await snapshot(payload);
    await Bun.write(join(repo, "old.ts"), "const a = 1;\nconst b = 2;\n");
    await Bun.write(
      join(repo, "new.ts"),
      BLOCK.replace("// two", "// changed"),
    );
    const reason = (await sweep(payload))?.reason;
    expect(reason).toContain("in new.ts");
    expect(reason).toContain("+ 3  // changed");
    expect(reason).toContain("  2  // one");
  });

  test("the snapshot leaves the real index alone", async () => {
    await Bun.write(join(repo, "app.ts"), BLOCK);
    await snapshot(payload);
    const status = git("status", "--porcelain").stdout.toString();
    expect(status).toBe("?? app.ts\n");
  });

  test("a block the Edit hook already reported is not asked again", async () => {
    await snapshot(payload);
    await Bun.write(join(repo, "app.ts"), BLOCK);
    recordReported(SESSION, join(repo, "app.ts"), [
      "// one",
      "// two",
      "// three",
    ]);
    expect(await sweep(payload)).toBeNull();
  });

  test("a block reported under a symlinked spelling of the repo is not asked again", async () => {
    const link = join(mkdtempSync(join(tmpdir(), "sweep-link-")), "repo");
    symlinkSync(repo, link);
    await snapshot(payload);
    await Bun.write(join(repo, "app.ts"), BLOCK);
    recordReported(SESSION, join(link, "app.ts"), [
      "// one",
      "// two",
      "// three",
    ]);
    expect(await sweep(payload)).toBeNull();
  });

  const TRIPLE = "const a = 1;\n// same\n// same\n// same\nconst b = 2;\n";
  const addedLines = (reason: string | undefined) =>
    (reason ?? "").split("\n").filter((l) => /^\s*\+ \d+/.test(l)).length;

  test("one already-reported copy excuses one added twin, not every copy", async () => {
    await snapshot(payload);
    await Bun.write(join(repo, "app.ts"), TRIPLE);
    recordReported(SESSION, join(repo, "app.ts"), ["// same"]);
    expect(addedLines((await sweep(payload))?.reason)).toBe(2);
  });

  test("one copy moved from another file excuses one added twin, not every copy", async () => {
    await Bun.write(join(repo, "old.ts"), "const a = 1;\n// same\n");
    await snapshot(payload);
    await Bun.write(join(repo, "old.ts"), "const a = 1;\n");
    await Bun.write(join(repo, "app.ts"), TRIPLE);
    expect(addedLines((await sweep(payload))?.reason)).toBe(2);
  });

  test("asks the question once however many files it reports", async () => {
    await snapshot(payload);
    await Bun.write(join(repo, "a.ts"), BLOCK);
    await Bun.write(join(repo, "b.ts"), BLOCK);
    const reason = (await sweep(payload))?.reason ?? "";
    expect(reason).toContain("in a.ts");
    expect(reason).toContain("in b.ts");
    expect(reason.split(ASK)).toHaveLength(2);
  });

  test("a second sweep in the same turn does not repeat the first", async () => {
    await snapshot(payload);
    await Bun.write(join(repo, "app.ts"), BLOCK);
    expect(await sweep(payload)).not.toBeNull();
    expect(await sweep(payload)).toBeNull();
  });

  test("no snapshot means nothing to compare", async () => {
    await Bun.write(join(repo, "app.ts"), BLOCK);
    expect(await sweep(payload)).toBeNull();
  });

  test("outside a git repo it stays silent", async () => {
    const plain = { session_id: SESSION, cwd: state };
    await snapshot(plain);
    await Bun.write(join(state, "app.ts"), BLOCK);
    expect(await sweep(plain)).toBeNull();
  });

  test("a checkout-sized change is skipped", async () => {
    await snapshot(payload);
    for (let i = 0; i < 21; i++) await Bun.write(join(repo, `f${i}.ts`), BLOCK);
    expect(await sweep(payload)).toBeNull();
  });
});

describe("comment-guard records what it reported", () => {
  test("a reported Edit is not asked again by the sweep", async () => {
    await snapshot(payload);
    const file = join(repo, "app.ts");
    await Bun.write(file, BLOCK);
    const proc = Bun.spawn(
      ["bun", join(import.meta.dir, "comment-guard.ts")],
      {
        stdin: new TextEncoder().encode(
          JSON.stringify({
            session_id: SESSION,
            tool_name: "Write",
            tool_input: { file_path: file, content: BLOCK },
            tool_response: { type: "create", structuredPatch: [] },
          }),
        ),
        stderr: "pipe",
        env: { ...process.env, GUARD_STATE_DIR: state },
      },
    );
    expect(await proc.exited).toBe(2);
    expect(await sweep(payload)).toBeNull();
  });
});

describe("collect", () => {
  test("hands back the report without the question, for a reviewer to judge", async () => {
    await snapshot(payload);
    await Bun.write(join(repo, "app.ts"), BLOCK);
    const found = await collect(payload);
    expect(found?.report).toContain("+ 2  // one");
    expect(found?.report).not.toContain(ASK);
    expect(found?.blocks).toBe(1);
  });

  test("advances the baseline, so the next turn judges only its own writes", async () => {
    await snapshot(payload);
    await Bun.write(join(repo, "app.ts"), BLOCK);
    await collect(payload);
    expect(await collect(payload)).toBeNull();
  });

  // Screen requests carry `state.comment`, triage requests `state.block`; the screen keeps every block here.
  const jev = (pDelete: number) =>
    (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const probabilities = body.state.comment
        ? { why: 0.1, excuse: 0.1, what: 0.8 }
        : { keep: 0.05, delete: pDelete, must_kill: 0.95 - pDelete };
      const answers = Object.fromEntries(
        Object.keys(body.questions).map((k) => [k, { probabilities }]),
      );
      return new Response(JSON.stringify({ answers }));
    }) as unknown as typeof fetch;

  test("settles a report Jev is sure of, so no reviewer is needed", async () => {
    await snapshot(payload);
    await Bun.write(join(repo, "app.ts"), BLOCK);
    const found = await collect(payload, {
      apiKey: "k",
      fetch: jev(0.9),
      triage: true,
    });
    expect(found?.settled).toEqual([
      "app.ts:2 DELETE — Jev p=0.90: restates the code",
      "app.ts:3 DELETE — Jev p=0.90: restates the code",
      "app.ts:4 DELETE — Jev p=0.90: restates the code",
    ]);
  });

  test("keeps the report for the reviewer when Jev is unsure", async () => {
    await snapshot(payload);
    await Bun.write(join(repo, "app.ts"), BLOCK);
    const found = await collect(payload, {
      apiKey: "k",
      fetch: jev(0.4),
      triage: true,
    });
    expect(found?.settled).toBeUndefined();
    expect(found?.report).toContain("+ 2  // one");
  });

  test("never settles on the Stop path, which asks the author instead", async () => {
    await snapshot(payload);
    await Bun.write(join(repo, "app.ts"), BLOCK);
    const found = await collect(payload, {
      apiKey: "k",
      fetch: jev(0.9),
      triage: false,
    });
    expect(found?.settled).toBeUndefined();
    expect(found?.report).toContain("+ 2  // one");
  });
});
