import { describe, expect, test } from "bun:test";
import {
  browserCandidates,
  browserStateDir,
  nativePlatformInput,
  type Platform,
} from "./platform";

describe("browserCandidates", () => {
  test("preserves macOS product preference and independent Zen selection", () => {
    const input = { platform: "darwin", env: {}, wsl: false } as const;
    expect(browserCandidates("chrome", input)).toEqual([
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ]);
    expect(browserCandidates("firefox", input)).toEqual([
      "/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox",
      "/Applications/Firefox.app/Contents/MacOS/firefox",
      "/Applications/Firefox Nightly.app/Contents/MacOS/firefox",
    ]);
    expect(browserCandidates("zen", input)).toEqual([
      "/Applications/Zen.app/Contents/MacOS/zen",
    ]);
  });

  test("orders Linux executable names before standard product locations", () => {
    const input = { platform: "linux", env: {}, wsl: false } as const;
    expect(browserCandidates("chrome", input)).toEqual([
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
    ]);
    expect(browserCandidates("firefox", input)).toEqual([
      "firefox",
      "firefox-esr",
      "/usr/bin/firefox",
      "/usr/bin/firefox-esr",
      "/opt/firefox/firefox",
    ]);
    expect(browserCandidates("zen", input)).toEqual([
      "zen",
      "zen-browser",
      "/usr/bin/zen",
      "/usr/bin/zen-browser",
      "/opt/zen/zen",
    ]);
    for (const name of ["chrome", "firefox", "zen"] as const) {
      expect(
        browserCandidates(name, {
          ...input,
          wsl: true,
          env: { LOCALAPPDATA: "C:\\Users\\Q" },
        }),
      ).toEqual(browserCandidates(name, input));
    }
  });

  test("derives Windows Chrome paths from environment roots without host separators", () => {
    expect(
      browserCandidates("chrome", {
        platform: "win32",
        wsl: false,
        env: {
          ProgramFiles: "D:\\Programs",
          "ProgramFiles(x86)": "D:\\Programs (x86)",
          LOCALAPPDATA: "E:\\使用者 Q\\Local",
        },
      }),
    ).toEqual([
      "D:\\Programs\\Google\\Chrome\\Application\\chrome.exe",
      "D:\\Programs (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "E:\\使用者 Q\\Local\\Google\\Chrome\\Application\\chrome.exe",
    ]);
    expect(
      browserCandidates("chrome", { platform: "win32", wsl: false, env: {} }),
    ).toEqual([]);
    expect(
      browserCandidates("firefox", { platform: "win32", wsl: false, env: {} }),
    ).toEqual([]);
    expect(
      browserCandidates("zen", { platform: "win32", wsl: false, env: {} }),
    ).toEqual([]);
  });

  test("accepts Windows environment names case-insensitively and deduplicates roots", () => {
    expect(
      browserCandidates("chrome", {
        platform: "win32",
        wsl: false,
        env: { PROGRAMFILES: "D:\\Apps", "ProgramFiles(x86)": "D:\\Apps" },
      }),
    ).toEqual(["D:\\Apps\\Google\\Chrome\\Application\\chrome.exe"]);
  });
});

describe("browserStateDir", () => {
  test("preserves Unix paths and the shared Gecko registry", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(browserStateDir("chrome", platform, {})).toBe(
        "/tmp/q-lab/browsers/chrome",
      );
      expect(browserStateDir("firefox", platform, {})).toBe(
        "/tmp/q-lab/browsers/firefox",
      );
      expect(browserStateDir("zen", platform, {})).toBe(
        "/tmp/q-lab/browsers/firefox",
      );
    }
  });

  test("uses Windows system temp with Windows path semantics", () => {
    expect(
      browserStateDir("chrome", "win32", { TEMP: "D:\\使用者 Q\\Temp" }),
    ).toBe("D:\\使用者 Q\\Temp\\q-lab\\browsers\\chrome");
    expect(browserStateDir("chrome", "win32", { TMP: "E:\\Temp" })).toBe(
      "E:\\Temp\\q-lab\\browsers\\chrome",
    );
  });

  test("places private registries and profiles below the supplied absolute root", () => {
    expect(
      browserStateDir("chrome", "linux", {
        Q_BROWSER_STATE_DIR: "/tmp/private run",
      }),
    ).toBe("/tmp/private run/chrome");
    expect(
      browserStateDir("zen", "darwin", {
        Q_BROWSER_STATE_DIR: "/tmp/private run",
      }),
    ).toBe("/tmp/private run/firefox");
    expect(
      browserStateDir("chrome", "win32", {
        Q_BROWSER_STATE_DIR: "D:\\private run",
      }),
    ).toBe("D:\\private run\\chrome");
    expect(() =>
      browserStateDir("chrome", "linux", { Q_BROWSER_STATE_DIR: "relative" }),
    ).toThrow("Q_BROWSER_STATE_DIR must be absolute");
  });

  test("defaults to the runtime platform and environment", () => {
    expect(nativePlatformInput().platform).toBe(process.platform as Platform);
    expect(nativePlatformInput().env).toBe(process.env);
  });

  test("detects WSL from injected Linux distribution or kernel marker only", () => {
    expect(
      nativePlatformInput("linux", { WSL_DISTRO_NAME: "Ubuntu" }, () => "").wsl,
    ).toBe(true);
    expect(
      nativePlatformInput("linux", {}, () => "Linux MICROSOFT WSL2").wsl,
    ).toBe(true);
    expect(nativePlatformInput("linux", {}, () => "Linux generic").wsl).toBe(
      false,
    );
    expect(
      nativePlatformInput("darwin", { WSL_DISTRO_NAME: "Ubuntu" }, () => {
        throw new Error("must not read Linux kernel information");
      }).wsl,
    ).toBe(false);
    expect(
      nativePlatformInput("linux", {}, () => {
        throw new Error("missing proc");
      }).wsl,
    ).toBe(false);
  });
});
