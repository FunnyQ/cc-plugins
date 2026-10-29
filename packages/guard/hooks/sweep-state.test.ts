import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ledgerKey,
  readBaseline,
  readReported,
  recordReported,
} from "./sweep-state.ts";

test("a lost baseline reads as none, so the sweep skips rather than misreports", () => {
  process.env.GUARD_STATE_DIR = mkdtempSync(join(tmpdir(), "guard-state-"));
  expect(readBaseline("../never-written")).toBeNull();
});

test("GUARD_STATE_DIR still overrides the state dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-state-"));
  process.env.GUARD_STATE_DIR = dir;
  recordReported("s", "/x/a.ts", ["// a"]);
  expect(existsSync(join(dir, "s.reported.jsonl"))).toBe(true);
});

describe("ledgerKey", () => {
  // windows.md: tmpdir() is an 8.3 short name on the runner; only .native expands it.
  const real = realpathSync.native(mkdtempSync(join(tmpdir(), "ledger-key-")));
  writeFileSync(join(real, "a.ts"), "");

  // windows.md: NTFS paths are case-insensitive, so win32 keys fold case.
  test("lower-cases on win32 only", () => {
    expect(ledgerKey(join(real, "Gone.ts"), "win32")).toBe(
      join(real, "Gone.ts").toLowerCase(),
    );
    expect(ledgerKey(join(real, "Gone.ts"), "darwin")).toBe(
      join(real, "Gone.ts"),
    );
  });

  test("a symlinked or dotted spelling keys like the canonical path", () => {
    const link = join(mkdtempSync(join(tmpdir(), "ledger-link-")), "l");
    symlinkSync(real, link);
    const canonical = ledgerKey(join(real, "a.ts"));
    expect(ledgerKey(join(link, "a.ts"))).toBe(canonical);
    expect(ledgerKey(join(real, "sub", "..", "a.ts"))).toBe(canonical);
  });

  test("a missing tail resolves the ancestor and keeps the segments", () => {
    const link = join(mkdtempSync(join(tmpdir(), "ledger-link-")), "l");
    symlinkSync(real, link);
    const want = join(real, "gone", "b.ts");
    expect(ledgerKey(join(link, "gone", "b.ts"))).toBe(
      process.platform === "win32" ? want.toLowerCase() : want,
    );
  });

  test("an old ledger line under another spelling still matches", () => {
    process.env.GUARD_STATE_DIR = mkdtempSync(join(tmpdir(), "guard-state-"));
    const link = join(mkdtempSync(join(tmpdir(), "ledger-link-")), "l");
    symlinkSync(real, link);
    appendFileSync(
      join(process.env.GUARD_STATE_DIR, "old.reported.jsonl"),
      JSON.stringify({ file: join(link, "a.ts"), texts: ["// a"] }) + "\n",
    );
    expect(readReported("old").get(ledgerKey(join(real, "a.ts")))).toEqual(
      new Map([["// a", 1]]),
    );
  });
});
