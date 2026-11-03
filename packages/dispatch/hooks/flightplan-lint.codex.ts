import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { lintFile } from "../skills/flightplan/scripts/lint-task.ts";
import { TASK_PATH } from "./task-path.ts";

async function main() {
  let input;
  try {
    input = JSON.parse(await Bun.stdin.text());
  } catch {
    return;
  }
  if (input?.tool_name !== "apply_patch") return;
  const patch = input.tool_input?.command;
  if (typeof patch !== "string") return;

  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  const files = new Set<string>();
  let current: string | undefined;
  for (const line of patch.split(/\r?\n/)) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      current = header[1] === "Delete" ? undefined : resolve(cwd, header[2]);
      if (current) files.add(current);
    } else if (line.startsWith("*** Move to: ") && current) {
      files.delete(current);
      current = resolve(cwd, line.slice("*** Move to: ".length));
      files.add(current);
    }
  }

  const feedback: string[] = [];
  for (const file of files) {
    if (!TASK_PATH.test(file) || !existsSync(file)) continue;
    const violations = await lintFile(file, { authoring: true });
    for (const violation of violations) {
      feedback.push(
        `${violation.file}  [${violation.rule}] ${violation.detail}`,
      );
    }
  }
  if (feedback.length === 0) return;
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: `flightplan lint violations:\n${feedback.join("\n")}`,
      },
    }),
  );
}

await main();
