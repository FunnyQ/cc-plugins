/// <reference types="bun" />
// Shared by the bun scripts a press runs: never imported by the mod, which has no Bun.

export const quicklook = async (path: string) => {
  // qlmanage stays up until its panel closes, so it is left running detached; no pipes, or the mod's run would wait on it
  const look = Bun.spawn(["qlmanage", "-p", path], {
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
};
