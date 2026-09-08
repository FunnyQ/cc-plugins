import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addHourlyRow,
  allHourlyRows,
  allLedgerModelRows,
  allLedgerRows,
  getMeta,
  openRollupDb,
  SCHEMA_VERSION,
} from "./rollup-db";
import { updateRollup } from "./rollup-update";

// A minimal assistant transcript line. `ts` drives the hour bucket; `req`/`msg`
// drive billing dedup; `inp` is the input-token count.
function line(opts: {
  ts: string;
  req: string;
  msg: string;
  model?: string;
  cwd?: string;
  sid?: string;
  inp: number;
}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: opts.ts,
    requestId: opts.req,
    cwd: opts.cwd ?? "/proj/a",
    ...(opts.sid ? { sessionId: opts.sid } : {}),
    message: {
      id: opts.msg,
      model: opts.model ?? "claude-opus-4-7",
      usage: { input_tokens: opts.inp, output_tokens: 0 },
    },
  });
}

// A user turn — the only thing that moves the ledger's `interactions`.
function user(opts: { ts: string; sid: string; meta?: boolean }): string {
  return JSON.stringify({
    type: "user",
    timestamp: opts.ts,
    sessionId: opts.sid,
    cwd: "/proj/a",
    isMeta: opts.meta ?? false,
    message: { content: "hi" },
  });
}

