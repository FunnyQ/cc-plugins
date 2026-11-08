/// <reference types="bun" />
// Prints `{ path, from, bytes, rows }` as JSON: the rows of the transcript's lines from byte `from`, and where the next read starts: `bun index.ts <sessionId> [offset]`.
// A separate process because a transcript outgrows the mod's 4 MiB `$.fs.read` cap.
import { rowsOfBytes } from "./rows";
import { join } from "node:path";
import { runtimeInfo } from "../platform-cli";

const [sessionId, offset] = process.argv.slice(2);
const projects = join(runtimeInfo().home, ".claude", "projects");
const [path] = [...new Bun.Glob(`*/${sessionId}.jsonl`).scanSync(projects)];
if (!path) process.exit(1);
const file = Bun.file(join(projects, path));
const asked = Number(offset) || 0;
// a file shorter than the offset was rewritten, so its old rows no longer hold
const from = asked <= file.size ? asked : 0;
const read = await rowsOfBytes(file.slice(from).stream());
console.log(
  JSON.stringify({
    path: join(projects, path),
    from,
    bytes: from + read.bytes,
    rows: read.rows,
  }),
);
