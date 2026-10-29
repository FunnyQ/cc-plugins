export type RuntimeInfo = {
  platform: "darwin" | "linux" | "win32";
  wsl: boolean;
  home: string;
  tmp: string;
  chrome: string | null;
};

export type PlatformOperation =
  | { op: "info" }
  | { op: "mkdir"; directory: string }
  | { op: "open"; path: string }
  | { op: "trash"; paths: string[] }
  | { op: "cleanup-check"; page: string };

export const runtime: { info: RuntimeInfo | undefined } = { info: undefined };
export const platformCommand = (root: string) => ["bun", `${root}/hooks/platform-cli.ts`];
export const scratchRoot = (info: RuntimeInfo) =>
  info.platform === "win32"
    ? `${info.tmp.replace(/[\\/]$/, "")}/q-lab/runes`
    : "/tmp/q-lab/runes";
export const childEnv = (info: RuntimeInfo): Record<string, string> =>
  info.platform === "win32"
    ? { HOME: info.home, USERPROFILE: info.home }
    : { HOME: info.home };

export const resolveRuntime = (
  platform: string,
  env: Record<string, string | undefined>,
  tmp: string,
  version: string,
): RuntimeInfo => {
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32")
    throw new Error(`unsupported platform: ${platform}`);
  const home = env.HOME || (platform === "win32" ? env.USERPROFILE : undefined);
  if (!home) throw new Error("could not resolve home: HOME (or USERPROFILE on Windows) is empty");
  return {
    platform,
    wsl: platform === "linux" && (!!env.WSL_DISTRO_NAME || /microsoft/i.test(version)),
    home,
    tmp,
    chrome: null,
  };
};

export const parseOperation = (input: string): PlatformOperation => {
  const value: unknown = JSON.parse(input);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("expected an operation object");
  const data = value as Record<string, unknown>;
  const path = (v: unknown): v is string => typeof v === "string" && v.length > 0 && !v.includes("\0");
  const keys = (...names: string[]) =>
    Object.keys(data).length === names.length && names.every(name => Object.hasOwn(data, name));
  if (data.op === "info" && keys("op")) return { op: "info" };
  if (data.op === "mkdir" && keys("op", "directory") && path(data.directory))
    return { op: "mkdir", directory: data.directory };
  if (data.op === "open" && keys("op", "path") && path(data.path))
    return { op: "open", path: data.path };
  if (data.op === "trash" && keys("op", "paths") && Array.isArray(data.paths) && data.paths.length > 0 && data.paths.every(path))
    return { op: "trash", paths: data.paths };
  if (data.op === "cleanup-check" && keys("op", "page") && path(data.page) && /\.html$/.test(data.page))
    return { op: "cleanup-check", page: data.page };
  throw new Error(`unknown operation or invalid payload: ${String(data.op)}`);
};
