#!/usr/bin/env bun
// Regenerates every golden file from the TS engine. The golden files are the
// definition of "TS behaviour" the Rust port must match, so recording from Rust
// would make the suite compare Rust against itself.
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  GOLDEN_DIR,
  ROLLUP_TABLES,
  SCENARIOS,
  SOURCES,
  goldenPath,
  recordRollupTables,
  recordScenario,
  recordSource,
  recordStats,
  type Scenario,
} from "./golden";
import { isRust } from "./launcher";

if (isRust()) {
  console.error("record-golden: run against TS only; unset COCKPIT_BIN");
  process.exit(1);
}

async function write(rel: string, value: unknown): Promise<void> {
  const path = goldenPath(rel);
  mkdirSync(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`);
}

await write("stats.json", await recordStats());
for (const name of SOURCES) {
  await write(`sources/${name}.json`, await recordSource(name));
}
const tables = await recordRollupTables();
for (const table of ROLLUP_TABLES) {
  await write(`rollup/${table}.json`, tables[table]);
}
for (const [name, slug] of Object.entries(SCENARIOS)) {
  await write(`rollup/${slug}.json`, await recordScenario(name as Scenario));
}

const files = (readdirSync(GOLDEN_DIR, { recursive: true }) as string[])
  .map((rel) => join(GOLDEN_DIR, rel))
  .filter((path) => statSync(path).isFile() && !path.endsWith("SHA256SUMS"))
  .map((path) => relative(GOLDEN_DIR, path))
  .sort();
const sums = Bun.spawnSync(["shasum", "-a", "256", ...files], {
  cwd: GOLDEN_DIR,
});
if (sums.exitCode !== 0) {
  console.error(sums.stderr.toString());
  process.exit(1);
}
await Bun.write(goldenPath("SHA256SUMS"), sums.stdout);
console.log(`record-golden: wrote ${files.length} files under ${GOLDEN_DIR}`);
