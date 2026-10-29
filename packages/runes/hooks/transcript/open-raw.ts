/// <reference types="bun" />
// Opens a reply's raw markdown: `bun open-raw.ts <requestId>` with the text on stdin.
import { quicklook } from "./quicklook";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runtimeInfo } from "../platform-cli";
import { scratchRoot } from "../platform";

const [requestId = "reply"] = process.argv.slice(2);
const info = runtimeInfo();
const dir = join(scratchRoot(info), "raw");
await mkdir(dir, { recursive: true });
const out = join(dir, `${requestId.replace(/[^\w-]/g, "_")}.md`);
await Bun.write(out, await Bun.stdin.text());
await quicklook(out, info);
