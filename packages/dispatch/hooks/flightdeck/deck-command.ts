// tool.call matcher: a command that runs flightdeck.ts and passes --plan.
// The lookarounds pin the file name, so flightdeck.test.ts and myflightdeck.ts never open the pane.
export const FLIGHTDECK_COMMAND =
  /(?<![\w.-])flightdeck\.ts(?![\w.-])[\s\S]*?\s--plan(?:=|\s)/;

const LAUNCHER = /(?<![\w.-])flightdeck\.ts(?![\w.-])/;
const PLAN = /\s--plan(?:=|\s+)(?:"([^"]*)"|'([^']*)'|([^\s"']+))/;

// launch.ts's planLine, as printed into the Bash result's stdout
const PLAN_LINE = /^flightdeck plan: (.+)$/m;

export function planFromOutput(stdout: string): string | null {
  return PLAN_LINE.exec(stdout)?.[1] ?? null;
}

// the --plan value: "--plan \"/a b\"", "--plan '/a'", "--plan=/a", "--plan /a"; null when absent
// Read only within the flightdeck.ts call, and null for a $ value the shell expanded but the command text did not.
export function planArg(command: string): string | null {
  const at = LAUNCHER.exec(command);
  if (!at) return null;
  const call = command.slice(at.index).split(/[;&|]/)[0] ?? "";
  const m = PLAN.exec(call);
  const plan = m && (m[1] ?? m[2] ?? m[3]);
  return plan && !plan.includes("$") ? plan : null;
}
