import { $ } from "bun";

export async function gitText(args: string[]): Promise<string> {
  return await $`git ${args}`.text();
}

export async function tryGitText(args: string[]): Promise<string | null> {
  try {
    return await gitText(args);
  } catch {
    return null;
  }
}
