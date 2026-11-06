export type RawEnv = Partial<
  Record<"HC_TERMINAL_ID" | "HERDR_ENV" | "EDITOR", string>
>;
export type RawPlan =
  { via: "peek" | "popup"; editor: string[] } | { via: "system" };

const pickEditor = (
  env: RawEnv,
  has: (cmd: string) => boolean,
  chosen: string,
) => {
  if (chosen !== "auto") {
    const argv = chosen.trim().split(/\s+/);
    return has(argv[0]!) ? argv : undefined;
  }
  if (has("nvim")) return ["nvim", "-R"];
  if (has("vim")) return ["vim", "-R"];
  const editor = env.EDITOR?.trim();
  return editor ? editor.split(/\s+/) : undefined;
};

export const planRaw = (
  env: RawEnv,
  has: (cmd: string) => boolean,
  platform: string,
  chosen = "auto",
): RawPlan => {
  const via = env.HC_TERMINAL_ID
    ? "peek"
    : env.HERDR_ENV === "1" && platform !== "win32"
      ? "popup"
      : undefined;
  const editor = via && pickEditor(env, has, chosen);
  return via && editor ? { via, editor } : { via: "system" };
};

export const shellLine = (argv: string[]) =>
  argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
