import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { basename, join } from "path";
import { tmpdir } from "os";
import {
  CLI_DEFAULT,
  SUGGESTED_CONFIG_PATH,
  resolveModel,
  addTimestampSuffix,
  createTmpRunDir,
  TMP_ROOT,
  tmpRoot,
  timestampForPath,
} from "./shared";
import type { Mode } from "./types";

describe("resolveModel", () => {
  it("returns flag when provided (highest precedence)", () => {
    const result = resolveModel("codex", "delegate", "my-model", () => ({
      models: { codex: { delegate: "config-model" } },
    }));
    expect(result).toBe("my-model");
  });

  it("returns config.models[backend][mode] when flag absent", () => {
    const result = resolveModel("opencode", "delegate", undefined, () => ({
      models: { opencode: { delegate: "config-model" } },
    }));
    expect(result).toBe("config-model");
  });

  it("returns undefined when flag and config are absent, so the CLI picks its own model", () => {
    for (const backend of ["opencode", "codex", "claude"]) {
      expect(
        resolveModel(backend, "delegate", undefined, () => ({})),
      ).toBeUndefined();
      expect(
        resolveModel(backend, "review", undefined, () => ({})),
      ).toBeUndefined();
    }
  });

  it("returns undefined when config has no entry for this backend or mode", () => {
    expect(
      resolveModel("opencode", "delegate", undefined, () => ({
        models: { codex: { delegate: "model" } },
      })),
    ).toBeUndefined();
    expect(
      resolveModel("opencode", "review", undefined, () => ({
        models: { opencode: { delegate: "model" } },
      })),
    ).toBeUndefined();
  });

  it("maps cli-default to undefined, from the flag or the config", () => {
    expect(
      resolveModel("opencode", "delegate", CLI_DEFAULT, () => ({})),
    ).toBeUndefined();
    expect(
      resolveModel("opencode", "review", undefined, () => ({
        models: { opencode: { review: CLI_DEFAULT } },
      })),
    ).toBeUndefined();
  });

  it("lets a config read error propagate instead of looking like nothing configured", () => {
    expect(() =>
      resolveModel("opencode", "delegate", undefined, () => {
        throw new Error("Unexpected token");
      }),
    ).toThrow("Unexpected token");
  });
});

describe("addTimestampSuffix", () => {
  it("appends timestamp before extension, returning a bare name when parse yields an empty dir", () => {
    const result = addTimestampSuffix("./a.png");
    expect(result).toMatch(/^a_\d{8}-\d{4}\.png$/);
  });

  it("handles files without extension", () => {
    const result = addTimestampSuffix("a");
    expect(result).toMatch(/^a_\d{8}-\d{4}$/);
  });

  it("handles nested paths", () => {
    const result = addTimestampSuffix("dir/subdir/file.txt");
    expect(result.startsWith(join("dir", "subdir", "file_"))).toBe(true);
    expect(result).toMatch(/file_\d{8}-\d{4}\.txt$/);
  });

  it("treats a dot file as all name, no extension", () => {
    const result = addTimestampSuffix(".hidden");
    expect(result).toMatch(/^\.hidden_\d{8}-\d{4}$/);
  });

  it("preserves directory structure", () => {
    const result = addTimestampSuffix("/tmp/relay/report.md");
    expect(result.startsWith(join("/tmp/relay", "report_"))).toBe(true);
    expect(result).toMatch(/report_\d{8}-\d{4}\.md$/);
  });
});

describe("createTmpRunDir", () => {
  it("roots under the q-lab namespace, absolute on every platform", () => {
    expect(tmpRoot("darwin")).toBe("/tmp/q-lab/relay/relay");
    expect(tmpRoot("linux")).toBe("/tmp/q-lab/relay/relay");
    expect(tmpRoot("win32")).toBe(join(tmpdir(), "q-lab", "relay", "relay"));
    expect(TMP_ROOT).toBe(tmpRoot());
  });

  it("returns a path under TMP_ROOT", () => {
    const dir = createTmpRunDir();
    expect(dir.startsWith(TMP_ROOT)).toBe(true);
  });

  it("returns a path with correct format: <ts>-<pid>-<rand>", () => {
    const dir = createTmpRunDir();
    expect(basename(dir)).toMatch(/^\d{8}-\d{6}-\d{3}-\d+-[a-f0-9]{8}$/);
  });

  it("creates the directory", () => {
    const dir = createTmpRunDir();
    const entries = Bun.file(dir);
    expect(entries).toBeDefined();
  });
});

describe("timestampForPath", () => {
  it("returns YYYYMMDD-HHMMSS-milliseconds format", () => {
    const now = new Date(2025, 5, 15, 14, 30, 45, 123); // June 15, 2025 14:30:45.123
    const result = timestampForPath(now);
    expect(result).toBe("20250615-143045-123");
  });

  it("pads month correctly", () => {
    const now = new Date(2025, 0, 5, 9, 5, 3, 7); // Jan 5, 2025 09:05:03.007
    const result = timestampForPath(now);
    expect(result).toBe("20250105-090503-007");
  });
});

describe("the shipped suggested config", () => {
  const suggested = JSON.parse(readFileSync(SUGGESTED_CONFIG_PATH, "utf-8"));

  it("carries a version and provider/model ids for opencode delegate and review", () => {
    expect(Number.isInteger(suggested.version)).toBe(true);
    expect(String(suggested.version)).toMatch(/^\d{10}$/);
    for (const mode of ["delegate", "review"]) {
      expect(suggested.models.opencode[mode]).toMatch(/^[\w-]+\/.+/);
      for (const id of suggested.suggestions.opencode[mode]) {
        expect(id).toMatch(/^[\w-]+\/.+/);
      }
    }
  });
});
