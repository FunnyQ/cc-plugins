import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshot, sweep } from "./comment-sweep.ts";
import { recordReported } from "./sweep-state.ts";

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
    const reason = await sweep(payload);
    expect(reason).toContain(
      "🧹 comment-sweep: 1 comment block(s), 3 lines, in app.ts",
    );
    expect(reason).toContain("+ 2  // one");
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
    const reason = await sweep(payload);
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
      ["bun", new URL("./comment-guard.ts", import.meta.url).pathname],
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
