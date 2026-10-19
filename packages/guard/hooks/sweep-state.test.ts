import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBaseline } from "./sweep-state.ts";

test("a lost baseline reads as none, so the sweep skips rather than misreports", () => {
  process.env.GUARD_STATE_DIR = mkdtempSync(join(tmpdir(), "guard-state-"));
  expect(readBaseline("../never-written")).toBeNull();
});
