import type { On } from "claude-code";
import { expect, test } from "claude-code/testing";

// A test's own tool hook never sees an ask, so this plugin above the mod turns one into a deny, which the call's result carries as `text`.
const spy = {
  name: "spy",
  tier: "prepend",
  register(on) {
    on("classic.PreToolUse", async (_$, e, next) => {
      const below = await next(e);
      return below.ask === undefined ? below : { deny: `ask: ${below.ask}` };
    });
  },
} as const satisfies {
  name: string;
  tier: "prepend";
  register: (on: On) => void;
};

// Stands for the repo: `git` answers from `branch` and `gitConfig`, and `.chronicle/pr.json` holds `pr` when given. A noun answering a primitive answers `{ value }`.
function repo(
  on: On,
  opts: {
    branch?: string;
    pr?: unknown;
    gitConfig?: Record<string, string>;
  } = {},
) {
  const runs: (readonly string[])[] = [];
  on("process.run", (_$, e) => {
    runs.push(e.argv);
    const args = e.argv.slice(1).join(" ");
    let stdout = "";
    if (args === "branch --show-current") stdout = `${opts.branch ?? "main"}\n`;
    else if (args === "rev-parse --show-toplevel") stdout = "/repo\n";
    else if (e.argv[1] === "config")
      stdout = opts.gitConfig?.[e.argv[3]!] ?? "";
    return {
      value: {
        exitCode: stdout ? 0 : 1,
        stdout,
        stderr: "",
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    } as never;
  });
  on("fs.read", (_$, e) => {
    if (opts.pr === undefined || e.path !== "/repo/.chronicle/pr.json") {
      throw new Error(`ENOENT: ${e.path}`);
    }
    return { value: JSON.stringify(opts.pr) } as never;
  });
  on("tool.call", () => ({ result: {}, text: "ran" }) as never);
  return { runs };
}

const bash = (command: string) => ({ tool: "Bash", command }) as const;

test(
  "asks before committing on a configured GitHub Flow base",
  { plugins: [spy] },
  async ($, on) => {
    repo(on, { pr: { workflow: "github-flow", base: "main" } });
    const ran = await $.tool.call(bash("git commit -m test"));
    expect(ran.text).toBe(
      "ask: ⚠️ You're on `main`, the configured GitHub Flow PR base. Commit from a topic branch, or confirm explicitly before retrying.",
    );
  },
);

test(
  "asks before committing on a configured Git Flow production branch",
  { plugins: [spy] },
  async ($, on) => {
    repo(on, {
      pr: { workflow: "git-flow", production: "main", development: "develop" },
    });
    const ran = await $.tool.call(bash("git commit -m test"));
    expect(ran.text).toBe(
      "ask: ⚠️ You're on `main`, the configured Git Flow production branch. Commit on `develop`, or confirm explicitly before retrying.",
    );
  },
);

test(
  "allows commits away from the configured protected branch",
  { plugins: [spy] },
  async ($, on) => {
    repo(on, {
      branch: "feature/safe",
      pr: { workflow: "github-flow", base: "main" },
    });
    expect((await $.tool.call(bash("git commit -m test"))).text).toBe("ran");
  },
);

test(
  "lets Chronicle config override stale legacy git-flow config",
  { plugins: [spy] },
  async ($, on) => {
    repo(on, {
      pr: { workflow: "github-flow", base: "develop" },
      gitConfig: {
        "gitflow.branch.develop": "develop",
        "gitflow.branch.master": "main",
      },
    });
    expect((await $.tool.call(bash("git commit -m test"))).text).toBe("ran");
  },
);

test(
  "preserves the legacy git-flow fallback without PR config",
  { plugins: [spy] },
  async ($, on) => {
    repo(on, {
      gitConfig: {
        "gitflow.branch.develop": "develop",
        "gitflow.branch.master": "main",
      },
    });
    const ran = await $.tool.call(bash("git commit -m test"));
    expect(ran.text).toBe(
      "ask: ⚠️ You're on `main` in a git-flow repo. Commit on `develop`, or confirm explicitly before retrying.",
    );
  },
);

test(
  "allows a commit with neither PR config nor legacy git-flow config",
  { plugins: [spy] },
  async ($, on) => {
    repo(on);
    expect((await $.tool.call(bash("git commit -m test"))).text).toBe("ran");
  },
);

test(
  "exempts a Chronicle release commit on the GitHub Flow base",
  { plugins: [spy] },
  async ($, on) => {
    repo(on, { pr: { workflow: "github-flow", base: "main" } });
    const ran = await $.tool.call(
      bash(`git commit -m "$(printf '%s' '🔧 release: chronicle 0.9.3')"`),
    );
    expect(ran.text).toBe("ran");
  },
);

test(
  "still asks for a release commit on the Git Flow production branch",
  { plugins: [spy] },
  async ($, on) => {
    repo(on, {
      pr: { workflow: "git-flow", production: "main", development: "develop" },
    });
    const ran = await $.tool.call(
      bash(`git commit -m "🔧 release: chronicle 0.9.3"`),
    );
    expect(ran.text).toStartWith("ask: ");
  },
);

test(
  "a Bash call that does not commit spawns nothing",
  { plugins: [spy] },
  async ($, on) => {
    const { runs } = repo(on, {
      pr: { workflow: "github-flow", base: "main" },
    });
    expect((await $.tool.call(bash("git status"))).text).toBe("ran");
    expect(runs).toEqual([]);
  },
);
