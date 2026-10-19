export const FLIGHTDECK_COMMAND =
  /(?<![\w.-])flightdeck\.ts(?![\w.-])[\s\S]*?\s--plan(?:=|\s)/;

const LAUNCHER = /(?<![\w.-])flightdeck\.ts(?![\w.-])/;
const PLAN = /\s--plan(?:=|\s+)(?:"([^"]*)"|'([^']*)'|([^\s"']+))/;

const PLAN_LINE = /^flightdeck plan: (.+)$/m;

export function planFromOutput(stdout: string): string | null {
  return PLAN_LINE.exec(stdout)?.[1] ?? null;
}

export function planArg(command: string): string | null {
  const at = LAUNCHER.exec(command);
  if (!at) return null;
  const call = command.slice(at.index).split(/[;&|]/)[0] ?? "";
  const m = PLAN.exec(call);
  const plan = m && (m[1] ?? m[2] ?? m[3]);
  return plan && !plan.includes("$") ? plan : null;
}
