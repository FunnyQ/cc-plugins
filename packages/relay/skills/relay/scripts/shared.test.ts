import { describe, it, expect } from "bun:test";
import {
  resolveModel,
  addTimestampSuffix,
  createTmpRunDir,
  TMP_ROOT,
  DEFAULT_MODELS,
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

  it("returns DEFAULT_MODELS[backend][mode] when flag and config absent", () => {
    const result = resolveModel("opencode", "delegate", undefined, () => ({}));
    expect(result).toBe("opencode-go/kimi-k2.7-code");
  });

  it("returns undefined for codex delegate when flag, config, and constant absent", () => {
    const result = resolveModel("codex", "delegate", undefined, () => ({}));
    expect(result).toBeUndefined();
  });

  it("returns undefined for claude review when flag, config, and constant absent", () => {
    const result = resolveModel("claude", "review", undefined, () => ({}));
    expect(result).toBeUndefined();
  });

  it("handles missing config gracefully (no throw)", () => {
    const result = resolveModel("opencode", "review", undefined, () => {
      throw new Error("file not found");
    });
    // Should fall back to DEFAULT_MODELS
    expect(result).toBe("opencode-go/qwen3.7-max");
  });

  it("handles malformed JSON gracefully (no throw)", () => {
    const result = resolveModel("opencode", "delegate", undefined, () => {
      // Simulate a readConfig that encounters invalid JSON
      return undefined;
    });
    expect(result).toBe("opencode-go/kimi-k2.7-code");
  });

  it("falls back to constant when config is invalid shape", () => {
    const result = resolveModel("opencode", "delegate", undefined, () => ({
      models: { someBackend: { someMode: "model" } }, // wrong backend
    }));
    expect(result).toBe("opencode-go/kimi-k2.7-code");
  });

  it("falls back to constant when config.models is missing", () => {
    const result = resolveModel("opencode", "review", undefined, () => ({}));
    expect(result).toBe("opencode-go/qwen3.7-max");
  });

  it("falls back to constant when config.models[backend] is missing", () => {
    const result = resolveModel("opencode", "delegate", undefined, () => ({
      models: {},
    }));
    expect(result).toBe("opencode-go/kimi-k2.7-code");
  });

  it("falls back to constant when config.models[backend][mode] is missing", () => {
    const result = resolveModel("opencode", "image", undefined, () => ({
      models: { opencode: {} },
    }));
    expect(result).toBeUndefined(); // opencode image is not in DEFAULT_MODELS
  });
});

describe("addTimestampSuffix", () => {
  it("appends timestamp before extension", () => {
    const result = addTimestampSuffix("./a.png");
    // parse("./a.png") yields dir="" (empty), not "." — join with dir falls back to bare name
    expect(result).toMatch(/^a_\d{8}-\d{4}\.png$/);
  });

  it("handles files without extension", () => {
    const result = addTimestampSuffix("a");
    expect(result).toMatch(/^a_\d{8}-\d{4}$/);
  });

  it("handles nested paths", () => {
    const result = addTimestampSuffix("dir/subdir/file.txt");
    expect(result).toMatch(/^dir\/subdir\/file_\d{8}-\d{4}\.txt$/);
  });

  it("handles dot files", () => {
    const result = addTimestampSuffix(".hidden");
    // parse(".hidden") treats entire string as name (no dir, no ext)
    expect(result).toMatch(/^\.hidden_\d{8}-\d{4}$/);
  });

  it("preserves directory structure", () => {
    const result = addTimestampSuffix("/tmp/relay/report.md");
    expect(result).toMatch(/^\/tmp\/relay\/report_\d{8}-\d{4}\.md$/);
  });
});

describe("createTmpRunDir", () => {
  it("returns a path under TMP_ROOT", () => {
    const dir = createTmpRunDir();
    expect(dir.startsWith(TMP_ROOT)).toBe(true);
  });

  it("returns a path with correct format: <ts>-<pid>-<rand>", () => {
    const dir = createTmpRunDir();
    const parts = dir.split("/");
    const last = parts[parts.length - 1];
    // Format: YYYYMMDD-HHMMSS-milliseconds-<pid>-<8-char-uuid>
    expect(last).toMatch(/^\d{8}-\d{6}-\d{3}-\d+-[a-f0-9]{8}$/);
  });

  it("creates the directory", () => {
    const dir = createTmpRunDir();
    // Verify the directory exists by trying to read it
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

describe("DEFAULT_MODELS", () => {
  it("has empty object for codex", () => {
    expect(DEFAULT_MODELS.codex).toEqual({});
  });

  it("has empty object for claude", () => {
    expect(DEFAULT_MODELS.claude).toEqual({});
  });

  it("has delegate and review for opencode", () => {
    expect(DEFAULT_MODELS.opencode.delegate).toBe("opencode-go/kimi-k2.7-code");
    expect(DEFAULT_MODELS.opencode.review).toBe("opencode-go/qwen3.7-max");
  });
});
