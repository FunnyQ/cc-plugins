/// <reference types="bun" />
// Prints `{ path, rows }` as JSON, the transcript's path and the minimap's rows: `bun index.ts <sessionId>`.
// A separate process because a transcript outgrows the mod's 4 MiB `$.fs.read` cap.
import { rowsOfStream } from "./rows";
import { join } from "node:path";
import { runtimeInfo } from "../platform-cli";

const [sessionId] = process.argv.slice(2);
const projects = join(runtimeInfo().home, ".claude", "projects");
const [path] = [...new Bun.Glob(`*/${sessionId}.jsonl`).scanSync(projects)];
if (!path) process.exit(1);
const file = join(projects, path);
console.log(
  JSON.stringify({
    path: file,
    // TextDecoderStream holds back a character cut by a chunk edge
    rows: await rowsOfStream(
      Bun.file(file).stream().pipeThrough(new TextDecoderStream()),
    ),
  }),
);
