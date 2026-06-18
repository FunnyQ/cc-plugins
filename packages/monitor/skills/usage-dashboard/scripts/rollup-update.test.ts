import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allHourlyRows, openRollupDb } from "./rollup-db";
import { updateRollup } from "./rollup-update";

// A minimal assistant transcript line. `ts` drives the hour bucket; `req`/`msg`
// drive billing dedup; `inp` is the input-token count.
function line(opts: {
  ts: string;
  req: string;
  msg: string;
  model?: string;
  cwd?: string;
  inp: number;
}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: opts.ts,
    requestId: opts.req,
    cwd: opts.cwd ?? "/proj/a",
    message: {
      id: opts.msg,
      model: opts.model ?? "claude-opus-4-7",
      usage: { input_tokens: opts.inp, output_tokens: 0 },
    },
  });
}

function grandTotal(db: ReturnType<typeof openRollupDb>): number {
  return allHourlyRows(db).reduce(
    (s, r) =>
      s + r.input_tokens + r.output_tokens + r.cache_read + r.cache_creation,
    0,
  );
}

let dir: string;
let db: ReturnType<typeof openRollupDb>;
const NOW = 1_700_000_000_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rollup-test-"));
  mkdirSync(join(dir, "session-a"), { recursive: true });
  db = openRollupDb(":memory:");
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function writeLines(file: string, lines: string[], trailingNewline = true) {
  writeFileSync(
    join(dir, file),
    lines.join("\n") + (trailingNewline ? "\n" : ""),
  );
}

