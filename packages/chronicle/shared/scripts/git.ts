import { $ } from "bun";

/** Runs git and returns stdout. Throws on a non-zero exit. */
export async function gitText(args: string[]): Promise<string> {
  return await $`git ${args}`.text();
}

/** Same, but a failing git (missing ref, no remote, not a repo) yields null. */
export async function tryGitText(args: string[]): Promise<string | null> {
  try {
    return await gitText(args);
  } catch {
    return null;
  }
}
