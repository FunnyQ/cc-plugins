/// <reference types="bun" />
import { mkdir, unlink } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseOperation, resolveRuntime, type PlatformOperation, type RuntimeInfo } from "./platform";

export const runtimeInfo = (): RuntimeInfo => {
  let version = "";
  if (process.platform === "linux") {
    try { version = readFileSync("/proc/version", "utf8"); } catch {}
  }
  return resolveRuntime(process.platform, process.env, tmpdir(), version);
};

type Result = { exitCode: number; stdout: string; stderr: string };
export type RunPlatformCommand = (argv: string[], stdin?: string) => Promise<Result>;
const runCommand: RunPlatformCommand = async (argv, stdin) => {
  const child = Bun.spawn(argv, {
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

const missingCommand = (error: unknown) => {
  const code = (error as { code?: string })?.code;
  return code === "ENOENT";
};
const checked = async (argv: string[], run: RunPlatformCommand, stdin?: string) => {
  let result: Result;
  try { result = await run(argv, stdin); }
  catch (error) {
    if (missingCommand(error)) throw new Error(`${argv[0]} is not available`, { cause: error });
    throw error;
  }
  if (result.exitCode !== 0)
    throw new Error(`${argv[0]} exited ${result.exitCode}: ${result.stderr.trim() || "operation failed"}`);
  return result.stdout;
};

const PS_INPUT = '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); $ErrorActionPreference = "Stop"; $payload = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd()); ';
const PS_OPEN = PS_INPUT + 'Start-Process -FilePath $payload.path -ErrorAction Stop';
const PS_TRASH = PS_INPUT + 'Add-Type -AssemblyName Microsoft.VisualBasic; foreach ($path in $payload.paths) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($path, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin, [Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException) }';
const powershell = (source: string) => [
  "powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand",
  Buffer.from(source, "utf16le").toString("base64"),
];

const openWindows = async (path: string, run: RunPlatformCommand) => {
  // cmd expands percent/environment and metacharacters even when an argument is quoted.
  if (/[%&^|<>!"\r\n()]/.test(path)) {
    await checked(powershell(PS_OPEN), run, JSON.stringify({ path }));
  } else {
    await checked(["cmd.exe", "/d", "/c", "start", "", path], run);
  }
};

export const openArtifact = async (
  path: string,
  info = runtimeInfo(),
  run: RunPlatformCommand = runCommand,
) => {
  if (path.startsWith("file:")) path = fileURLToPath(new URL(path));
  if (info.platform === "darwin") return checked(["open", path], run);
  if (info.platform === "win32") return openWindows(path, run);
  if (!info.wsl) return checked(["xdg-open", path], run);
  let viewError: string;
  try {
    const result = await run(["wslview", path]);
    if (result.exitCode === 0) return;
    viewError = `wslview exited ${result.exitCode}: ${result.stderr.trim() || "operation failed"}`;
  } catch (error) {
    if (!missingCommand(error)) throw error;
    viewError = "wslview is not available";
  }
  try {
    const converted = (await checked(["wslpath", "-w", path], run)).trimEnd();
    if (!converted) throw new Error("wslpath returned an empty Windows path");
    await openWindows(converted, run);
  } catch (error) {
    throw new Error(`${viewError}; Windows fallback failed: ${error instanceof Error ? error.message : String(error)}`);
  }
};

export const executeOperation = async (
  operation: PlatformOperation,
  info?: RuntimeInfo,
  run: RunPlatformCommand = runCommand,
): Promise<RuntimeInfo | undefined> => {
  switch (operation.op) {
    case "info": return info ?? runtimeInfo();
    case "mkdir": await mkdir(operation.directory, { recursive: true }); return;
    case "open": await openArtifact(operation.path, info ?? runtimeInfo(), run); return;
    case "trash": {
      const platform = (info ?? runtimeInfo()).platform;
      if (platform === "win32") {
        await checked(powershell(PS_TRASH), run, JSON.stringify({ paths: operation.paths }));
        return;
      }
      if (platform === "darwin") {
        await checked(["trash", ...operation.paths], run);
        return;
      }
      for (const argv of [["trash-put", ...operation.paths], ["gio", "trash", "--", ...operation.paths]]) {
        try {
          const result = await run(argv);
          if (result.exitCode !== 0) throw new Error(`${argv[0]} exited ${result.exitCode}: ${result.stderr.trim() || "recycling failed"}`);
          return;
        } catch (error) {
          if (!missingCommand(error)) throw error;
        }
      }
      throw new Error("no recoverable trash facility is available (trash-put or gio required); pages retained");
    }
    case "cleanup-check": {
      const base = operation.page.replace(/\.html$/, "");
      for (const path of [`${base}.check.png`, `${base}.check-narrow.png`]) {
        try { await unlink(path); }
        catch (error) { if ((error as { code?: string }).code !== "ENOENT") throw error; }
      }
      return;
    }
  }
};

if (import.meta.main) {
  try {
    if (process.argv.length !== 2) throw new Error("operations must be supplied as JSON on stdin");
    const operation = parseOperation(await Bun.stdin.text());
    const result = await executeOperation(operation);
    if (result !== undefined) console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`runes platform: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
