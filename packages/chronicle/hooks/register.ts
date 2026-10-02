/**
 * check-branch as a Claude Code mod: the matcher rejects every Bash call that
 * is not a git commit before the hook runs, so an ordinary command spawns
 * nothing. It hooks `classic.PreToolUse` rather than `tool.call` because only
 * the classic result can ask; `tool.call` can pass or deny and nothing else.
 * OpenCode keeps check-branch.sh, since it has no function hooks.
 */

import type { Register } from "claude-code";
import { COMMIT_COMMAND } from "./commit-command.ts";

type PrConfig = {
  workflow?: string;
  base?: string;
  production?: string;
  development?: string;
};

export const register: Register = (on) => {
  on(
    "classic.PreToolUse",
    { tool: "Bash", command: COMMIT_COMMAND },
    async ($, e, next) => {
      if (e.tool !== "Bash") return next(e);

      const git = async (...args: string[]) => {
        const r = await $.process.run(["git", ...args]);
        return r.exitCode === 0 ? r.stdout.trim() : "";
      };

      const ask = async (): Promise<string | undefined> => {
        const branch = await git("branch", "--show-current");
        const root = await git("rev-parse", "--show-toplevel");
        let config: PrConfig = {};
        if (root) {
          try {
            config = JSON.parse(await $.fs.read(`${root}/.chronicle/pr.json`));
          } catch {}
        }

        if (config.workflow === "github-flow") {
          // A GitHub Flow repo has one long-lived branch, so `/chronicle:release` commits the bump on the base by design.
          if (!config.base || branch !== config.base) return;
          if (e.command.includes("🔧 release:")) return;
          return `⚠️ You're on \`${branch}\`, the configured GitHub Flow PR base. Commit from a topic branch, or confirm explicitly before retrying.`;
        }
        if (config.workflow === "git-flow") {
          if (!config.production || branch !== config.production) return;
          return `⚠️ You're on \`${branch}\`, the configured Git Flow production branch. Commit on \`${config.development ?? ""}\`, or confirm explicitly before retrying.`;
        }

        const develop = await git("config", "--get", "gitflow.branch.develop");
        if (!develop) return;
        const production = await git(
          "config",
          "--get",
          "gitflow.branch.master",
        );
        if (
          (production && branch === production) ||
          branch === "main" ||
          branch === "master"
        ) {
          return `⚠️ You're on \`${branch}\` in a git-flow repo. Commit on \`${develop}\`, or confirm explicitly before retrying.`;
        }
      };

      const reason = await ask();
      const below = await next(e);
      if (reason === undefined || below.deny !== undefined) return below;
      return { ...below, allow: undefined, ask: reason };
    },
  );
};
