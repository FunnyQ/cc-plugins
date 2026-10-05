/// <reference types="bun" />
// Opens a reply's raw markdown in Quick Look: `bun open-raw.ts <requestId>` with the text on stdin.
import { quicklook } from "./quicklook";

const [requestId = "reply"] = process.argv.slice(2);
const out = `/tmp/q-lab/runes/raw/${requestId.replace(/[^\w-]/g, "_")}.md`;
await Bun.write(out, await Bun.stdin.text());
await quicklook(out);
