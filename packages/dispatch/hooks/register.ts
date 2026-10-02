/**
 * flightplan-lint as a Claude Code mod: the matcher rejects every path outside
 * a flightplan tasks tree before the hook runs, so an unrelated Edit or Write
 * spawns nothing. Violations ride back as the result's `context`, which the
 * model reads the way it read the command hook's exit-2 stderr. OpenCode keeps
 * flightplan-lint.sh, since it has no function hooks.
 */

import type { Register } from "claude-code";
import { TASK_PATH } from "./task-path.ts";

export const register: Register = (on) => {
  on(
    "tool.call",
    { tool: ["Edit", "Write"], file_path: TASK_PATH },
    async ($, e, next) => {
      const ran = await next(e);
      if (ran.deny !== undefined || ran.isError) return ran;
      if ((ran.result as { staged?: boolean }).staged) return ran;

      // --authoring adds the task-size check, which only the author's own write should face, and passes a file without the task header.
      const lint = await $.process.run([
        "bun",
        `${$.plugin.root}/skills/flightplan/scripts/lint-task.ts`,
        "--authoring",
        e.file_path,
      ]);
      if (lint.exitCode === 0) return ran;

      const output = `${lint.stdout}${lint.stderr}`.trimEnd();
      return {
        ...ran,
        context: [
          ...(ran.context ?? []),
          `flightplan lint violations in ${e.file_path}:\n${output}`,
        ],
      };
    },
  );
};