// An assistant turn carrying tool_use blocks; `msg` is the tool-dedup key.
function tools(opts: {
  ts: string;
  sid: string;
  msg: string;
  n: number;
}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: opts.ts,
    sessionId: opts.sid,
    cwd: "/proj/a",
    message: {
      id: opts.msg,
      content: Array.from({ length: opts.n }, () => ({ type: "tool_use" })),
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

function ledgerFor(db: ReturnType<typeof openRollupDb>, sessionKey: string) {
  const rows = allLedgerRows(db).filter((r) => r.session_key === sessionKey);
  return {
    interactions: rows.reduce((s, r) => s + r.interactions, 0),
    toolCalls: rows.reduce((s, r) => s + r.tool_calls, 0),
  };
}

function sessionTokens(
  db: ReturnType<typeof openRollupDb>,
  sessionKey: string,
): number {
  return allLedgerModelRows(db)
    .filter((r) => r.session_key === sessionKey)
    .reduce(
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

describe("session ledger", () => {
  test("accumulates interactions, tool calls and tokens across appends", () => {
    writeLines("session-a/x.jsonl", [
      user({ ts: "2026-06-17T10:00:00Z", sid: "s1" }),
      tools({ ts: "2026-06-17T10:00:01Z", sid: "s1", msg: "t1", n: 2 }),
      line({
        ts: "2026-06-17T10:00:02Z",
        req: "r1",
        msg: "m1",
        sid: "s1",
        inp: 100,
      }),
    ]);
    updateRollup(db, { projectsDir: dir, nowMs: NOW });
    expect(ledgerFor(db, "s1")).toEqual({ interactions: 1, toolCalls: 2 });
    expect(sessionTokens(db, "s1")).toBe(100);

    appendFileSync(
      join(dir, "session-a/x.jsonl"),
      user({ ts: "2026-06-17T10:05:00Z", sid: "s1" }) +
        "\n" +
        line({
          ts: "2026-06-17T10:05:01Z",
          req: "r2",
          msg: "m2",
          sid: "s1",
          inp: 50,
        }) +
        "\n",
    );
    updateRollup(db, { projectsDir: dir, nowMs: NOW });
    expect(ledgerFor(db, "s1")).toEqual({ interactions: 2, toolCalls: 2 });
    expect(sessionTokens(db, "s1")).toBe(150);
  });

  test("isMeta user lines do not count as interactions", () => {
    writeLines("session-a/x.jsonl", [
      user({ ts: "2026-06-17T10:00:00Z", sid: "s1" }),
      user({ ts: "2026-06-17T10:00:01Z", sid: "s1", meta: true }),
    ]);
    updateRollup(db, { projectsDir: dir, nowMs: NOW });
    expect(ledgerFor(db, "s1").interactions).toBe(1);
  });

  test("a rebuild does not double interactions, tool calls or tokens", () => {
    // The regression this guards: usage_hourly survives a replay because
    // seen_requests blocks it, but the ledger has no such gate — without the
    // per-file clear, every rebuild would inflate these three counters.
    writeLines("session-a/x.jsonl", [
      user({ ts: "2026-06-17T10:00:00Z", sid: "s1" }),
      tools({ ts: "2026-06-17T10:00:01Z", sid: "s1", msg: "t1", n: 3 }),
      line({
        ts: "2026-06-17T10:00:02Z",
        req: "r1",
        msg: "m1",
        sid: "s1",
        inp: 100,
      }),
    ]);
    updateRollup(db, { projectsDir: dir, nowMs: NOW });
    const before = { ...ledgerFor(db, "s1"), tokens: sessionTokens(db, "s1") };
    for (let i = 0; i < 3; i++) {
      updateRollup(db, { projectsDir: dir, nowMs: NOW, rebuild: true });
    }
    expect({ ...ledgerFor(db, "s1"), tokens: sessionTokens(db, "s1") }).toEqual(
      before,
    );
    expect(grandTotal(db)).toBe(100);
  });

  test("one session spanning several files aggregates into one row set", () => {
    // A subagent transcript carries its parent's sessionId — the reason the
    // ledger is keyed per file and summed per session on the way out.
    writeLines("session-a/parent.jsonl", [
      user({ ts: "2026-06-17T10:00:00Z", sid: "s1" }),
      line({
        ts: "2026-06-17T10:00:01Z",
        req: "r1",
        msg: "m1",
        sid: "s1",
        inp: 100,
      }),
    ]);
    writeLines("session-a/child.jsonl", [
      user({ ts: "2026-06-17T10:01:00Z", sid: "s1" }),
      line({
        ts: "2026-06-17T10:01:01Z",
        req: "r2",
        msg: "m2",
        sid: "s1",
        inp: 40,
      }),
    ]);
    updateRollup(db, { projectsDir: dir, nowMs: NOW });
    expect(
      allLedgerRows(db).filter((r) => r.session_key === "s1"),
    ).toHaveLength(2);
    expect(ledgerFor(db, "s1").interactions).toBe(2);
    expect(sessionTokens(db, "s1")).toBe(140);
  });

  test("a tool message repeated across two ingest batches counts once", () => {
    writeLines("session-a/x.jsonl", [
      tools({ ts: "2026-06-17T10:00:00Z", sid: "s1", msg: "t1", n: 2 }),
    ]);
    updateRollup(db, { projectsDir: dir, nowMs: NOW });
    expect(ledgerFor(db, "s1").toolCalls).toBe(2);
    // Claude persists another snapshot of the same message after the cursor.
    appendFileSync(
      join(dir, "session-a/x.jsonl"),
      tools({ ts: "2026-06-17T10:00:01Z", sid: "s1", msg: "t1", n: 2 }) + "\n",
    );
    updateRollup(db, { projectsDir: dir, nowMs: NOW });
    expect(ledgerFor(db, "s1").toolCalls).toBe(2);
  });

  test("the same tool message in two sessions counts once per session", () => {
    // A resumed or forked session replays the original's message ids. Deduping
    // tool keys globally instead of per session silently halves the copy's
    // count — measured on a real session as 23 tool calls instead of 65.
    writeLines("session-a/first.jsonl", [
      tools({ ts: "2026-06-17T10:00:00Z", sid: "s1", msg: "t1", n: 2 }),
    ]);
    writeLines("session-a/second.jsonl", [
      tools({ ts: "2026-06-17T11:00:00Z", sid: "s2", msg: "t1", n: 2 }),
    ]);
    updateRollup(db, { projectsDir: dir, nowMs: NOW });
    expect(ledgerFor(db, "s1").toolCalls).toBe(2);
    expect(ledgerFor(db, "s2").toolCalls).toBe(2);
  });

  test("one tool message shared by a parent and its subagent counts once", () => {
    const shared = (ts: string) => tools({ ts, sid: "s1", msg: "t1", n: 3 });
    writeLines("session-a/parent.jsonl", [shared("2026-06-17T10:00:00Z")]);
    writeLines("session-a/child.jsonl", [shared("2026-06-17T10:00:00Z")]);
    updateRollup(db, { projectsDir: dir, nowMs: NOW });
    expect(ledgerFor(db, "s1").toolCalls).toBe(3);
  });

  test("a new transcript does not re-count a request a sibling already recorded", () => {
    // A brand-new file starts at byte 0, exactly like a rebuild — but its
    // requests may already sit in another file's ledger rows, so it must stay
    // gated on seen_requests. Conflating the two doubled the session's tokens.
    writeLines("session-a/parent.jsonl", [
      line({
        ts: "2026-06-17T10:00:00Z",
        req: "r1",
        msg: "m1",
        sid: "s1",
        inp: 100,
      }),
    ]);
    updateRollup(db, { projectsDir: dir, nowMs: NOW });
    expect(sessionTokens(db, "s1")).toBe(100);

    // The subagent transcript repeats the parent's line and adds one of its own.
    writeLines("session-a/child.jsonl", [
      line({
        ts: "2026-06-17T10:00:00Z",
        req: "r1",
        msg: "m1",
        sid: "s1",
        inp: 100,
      }),
      line({
        ts: "2026-06-17T10:01:00Z",
        req: "r2",
        msg: "m2",
        sid: "s1",
        inp: 40,
      }),
    ]);
    updateRollup(db, { projectsDir: dir, nowMs: NOW });
    expect(sessionTokens(db, "s1")).toBe(140);
    expect(grandTotal(db)).toBe(140);
    // …and a rebuild reaches the same number from scratch.
    updateRollup(db, { projectsDir: dir, nowMs: NOW, rebuild: true });
    expect(sessionTokens(db, "s1")).toBe(140);
  });

  test("deleting one file of a shared session keeps what the other still holds", () => {
    // Cross-file dedup credits a shared request to whichever file was read
    // first. If that file is deleted, the survivor's cursor has not moved, so
    // the counts have to be re-derived or they vanish.
    const shared = line({
      ts: "2026-06-17T10:00:00Z",
      req: "r1",
      msg: "m1",
      sid: "s1",
      inp: 100,
    });
    writeLines("session-a/parent.jsonl", [
      shared,
      tools({ ts: "2026-06-17T10:00:10Z", sid: "s1", msg: "t1", n: 1 }),
    ]);
    writeLines("session-a/child.jsonl", [
      shared,
      tools({ ts: "2026-06-17T10:00:10Z", sid: "s1", msg: "t1", n: 1 }),
    ]);
    updateRollup(db, { projectsDir: dir, nowMs: NOW });
    expect(sessionTokens(db, "s1")).toBe(100);
    expect(ledgerFor(db, "s1").toolCalls).toBe(1);

    // Delete whichever file the dedup credited, not a fixed name — the walk
    // order decides that, and deleting the other one proves nothing.
    const owner = allLedgerModelRows(db).find((r) => r.input_tokens > 0)!.path;
    rmSync(owner);
    updateRollup(db, { projectsDir: dir, nowMs: NOW });
    // The other file still holds both lines — the session must not read as empty.
    expect(sessionTokens(db, "s1")).toBe(100);
    expect(ledgerFor(db, "s1").toolCalls).toBe(1);
    expect(grandTotal(db)).toBe(100);
  });

  test("a transcript truncated to empty drops its ledger row", () => {
    writeLines("session-a/x.jsonl", [
      line({
        ts: "2026-06-17T10:00:00Z",
        req: "r1",
        msg: "m1",
        sid: "s1",
        inp: 100,
      }),
      tools({ ts: "2026-06-17T10:00:10Z", sid: "s1", msg: "t1", n: 1 }),
    ]);
    updateRollup(db, { projectsDir: dir, nowMs: NOW });
    expect(sessionTokens(db, "s1")).toBe(100);

    // Truncation rewinds every cursor, but this file has no bytes left to read,
    // so the apply path never runs — the stale rows must still go.
    writeFileSync(join(dir, "session-a/x.jsonl"), "");
    updateRollup(db, { projectsDir: dir, nowMs: NOW });
    expect(allLedgerRows(db)).toEqual([]);
    expect(sessionTokens(db, "s1")).toBe(0);
    // usage_hourly is the opposite, as always.
    expect(grandTotal(db)).toBe(100);
  });

  test("deleting a transcript drops its ledger row but keeps its tokens", () => {
    writeLines("session-a/x.jsonl", [
      user({ ts: "2026-06-17T10:00:00Z", sid: "s1" }),
      line({
        ts: "2026-06-17T10:00:01Z",
        req: "r1",
        msg: "m1",
        sid: "s1",
        inp: 100,
      }),
    ]);
    updateRollup(db, { projectsDir: dir, nowMs: NOW });
    rmSync(join(dir, "session-a/x.jsonl"));
    updateRollup(db, { projectsDir: dir, nowMs: NOW });
    // The ledger tracks transcripts on disk, exactly like the walk it replaced…
    expect(allLedgerRows(db)).toEqual([]);
    expect(sessionTokens(db, "s1")).toBe(0);
    // …while usage_hourly is the opposite by design.
    expect(grandTotal(db)).toBe(100);
  });

  test("the earliest cwd wins when a session moves between directories", () => {
    const at = (ts: string, cwd: string) =>
      JSON.stringify({
        type: "user",
        timestamp: ts,
        sessionId: "s1",
        cwd,
        message: { content: "hi" },
      });
    // Written out of order: the later timestamp lands in the file first.
    writeLines("session-a/x.jsonl", [
      at("2026-06-17T11:00:00Z", "/proj/a/sub"),
      at("2026-06-17T10:00:00Z", "/proj/a"),
    ]);
    updateRollup(db, { projectsDir: dir, nowMs: NOW });
    const row = allLedgerRows(db).find((r) => r.session_key === "s1")!;
    expect(row.project).toBe("/proj/a");
    expect(row.last_ts_ms).toBe(Date.parse("2026-06-17T11:00:00Z"));
  });
});

describe("historical usage protection", () => {
  for (const trigger of ["rebuild", "truncation"] as const) {
    test(`${trigger} preserves deleted projects and shared buckets across repeated runs`, () => {
      const old = {
        hour_ms: 0,
        project: "/deleted",
        model: "old",
        input_tokens: 100,
        output_tokens: 20,
        cache_read: 30,
        cache_creation: 40,
        reasoning: 50,
        message_count: 6,
      };
      addHourlyRow(db, old);
      const retained = line({
        ts: "2026-06-17T10:00:00Z",
        req: "r1",
        msg: "m1",
        inp: 10,
      });
      writeLines("session-a/x.jsonl", [retained, retained]);
      updateRollup(db, { projectsDir: dir });
      const live = allHourlyRows(db).find((r) => r.project === "/proj/a")!;
      addHourlyRow(db, { ...live, input_tokens: 70 });
      const before = allHourlyRows(db);
      if (trigger === "truncation") writeLines("session-a/x.jsonl", [retained]);
      updateRollup(db, { projectsDir: dir, rebuild: trigger === "rebuild" });
      expect(allHourlyRows(db)).toEqual(before);
      updateRollup(db, { projectsDir: dir, rebuild: true });
      expect(allHourlyRows(db)).toEqual(before);
      appendFileSync(
        join(dir, "session-a/x.jsonl"),
        line({ ts: "2026-06-17T10:00:00Z", req: "new", msg: "new", inp: 3 }) +
          "\n",
      );
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
    const entry = (inp: number) =>
      line({
        ts: "2026-06-17T10:00:00Z",
        req: "",
        msg: "",
        inp,
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
    addHourlyRow(legacy, {
      hour_ms: 0,
      project: "/deleted",
      model: "old",
      input_tokens: 100,
      output_tokens: 20,
      cache_read: 30,
      cache_creation: 40,
      reasoning: 50,
      message_count: 6,
    });
    const entry = line({
      ts: "2026-06-17T10:00:00Z",
      req: "r1",
      msg: "m1",
      inp: 10,
    });
    writeLines("session-a/x.jsonl", [entry]);
    updateRollup(legacy, { projectsDir: dir });
    const before = allHourlyRows(legacy);
    const paths = legacy
      .query("SELECT path FROM ingested_files ORDER BY path")
      .all();
    legacy.exec(
      "DROP INDEX idx_seen_requests_path; ALTER TABLE seen_requests DROP COLUMN path;",
    );
    legacy.exec("UPDATE meta SET value = '1' WHERE key = 'schema_version'");
    legacy.close();
    const migrated = openRollupDb(path);
    try {
      expect(allHourlyRows(migrated)).toEqual(before);
      // Cursors are deliberately rewound, not preserved: v3 needs one full pass
      // to backfill the ledger. The files themselves stay tracked, and
      // seen_requests still gates billing, so the replay adds no tokens.
      expect(
        migrated.query("SELECT path FROM ingested_files ORDER BY path").all(),
      ).toEqual(paths);
      expect(
        migrated
          .query(
            "SELECT COUNT(*) AS n FROM ingested_files WHERE bytes_parsed != 0",
          )
          .get(),
      ).toEqual({ n: 0 });
      expect(getMeta(migrated, "schema_version")).toBe(String(SCHEMA_VERSION));
      updateRollup(migrated, { projectsDir: dir });
      expect(allHourlyRows(migrated)).toEqual(before);
      updateRollup(migrated, { projectsDir: dir, rebuild: true });
      expect(allHourlyRows(migrated)).toEqual(before);
    } finally {
      migrated.close();
    }
  });

  test("v2 migration keeps tokens and dedup keys, and backfills the ledger", () => {
    const path = join(dir, "v2.db");
    const v2 = openRollupDb(path);
    addHourlyRow(v2, {
      hour_ms: 0,
      project: "/deleted",
      model: "old",
      input_tokens: 100,
      output_tokens: 20,
      cache_read: 30,
      cache_creation: 40,
      reasoning: 50,
      message_count: 6,
    });
    writeLines("session-a/x.jsonl", [
      user({ ts: "2026-06-17T10:00:00Z", sid: "s1" }),
      line({
        ts: "2026-06-17T10:00:01Z",
        req: "r1",
        msg: "m1",
        sid: "s1",
        inp: 10,
      }),
    ]);
    updateRollup(v2, { projectsDir: dir });
    const before = allHourlyRows(v2);
    const seen = v2.query("SELECT * FROM seen_requests").all();
    // Rewind to a genuine v2 database: no ledger tables, no key window.
    v2.exec(
      "DROP TABLE session_ledger; DROP TABLE session_model_usage; DROP TABLE seen_tool_calls;",
    );
    v2.exec("UPDATE meta SET value = '2' WHERE key = 'schema_version'");
    v2.close();

    const migrated = openRollupDb(path);
    try {
      // Token history and billing keys are untouched by the upgrade itself...
      expect(allHourlyRows(migrated)).toEqual(before);
      expect(migrated.query("SELECT * FROM seen_requests").all()).toEqual(seen);
      expect(getMeta(migrated, "schema_version")).toBe(String(SCHEMA_VERSION));
      // ...the ledger starts empty and the forced rewind refills it.
      expect(allLedgerRows(migrated)).toEqual([]);
      updateRollup(migrated, { projectsDir: dir });
      expect(allHourlyRows(migrated)).toEqual(before);
      const ledger = allLedgerRows(migrated);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]!.session_key).toBe("s1");
      expect(ledger[0]!.interactions).toBe(1);
      expect(sessionTokens(migrated, "s1")).toBe(10);
    } finally {
      migrated.close();
    }
  });

  test("a schema bump leaves a restorable backup beside the db", () => {
    const path = join(dir, "backup.db");
    const v2 = openRollupDb(path);
    addHourlyRow(v2, {
      hour_ms: 0,
      project: "/p",
      model: "m",
      input_tokens: 7,
      output_tokens: 0,
      cache_read: 0,
      cache_creation: 0,
      reasoning: 0,
      message_count: 1,
    });
    v2.exec("UPDATE meta SET value = '2' WHERE key = 'schema_version'");
    v2.close();

    openRollupDb(path).close();
    const backup = new Database(`${path}.v2.bak`);
    try {
      // The snapshot predates the upgrade: old version, old rows, still readable.
      expect(getMeta(backup, "schema_version")).toBe("2");
      expect(allHourlyRows(backup)).toHaveLength(1);
    } finally {
      backup.close();
    }
    // A second open at the current version must not overwrite it.
    const stamp = statSync(`${path}.v2.bak`).mtimeMs;
    openRollupDb(path).close();
    expect(statSync(`${path}.v2.bak`).mtimeMs).toBe(stamp);
  });

  test("unknown schema versions fail without rewriting metadata or usage", () => {
    const path = join(dir, "future.db");
    const future = openRollupDb(path);
    future.exec("UPDATE meta SET value = '999' WHERE key = 'schema_version'");
    future.close();
    expect(() => openRollupDb(path)).toThrow(
      "Unsupported rollup schema version",
    );
    const raw = new Database(path);
    try {
      expect(getMeta(raw, "schema_version")).toBe("999");
    } finally {
      raw.close();
    }
  });
});
