/// <reference types="bun" />
// Opens one pasted image of a prompt in Quick Look: `bun open-image.ts <sessionId> <N>` with the prompt text on stdin.
// A separate process because a transcript outgrows the mod's 4 MiB `$.fs.read` cap.
import { findImage } from "./images";

const [sessionId, n] = process.argv.slice(2);
const text = await Bun.stdin.text();
const projects = `${process.env.HOME}/.claude/projects`;
const [path] = [...new Bun.Glob(`*/${sessionId}.jsonl`).scanSync(projects)];
const image =
  path &&
  findImage(await Bun.file(`${projects}/${path}`).text(), text, Number(n));
if (!image) {
  console.error(`no image #${n} in this session's transcript yet`);
  process.exit(1);
}
const ext = image.mediaType.split("/")[1] ?? "png";
const out = `/tmp/q-lab/runes/images/${sessionId}-${Bun.hash(text)}-${n}.${ext}`;
await Bun.write(out, Buffer.from(image.data, "base64"));
// qlmanage stays up until its panel closes, so it is left running detached; no pipes, or the mod's run would wait on it
const look = Bun.spawn(["qlmanage", "-p", out], {
  stdio: ["ignore", "ignore", "ignore"],
});
look.unref();
// the panel opens behind the terminal; raising it needs its process up first, 0.5s measured under Ghostty
await Bun.sleep(500);
Bun.spawnSync([
  "osascript",
  "-e",
  `tell application "System Events" to set frontmost of (first process whose unix id is ${look.pid}) to true`,
]);