describe("updateRollup", () => {
  test("ingests complete lines", () => {
    writeLines("session-a/x.jsonl", [
      line({ ts: "2026-06-17T10:00:00Z", req: "r1", msg: "m1", inp: 100 }),
      line({ ts: "2026-06-17T10:05:00Z", req: "r2", msg: "m2", inp: 50 }),
    ]);
    updateRollup(db, { projectsDir: dir, nowMs: NOW });
    expect(grandTotal(db)).toBe(150);
  });

  test("tail-parse adds only the appended lines", () => {
    writeLines("session-a/x.jsonl", [
      line({ ts: "2026-06-17T10:00:00Z", req: "r1", msg: "m1", inp: 100 }),
    ]);
    updateRollup(db, { projectsDir: dir, nowMs: NOW });
    expect(grandTotal(db)).toBe(100);

    // Append a second line; the first must not be re-counted.
    writeLines("session-a/x.jsonl", [
      line({ ts: "2026-06-17T10:00:00Z", req: "r1", msg: "m1", inp: 100 }),
      line({ ts: "2026-06-17T11:00:00Z", req: "r2", msg: "m2", inp: 30 }),
    ]);
    updateRollup(db, { projectsDir: dir, nowMs: NOW });
    expect(grandTotal(db)).toBe(130);
  });

  test("warm re-run with no changes is idempotent", () => {
    writeLines("session-a/x.jsonl", [
      line({ ts: "2026-06-17T10:00:00Z", req: "r1", msg: "m1", inp: 100 }),
      line({ ts: "2026-06-17T10:05:00Z", req: "r2", msg: "m2", inp: 50 }),
    ]);
    updateRollup(db, { projectsDir: dir, nowMs: NOW });
    updateRollup(db, { projectsDir: dir, nowMs: NOW });
    updateRollup(db, { projectsDir: dir, nowMs: NOW });
    expect(grandTotal(db)).toBe(150);
  });

  test("a trailing partial line is not counted until its newline arrives", () => {
    const l1 = line({
      ts: "2026-06-17T10:00:00Z",
      req: "r1",
      msg: "m1",
      inp: 100,
    });
    const l2 = line({
      ts: "2026-06-17T11:00:00Z",
      req: "r2",
      msg: "m2",
      inp: 40,
    });
    // l2 has no trailing newline — still being written.
    writeFileSync(join(dir, "session-a/x.jsonl"), l1 + "\n" + l2);
    updateRollup(db, { projectsDir: dir, nowMs: NOW });
    expect(grandTotal(db)).toBe(100);

    // Now the line is completed.
    writeFileSync(join(dir, "session-a/x.jsonl"), l1 + "\n" + l2 + "\n");
    updateRollup(db, { projectsDir: dir, nowMs: NOW });
    expect(grandTotal(db)).toBe(140);
  });

  test("truncation triggers a full rebuild", () => {
    writeLines("session-a/x.jsonl", [
      line({ ts: "2026-06-17T10:00:00Z", req: "r1", msg: "m1", inp: 100 }),
      line({ ts: "2026-06-17T10:05:00Z", req: "r2", msg: "m2", inp: 50 }),
    ]);
    updateRollup(db, { projectsDir: dir, nowMs: NOW });
    expect(grandTotal(db)).toBe(150);

    // File shrinks (rewritten with different content) — additive reconcile is
    // impossible, so the whole rollup is rebuilt from the new on-disk state.
    writeLines("session-a/x.jsonl", [
      line({ ts: "2026-06-17T10:00:00Z", req: "r9", msg: "m9", inp: 7 }),
    ]);
    const res = updateRollup(db, { projectsDir: dir, nowMs: NOW });
    expect(res.rebuilt).toBe(true);
    expect(grandTotal(db)).toBe(7);
  });

  test("dedups one request split across two ingest batches", () => {
    // Same requestId:messageId appearing again in an appended line must be
    // billed once (Claude persists multiple snapshots per request).
    writeLines("session-a/x.jsonl", [
      line({ ts: "2026-06-17T10:00:00Z", req: "r1", msg: "m1", inp: 100 }),
    ]);
    updateRollup(db, { projectsDir: dir, nowMs: NOW });
    writeLines("session-a/x.jsonl", [
      line({ ts: "2026-06-17T10:00:00Z", req: "r1", msg: "m1", inp: 100 }),
      line({ ts: "2026-06-17T10:00:30Z", req: "r1", msg: "m1", inp: 100 }),
    ]);
    updateRollup(db, { projectsDir: dir, nowMs: NOW });
    expect(grandTotal(db)).toBe(100);
  });

  test("separate local-hour timestamps land in separate buckets", () => {
    writeLines("session-a/x.jsonl", [
      line({ ts: "2026-06-17T10:00:00Z", req: "r1", msg: "m1", inp: 10 }),
      line({ ts: "2026-06-17T10:59:00Z", req: "r2", msg: "m2", inp: 20 }),
      line({ ts: "2026-06-17T12:00:00Z", req: "r3", msg: "m3", inp: 30 }),
    ]);
    updateRollup(db, { projectsDir: dir, nowMs: NOW });
    const hours = new Set(allHourlyRows(db).map((r) => r.hour_ms));
    // Two of the three share an hour bucket → 2 distinct buckets.
    expect(hours.size).toBe(2);
    expect(grandTotal(db)).toBe(60);
  });

  test("deleting a transcript keeps its already-aggregated tokens", () => {
    writeLines("session-a/x.jsonl", [
      line({ ts: "2026-06-17T10:00:00Z", req: "r1", msg: "m1", inp: 100 }),
    ]);
    updateRollup(db, { projectsDir: dir, nowMs: NOW });
    rmSync(join(dir, "session-a/x.jsonl"));
    updateRollup(db, { projectsDir: dir, nowMs: NOW });
    // History survives the deletion — that's the whole point of the rollup.
    expect(grandTotal(db)).toBe(100);
    // ...but the file is forgotten, so a same-name file re-adds cleanly.
    writeLines("session-a/x.jsonl", [
      line({ ts: "2026-06-17T10:00:00Z", req: "r2", msg: "m2", inp: 5 }),
    ]);
    updateRollup(db, { projectsDir: dir, nowMs: NOW });
    expect(grandTotal(db)).toBe(105);
  });

  test("pruning a deleted file clears its seen_requests but not its tokens", () => {
    const seenCount = () =>
      (
        db.query("SELECT COUNT(*) AS n FROM seen_requests").get() as {
          n: number;
        }
      ).n;
    writeLines("session-a/x.jsonl", [
      line({ ts: "2026-06-17T10:00:00Z", req: "r1", msg: "m1", inp: 100 }),
      line({ ts: "2026-06-17T10:05:00Z", req: "r2", msg: "m2", inp: 50 }),
    ]);
    updateRollup(db, { projectsDir: dir, nowMs: NOW });
    expect(seenCount()).toBe(2);

    rmSync(join(dir, "session-a/x.jsonl"));
    updateRollup(db, { projectsDir: dir, nowMs: NOW });
    // Bookkeeping is pruned (bounded growth)…
    expect(seenCount()).toBe(0);
    // …but the aggregated history stays — the dashboard still shows it.
    expect(grandTotal(db)).toBe(150);
  });

  test("--rebuild recomputes from scratch without doubling", () => {
    writeLines("session-a/x.jsonl", [
      line({ ts: "2026-06-17T10:00:00Z", req: "r1", msg: "m1", inp: 100 }),
    ]);
    updateRollup(db, { projectsDir: dir, nowMs: NOW });
    const res = updateRollup(db, {
      projectsDir: dir,
      nowMs: NOW,
      rebuild: true,
    });
    expect(res.rebuilt).toBe(true);
    expect(grandTotal(db)).toBe(100);
  });
});
