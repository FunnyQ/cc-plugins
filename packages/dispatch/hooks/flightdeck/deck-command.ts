// tool.call matcher: a command that runs flightdeck.ts and passes --plan.
// The lookarounds pin the file name, so flightdeck.test.ts and myflightdeck.ts never open the pane.
export const FLIGHTDECK_COMMAND =
  /(?<![\w.-])flightdeck\.ts(?![\w.-])[\s\S]*?\s--plan(?:=|\s)/;

const PLAN = /\s--plan(?:=|\s+)(?:"([^"]*)"|'([^']*)'|([^\s"']+))/;

// the --plan value: "--plan \"/a b\"", "--plan '/a'", "--plan=/a", "--plan /a"; null when absent
export function planArg(command: string): string | null {
  const m = PLAN.exec(command);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}
