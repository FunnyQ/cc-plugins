/// <reference types="bun" />
// Prints the minimap's rows as JSON: `bun index.ts <sessionId>`.
// A separate process because a transcript outgrows the mod's 4 MiB `$.fs.read` cap.
import { rowsOf } from "./rows";

const [sessionId] = process.argv.slice(2);
const projects = `${process.env.HOME}/.claude/projects`;
const [path] = [...new Bun.Glob(`*/${sessionId}.jsonl`).scanSync(projects)];
if (!path) process.exit(1);
console.log(
  JSON.stringify(rowsOf(await Bun.file(`${projects}/${path}`).text())),
);
