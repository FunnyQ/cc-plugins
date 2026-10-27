import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { type AttemptRow, type Outcome, OUTCOMES, type Verdict } from "./attempt";

export const dbPath = (home: string) =>
  `${home}/.local/share/q-lab/runes/teacher/lessons.db`;

const SCHEMA = 1;
const WAL_TRIES = 50;
const WAL_RETRY_MS = 100;

const V1 = `CREATE TABLE attempts (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  project TEXT NOT NULL,
  session TEXT NOT NULL,
  prompt TEXT NOT NULL,
  english REAL,
  improve REAL,
  english_min REAL NOT NULL,
  improve_min REAL NOT NULL,
  outcome TEXT NOT NULL,
  better TEXT,
  quip TEXT,
  model TEXT NOT NULL,
  effort TEXT NOT NULL,
  system_hash TEXT NOT NULL,
  needs INTEGER,
  verdict TEXT,
  note TEXT,
  labeled_at TEXT
);`;

const userVersion = (db: Database) =>
  (db.query("PRAGMA user_version").get() as { user_version: number })
    .user_version;

const enableWal = (db: Database) => {
  for (let tries = 1; ; tries++) {
    try {
      db.run("PRAGMA journal_mode = WAL;");
      return;
    } catch (e) {
      if ((e as { code?: string }).code !== "SQLITE_BUSY" || tries >= WAL_TRIES)
        throw e;
      Bun.sleepSync(WAL_RETRY_MS);
    }
  }
};

export function open(path: string): Database {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const db = new Database(path);
  try {
    db.run("PRAGMA busy_timeout = 5000;");
    const v = userVersion(db);
    if (v > SCHEMA)
      throw new Error(`lessons.db schema v${v} is newer than this runes build`);
    enableWal(db);
    if (v === 0) {
      db.run("BEGIN IMMEDIATE");
      try {
        if (userVersion(db) === 0) {
          db.run(V1);
          db.run(`PRAGMA user_version = ${SCHEMA}`);
        }
        db.run("COMMIT");
      } catch (e) {
        if (db.inTransaction) db.run("ROLLBACK");
        throw e;
      }
    }
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
}

export function insert(db: Database, row: AttemptRow): void {
  db.query(
    `INSERT INTO attempts (at, project, session, prompt, english, improve, english_min, improve_min, outcome, better, quip, model, effort, system_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.at,
    row.project,
    row.session,
    row.prompt,
    row.english,
    row.improve,
    row.englishMin,
    row.improveMin,
    row.outcome,
    row.better,
    row.quip,
    row.model,
    row.effort,
    new Bun.CryptoHasher("sha256")
      .update(row.system)
      .digest("hex")
      .slice(0, 12),
  );
}

const STRINGS = [
  "at",
  "project",
  "session",
  "prompt",
  "model",
  "effort",
  "system",
] as const;

export function parseRow(json: string): AttemptRow {
  const r = JSON.parse(json) as Record<string, unknown>;
  if (!(OUTCOMES as readonly unknown[]).includes(r.outcome))
    throw new Error(`unknown outcome: ${String(r.outcome)}`);
  for (const k of STRINGS)
    if (typeof r[k] !== "string") throw new Error(`${k} is not a string`);
  for (const k of ["englishMin", "improveMin"] as const)
    if (typeof r[k] !== "number") throw new Error(`${k} is not a number`);
  for (const k of ["english", "improve"] as const)
    if (r[k] !== null && typeof r[k] !== "number")
      throw new Error(`${k} is neither a number nor null`);
  for (const k of ["better", "quip"] as const)
    if (r[k] !== null && typeof r[k] !== "string")
      throw new Error(`${k} is neither a string nor null`);
  return r as AttemptRow;
}

export type StoredRow = {
  id: number;
  at: string;
  project: string;
  outcome: Outcome;
  english: number | null;
  improve: number | null;
  prompt: string;
  better: string | null;
  quip: string | null;
};

export function unlabeled(db: Database): StoredRow[] {
  return db
    .query(
      "SELECT id, at, project, outcome, english, improve, prompt, better, quip FROM attempts WHERE labeled_at IS NULL ORDER BY id",
    )
    .all() as StoredRow[];
}

export function label(
  db: Database,
  id: number,
  l: { needs: 0 | 1 | null; verdict: Verdict | null; note: string | null },
  at: string,
): boolean {
  return (
    db
      .query(
        "UPDATE attempts SET needs = ?, verdict = ?, note = ?, labeled_at = ? WHERE id = ? AND labeled_at IS NULL",
      )
      .run(l.needs, l.verdict, l.note, at, id).changes === 1
  );
}

export type Variant = {
  model: string;
  effort: string;
  systemHash: string;
  englishMin: number;
  improveMin: number;
  rows: number;
  shown: number;
  labeled: number;
  good: number;
  judged: number;
};

export type Cut = {
  english: number;
  improve: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  accuracy: number;
  precision: number;
  recall: number;
};

export type Stats = {
  variants: Variant[];
  sweep: Cut[];
  current: Cut | null;
  sample: number;
};

type Labeled = { english: number; improve: number; needs: 0 | 1 };

const ratio = (n: number, d: number) => (d === 0 ? 0 : n / d);

const cut = (sample: Labeled[], e: number, i: number): Cut => {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const r of sample) {
    const predicted = r.english >= e && r.improve >= i;
    if (predicted) r.needs === 1 ? tp++ : fp++;
    else r.needs === 1 ? fn++ : tn++;
  }
  return {
    english: e,
    improve: i,
    tp,
    fp,
    fn,
    tn,
    accuracy: ratio(tp + tn, sample.length),
    precision: ratio(tp, tp + fp),
    recall: ratio(tp, tp + fn),
  };
};

const GRID = Array.from({ length: 10 }, (_, k) => (50 + 5 * k) / 100);

export function stats(
  db: Database,
  current: { english: number; improve: number },
): Stats {
  const variants = db
    .query(
      `SELECT model, effort, system_hash AS systemHash, english_min AS englishMin, improve_min AS improveMin,
         count(*) AS rows,
         count(CASE WHEN outcome = 'shown' THEN 1 END) AS shown,
         count(labeled_at) AS labeled,
         count(CASE WHEN verdict = 'good' THEN 1 END) AS good,
         count(verdict) AS judged
       FROM attempts
       GROUP BY model, effort, system_hash, english_min, improve_min
       ORDER BY min(id)`,
    )
    .all() as Variant[];
  const sample = db
    .query(
      "SELECT english, improve, needs FROM attempts WHERE needs IS NOT NULL AND english IS NOT NULL AND improve IS NOT NULL",
    )
    .all() as Labeled[];
  if (sample.length === 0)
    return { variants, sweep: [], current: null, sample: 0 };
  const sweep = GRID.flatMap((e) => GRID.map((i) => cut(sample, e, i)))
    .sort(
      (a, b) =>
        b.accuracy - a.accuracy ||
        b.recall - a.recall ||
        a.english - b.english ||
        a.improve - b.improve,
    )
    .slice(0, 5);
  return {
    variants,
    sweep,
    current: cut(sample, current.english, current.improve),
    sample: sample.length,
  };
}
