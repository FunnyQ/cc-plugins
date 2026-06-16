import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { configPath, getLanguage, readConfig, setLanguage } from "./config";

function tempConfigHome(): string {
  return mkdtempSync(join(tmpdir(), "cockpit-config-"));
}

function writeConfig(value: unknown): void {
  mkdirSync(dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(value, null, 2) + "\n");
}

describe("cockpit global config", () => {
  test("round-trips log_language and writes valid JSON at the XDG path", () => {
    const tempDir = tempConfigHome();
    const oldXDG = process.env.XDG_CONFIG_HOME;
    try {
      process.env.XDG_CONFIG_HOME = tempDir;

      setLanguage("French");

      expect(getLanguage()).toBe("French");
      expect(configPath()).toBe(
        join(tempDir, "q-lab", "cockpit", "config.json"),
      );
      expect(existsSync(configPath())).toBe(true);
      expect(JSON.parse(readFileSync(configPath(), "utf8"))).toEqual({
        log_language: "French",
      });
    } finally {
      process.env.XDG_CONFIG_HOME = oldXDG;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("returns English when the config file is missing", () => {
    const tempDir = tempConfigHome();
    const oldXDG = process.env.XDG_CONFIG_HOME;
    try {
      process.env.XDG_CONFIG_HOME = tempDir;

      expect(getLanguage()).toBe("English");
    } finally {
      process.env.XDG_CONFIG_HOME = oldXDG;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("returns English when log_language is absent", () => {
    const tempDir = tempConfigHome();
    const oldXDG = process.env.XDG_CONFIG_HOME;
    try {
      process.env.XDG_CONFIG_HOME = tempDir;
      writeConfig({ other_key: "value" });

      expect(getLanguage()).toBe("English");
    } finally {
      process.env.XDG_CONFIG_HOME = oldXDG;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("returns English when log_language is blank", () => {
    const tempDir = tempConfigHome();
    const oldXDG = process.env.XDG_CONFIG_HOME;
    try {
      process.env.XDG_CONFIG_HOME = tempDir;
      writeConfig({ log_language: "   \n\t" });

      expect(getLanguage()).toBe("English");
    } finally {
      process.env.XDG_CONFIG_HOME = oldXDG;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("readConfig returns an empty object when the config file is missing", () => {
    const tempDir = tempConfigHome();
    const oldXDG = process.env.XDG_CONFIG_HOME;
    try {
      process.env.XDG_CONFIG_HOME = tempDir;

      expect(readConfig()).toEqual({});
    } finally {
      process.env.XDG_CONFIG_HOME = oldXDG;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("readConfig returns an empty object for invalid JSON", () => {
    const tempDir = tempConfigHome();
    const oldXDG = process.env.XDG_CONFIG_HOME;
    try {
      process.env.XDG_CONFIG_HOME = tempDir;
      mkdirSync(dirname(configPath()), { recursive: true });
      writeFileSync(configPath(), "{ nope");

      expect(readConfig()).toEqual({});
    } finally {
      process.env.XDG_CONFIG_HOME = oldXDG;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("setLanguage preserves unrelated keys", () => {
    const tempDir = tempConfigHome();
    const oldXDG = process.env.XDG_CONFIG_HOME;
    try {
      process.env.XDG_CONFIG_HOME = tempDir;
      writeConfig({ other_key: "value" });

      setLanguage("French");

      expect(JSON.parse(readFileSync(configPath(), "utf8"))).toEqual({
        other_key: "value",
        log_language: "French",
      });
    } finally {
      process.env.XDG_CONFIG_HOME = oldXDG;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("setLanguage preserves multiple unrelated keys across a round-trip", () => {
    const tempDir = tempConfigHome();
    const oldXDG = process.env.XDG_CONFIG_HOME;
    try {
      process.env.XDG_CONFIG_HOME = tempDir;
      writeConfig({ one: 1, nested: { enabled: true }, list: ["a", "b"] });

      setLanguage("French");

      expect(JSON.parse(readFileSync(configPath(), "utf8"))).toEqual({
        one: 1,
        nested: { enabled: true },
        list: ["a", "b"],
        log_language: "French",
      });
    } finally {
      process.env.XDG_CONFIG_HOME = oldXDG;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("configPath respects XDG_CONFIG_HOME and operations stay isolated", () => {
    const tempDir = tempConfigHome();
    const oldXDG = process.env.XDG_CONFIG_HOME;
    try {
      process.env.XDG_CONFIG_HOME = tempDir;

      expect(configPath()).toBe(
        join(tempDir, "q-lab", "cockpit", "config.json"),
      );
      setLanguage("Japanese");
      expect(readConfig()).toEqual({ log_language: "Japanese" });
    } finally {
      process.env.XDG_CONFIG_HOME = oldXDG;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("getLanguage and readConfig do not throw on corrupt JSON", () => {
    const tempDir = tempConfigHome();
    const oldXDG = process.env.XDG_CONFIG_HOME;
    try {
      process.env.XDG_CONFIG_HOME = tempDir;
      mkdirSync(dirname(configPath()), { recursive: true });
      writeFileSync(configPath(), "{ broken");

      expect(() => getLanguage()).not.toThrow();
      expect(getLanguage()).toBe("English");
      expect(() => readConfig()).not.toThrow();
      expect(readConfig()).toEqual({});
    } finally {
      process.env.XDG_CONFIG_HOME = oldXDG;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
