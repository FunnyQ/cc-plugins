/// <reference types="bun" />
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { discoverChrome } from "../platform-cli";

type Screenshot = { mode: "wide" | "narrow"; page: string };

export const parseScreenshotArgs = (args: string[]): Screenshot => {
  const [mode, page] = args;
  if (args.length !== 2 || (mode !== "wide" && mode !== "narrow") ||
      !page || !page.endsWith(".html") || page.includes("\0"))
    throw new Error("expected wide|narrow and one .html page");
  return { mode, page };
};

export const takeScreenshot = async (
  { mode, page }: Screenshot,
  discover: () => string | null = discoverChrome,
  run: (argv: string[]) => Promise<number> = async argv => {
    const child = Bun.spawn(argv, { stdout: "ignore", stderr: "inherit" });
    return child.exited;
  },
): Promise<string> => {
  const chrome = discover();
  if (chrome === null) throw new Error("no Chrome");
  page = resolve(page);
  const output = page.replace(/\.html$/, mode === "wide" ? ".check.png" : ".check-narrow.png");
  const profile = mkdtempSync(join(tmpdir(), "runes-check-"));
  try {
    const exitCode = await run([
      chrome,
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      `--window-size=${mode === "wide" ? "1280,4000" : "420,7000"}`,
      `--screenshot=${output}`,
      `--user-data-dir=${profile}`,
      pathToFileURL(page).href,
    ]);
    if (exitCode !== 0) throw new Error(`Chrome exited ${exitCode}`);
    return output;
  } finally {
    rmSync(profile, { recursive: true, force: true, maxRetries: 10 });
  }
};

if (import.meta.main) {
  try {
    const output = await takeScreenshot(parseScreenshotArgs(process.argv.slice(2)));
    console.log(JSON.stringify({ output }));
  } catch (error) {
    console.error(`runes checker: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
