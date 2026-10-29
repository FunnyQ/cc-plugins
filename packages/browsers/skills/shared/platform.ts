import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { posix, win32 } from "node:path";

export type BrowserName = "chrome" | "firefox" | "zen";
export type Platform = "darwin" | "linux" | "win32";
export type PlatformInput = {
  platform: Platform;
  env: Record<string, string | undefined>;
  wsl: boolean;
};

export function nativePlatformInput(
  platform: Platform = process.platform as Platform,
  env: PlatformInput["env"] = process.env,
  kernelVersion: () => string = () => readFileSync("/proc/version", "utf8"),
): PlatformInput {
  let wsl = platform === "linux" && !!env.WSL_DISTRO_NAME;
  if (platform === "linux" && !wsl) {
    try {
      wsl = /microsoft/i.test(kernelVersion());
    } catch {}
  }
  return { platform, env, wsl };
}

const MACOS: Record<BrowserName, string[]> = {
  chrome: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  firefox: [
    "/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox",
    "/Applications/Firefox.app/Contents/MacOS/firefox",
    "/Applications/Firefox Nightly.app/Contents/MacOS/firefox",
  ],
  zen: ["/Applications/Zen.app/Contents/MacOS/zen"],
};

const LINUX: Record<BrowserName, string[]> = {
  chrome: [
    "chrome",
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "/opt/google/chrome/chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ],
  firefox: [
    "firefox",
    "firefox-esr",
    "/usr/bin/firefox",
    "/usr/bin/firefox-esr",
    "/opt/firefox/firefox",
    "/snap/bin/firefox",
  ],
  zen: [
    "zen",
    "zen-browser",
    "/usr/bin/zen",
    "/usr/bin/zen-browser",
    "/opt/zen/zen",
  ],
};

function windowsEnv(
  env: PlatformInput["env"],
  name: string,
): string | undefined {
  const key = Object.keys(env).find(
    (key) => key.toLowerCase() === name.toLowerCase(),
  );
  return key === undefined ? undefined : env[key];
}

export function browserCandidates(
  name: BrowserName,
  input: PlatformInput = nativePlatformInput(),
): string[] {
  if (input.platform === "darwin") return [...MACOS[name]];
  if (input.platform === "linux") return [...LINUX[name]];
  if (name !== "chrome") return [];
  const roots = ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]
    .map((key) => windowsEnv(input.env, key))
    .filter((root): root is string => !!root);
  return [
    ...new Set(
      roots.map((root) =>
        win32.join(root, "Google", "Chrome", "Application", "chrome.exe"),
      ),
    ),
  ];
}

export function browserStateDir(
  name: BrowserName,
  platform: Platform = process.platform as Platform,
  env: PlatformInput["env"] = process.env,
): string {
  const path = platform === "win32" ? win32 : posix;
  const browser = name === "zen" ? "firefox" : name;
  const privateRoot =
    platform === "win32"
      ? windowsEnv(env, "Q_BROWSER_STATE_DIR")
      : env.Q_BROWSER_STATE_DIR;
  if (privateRoot) {
    if (!path.isAbsolute(privateRoot))
      throw new Error("Q_BROWSER_STATE_DIR must be absolute");
    return path.join(privateRoot, browser);
  }
  if (platform !== "win32") return posix.join("/tmp/q-lab/browsers", browser);
  const systemTemp =
    windowsEnv(env, "TEMP") ||
    windowsEnv(env, "TMP") ||
    (process.platform === "win32"
      ? tmpdir()
      : win32.join(windowsEnv(env, "SystemRoot") || "C:\\Windows", "Temp"));
  return win32.join(systemTemp, "q-lab", "browsers", browser);
}
