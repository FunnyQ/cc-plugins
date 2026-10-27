import { dbPath, insert, open, parseRow } from "./lessons-db";

const [command] = process.argv.slice(2);

if (command !== "record") {
  console.error("usage: lessons-cli.ts record|label|stats");
  process.exit(2);
}

const home = process.env.HOME;
if (!home) {
  console.error("lessons-cli.ts: HOME is not set");
  process.exit(1);
}

try {
  const row = parseRow(await Bun.stdin.text());
  const db = open(dbPath(home));
  try {
    insert(db, row);
  } finally {
    db.close();
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
