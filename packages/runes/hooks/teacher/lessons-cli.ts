import { ENGLISH, IMPROVE, type Verdict } from "./attempt";
import {
  type Cut,
  dbPath,
  insert,
  label,
  open,
  parseRow,
  stats,
  unlabeled,
} from "./lessons-db";

const [command] = process.argv.slice(2);

if (command !== "record" && command !== "label" && command !== "stats") {
  console.error("usage: lessons-cli.ts record|label|stats");
  process.exit(2);
}

const home = process.env.HOME;
if (!home) {
  console.error("lessons-cli.ts: HOME is not set");
  process.exit(1);
}

const visible = (s: string) =>
  s.replace(
    /[\x00-\x1f\x7f]/g,
    (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );

const score = (n: number | null) => (n === null ? "-" : n.toFixed(2));

const VERDICT_KEYS: Record<string, Verdict> = {
  g: "good",
  m: "bad-model",
  p: "bad-prompt",
  t: "bad-gate",
};

async function runLabel(dbFile: string) {
  const db = open(dbFile);
  const rows = unlabeled(db);
  if (rows.length === 0) {
    console.log("no unlabeled rows");
    process.exit(0);
  }
  const lines = console[Symbol.asyncIterator]();
  const ask = async (q: string) => {
    process.stdout.write(q);
    const r = await lines.next();
    if (r.done) process.exit(0);
    return String(r.value).trim();
  };
  for (const row of rows) {
    console.log(
      `#${row.id} ${row.at} ${visible(row.project)} ${row.outcome} english=${score(row.english)} improve=${score(row.improve)}`,
    );
    console.log(`prompt: ${visible(row.prompt)}`);
    if (row.better !== null) console.log(`better: ${visible(row.better)}`);
    if (row.quip !== null) console.log(`quip: ${visible(row.quip)}`);

    let needs: 0 | 1 | null = null;
    let skip = false;
    for (;;) {
      const a = await ask("needs? [y/n/s=skip/q=quit] ");
      if (a === "q") process.exit(0);
      if (a === "y") needs = 1;
      else if (a === "n") needs = 0;
      else if (a === "s") skip = true;
      else continue;
      break;
    }
    let verdict: Verdict | null = null;
    let note: string | null = null;
    if (!skip) {
      if (row.better)
        for (;;) {
          const v =
            VERDICT_KEYS[
              await ask(
                "verdict? [g=good m=bad-model p=bad-prompt t=bad-gate] ",
              )
            ];
          if (v) {
            verdict = v;
            break;
          }
        }
      note = (await ask("note (Enter to skip) ")) || null;
    }
    if (!label(db, row.id, { needs, verdict, note }, new Date().toISOString()))
      console.log(`row ${row.id} already labeled, skipped`);
  }
  process.exit(0);
}

const cutLine = (c: Cut) =>
  [
    c.english.toFixed(2),
    c.improve.toFixed(2),
    c.tp,
    c.fp,
    c.fn,
    c.tn,
    c.accuracy.toFixed(3),
    c.precision.toFixed(3),
    c.recall.toFixed(3),
  ].join("\t");

const CUT_HEADER =
  "english\timprove\ttp\tfp\tfn\ttn\taccuracy\tprecision\trecall";

function runStats(dbFile: string) {
  const db = open(dbFile);
  const s = stats(db, { english: ENGLISH, improve: IMPROVE });
  db.close();
  const out = [
    `sample\t${s.sample}`,
    "variants",
    "model\teffort\tsystem\tenglish_min\timprove_min\trows\tshown\tlabeled\tgood/judged",
  ];
  for (const v of s.variants)
    out.push(
      [
        v.model,
        v.effort,
        v.systemHash,
        v.englishMin.toFixed(2),
        v.improveMin.toFixed(2),
        v.rows,
        v.shown,
        v.labeled,
        `${v.good}/${v.judged}`,
      ].join("\t"),
    );
  out.push("sweep", CUT_HEADER, ...s.sweep.map(cutLine));
  if (s.current) out.push("current", CUT_HEADER, cutLine(s.current));
  else out.push("current\tnone");
  console.log(out.join("\n"));
}

try {
  if (command === "label") await runLabel(dbPath(home));
  else if (command === "stats") runStats(dbPath(home));
  else {
    const row = parseRow(await Bun.stdin.text());
    const db = open(dbPath(home));
    try {
      insert(db, row);
    } finally {
      db.close();
    }
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
