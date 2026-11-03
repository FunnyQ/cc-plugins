import { join } from "node:path";
import { COMMIT_COMMAND } from "./commit-command.ts";

async function main() {
  let input;
  try {
    input = JSON.parse(await Bun.stdin.text());
  } catch {
    return;
  }
  if (input?.tool_name !== "Bash") return;
  const command = input.tool_input?.command;
  if (typeof command !== "string" || !COMMIT_COMMAND.test(command)) return;

  const result = Bun.spawnSync(
    ["bash", join(import.meta.dir, "check-branch.sh")],
    {
      cwd: typeof input.cwd === "string" ? input.cwd : process.cwd(),
      stdin: new TextEncoder().encode(JSON.stringify(input)),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (result.exitCode !== 0 || !result.stdout.length) return;
  const output = JSON.parse(result.stdout.toString());
  if (output.hookSpecificOutput?.permissionDecision !== "ask") return;
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: output.systemMessage.replace(
          ", or confirm explicitly before retrying.",
          ".",
        ),
      },
    }),
  );
}

await main();
