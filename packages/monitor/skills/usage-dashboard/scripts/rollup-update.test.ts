import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addHourlyRow, allHourlyRows, getMeta, openRollupDb, SCHEMA_VERSION } from "./rollup-db";
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

  test("truncation preserves prior usage and ingests new requests", () => {
    writeLines("session-a/x.jsonl", [
      line({ ts: "2026-06-17T10:00:00Z", req: "r1", msg: "m1", inp: 100 }),
      line({ ts: "2026-06-17T10:05:00Z", req: "r2", msg: "m2", inp: 50 }),
    ]);
    updateRollup(db, { projectsDir: dir, nowMs: NOW });
    expect(grandTotal(db)).toBe(150);

    // Rewritten content must not erase already billed requests.
    writeLines("session-a/x.jsonl", [
      line({ ts: "2026-06-17T10:00:00Z", req: "r9", msg: "m9", inp: 7 }),
    ]);
    const res = updateRollup(db, { projectsDir: dir, nowMs: NOW });
    expect(res.rebuilt).toBe(true);
    expect(grandTotal(db)).toBe(157);
    updateRollup(db, { projectsDir: dir, nowMs: NOW });
    expect(grandTotal(db)).toBe(157);
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

  test("--rebuild rescans without doubling", () => {
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

describe("historical usage protection", () => {
  for (const trigger of ["rebuild", "truncation"] as const) {
    test(`${trigger} preserves deleted projects and shared buckets across repeated runs`, () => {
      const old = { hour_ms: 0, project: "/deleted", model: "old",
        input_tokens: 100, output_tokens: 20, cache_read: 30,
        cache_creation: 40, reasoning: 50, message_count: 6 };
      addHourlyRow(db, old);
      const retained = line({ ts: "2026-06-17T10:00:00Z", req: "r1", msg: "m1", inp: 10 });
      writeLines("session-a/x.jsonl", [retained, retained]);
      updateRollup(db, { projectsDir: dir });
      const live = allHourlyRows(db).find(r => r.project === "/proj/a")!;
      addHourlyRow(db, { ...live, input_tokens: 70 });
      const before = allHourlyRows(db);
      if (trigger === "truncation") writeLines("session-a/x.jsonl", [retained]);
      updateRollup(db, { projectsDir: dir, rebuild: trigger === "rebuild" });
      expect(allHourlyRows(db)).toEqual(before);
      updateRollup(db, { projectsDir: dir, rebuild: true });
      expect(allHourlyRows(db)).toEqual(before);
      appendFileSync(join(dir, "session-a/x.jsonl"),
        line({ ts: "2026-06-17T10:00:00Z", req: "new", msg: "new", inp: 3 }) + "\n");
      updateRollup(db, { projectsDir: dir });
      expect(grandTotal(db)).toBe(273);
    });
  }

  test("rebuild with no surviving transcripts keeps every usage field", () => {
    writeLines("session-a/x.jsonl", [
      line({ ts: "2026-06-17T10:00:00Z", req: "r1", msg: "m1", inp: 100 }),
    ]);
    updateRollup(db, { projectsDir: dir });
    rmSync(join(dir, "session-a/x.jsonl"));
    updateRollup(db, { projectsDir: dir });
    const before = allHourlyRows(db);
    updateRollup(db, { projectsDir: dir, rebuild: true });
    expect(allHourlyRows(db)).toEqual(before);
  });

  test("replay advances fallback keys past already seen unkeyed entries", () => {
    const entry = (inp: number) => line({
      ts: "2026-06-17T10:00:00Z", req: "", msg: "", inp,
    });
    writeLines("session-a/x.jsonl", [entry(10), entry(20)]);
    updateRollup(db, { projectsDir: dir });
    writeLines("session-a/x.jsonl", [entry(10), entry(20), entry(3)]);
    updateRollup(db, { projectsDir: dir, rebuild: true });
    expect(grandTotal(db)).toBe(33);
    updateRollup(db, { projectsDir: dir, rebuild: true });
    expect(grandTotal(db)).toBe(33);
  });

  test("v1 migration preserves aggregates, cursors and dedup keys", () => {
    const path = join(dir, "legacy.db");
    const legacy = openRollupDb(path);
    addHourlyRow(legacy, { hour_ms: 0, project: "/deleted", model: "old",
      input_tokens: 100, output_tokens: 20, cache_read: 30,
      cache_creation: 40, reasoning: 50, message_count: 6 });
    const entry = line({ ts: "2026-06-17T10:00:00Z", req: "r1", msg: "m1", inp: 10 });
    writeLines("session-a/x.jsonl", [entry]);
    updateRollup(legacy, { projectsDir: dir });
    const before = allHourlyRows(legacy);
    const cursors = legacy.query("SELECT * FROM ingested_files").all();
    legacy.exec("DROP INDEX idx_seen_requests_path; ALTER TABLE seen_requests DROP COLUMN path;");
    legacy.exec("UPDATE meta SET value = '1' WHERE key = 'schema_version'");
    legacy.close();
    const migrated = openRollupDb(path);
    try {
      expect(allHourlyRows(migrated)).toEqual(before);
      expect(migrated.query("SELECT * FROM ingested_files").all()).toEqual(cursors);
      expect(getMeta(migrated, "schema_version")).toBe(String(SCHEMA_VERSION));
      updateRollup(migrated, { projectsDir: dir, rebuild: true });
      expect(allHourlyRows(migrated)).toEqual(before);
    } finally { migrated.close(); }
  });

  test("unknown schema versions fail without rewriting metadata or usage", () => {
    const path = join(dir, "future.db");
    const future = openRollupDb(path);
    future.exec("UPDATE meta SET value = '999' WHERE key = 'schema_version'");
    future.close();
    expect(() => openRollupDb(path)).toThrow("Unsupported rollup schema version");
    const raw = new Database(path);
    try { expect(getMeta(raw, "schema_version")).toBe("999"); }
    finally { raw.close(); }
  });
});
