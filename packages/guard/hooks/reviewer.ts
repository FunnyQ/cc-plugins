/**
 * The fresh-eyes comment reviewer the Claude Code mod spawns once a turn ends:
 * the task it is handed, and the prompt that carries its verdicts back to the
 * main agent. Its system prompt lives in `agents/comments-reaper.md`.
 * Adapted from Cursor pstack's Comment Sicko.
 */

// The delivery turn's text carries it, which is how the mod knows a turn is its own; `includes`, since a plugin's prompt may arrive framed.
export const MARK = "🔎 comment-reviewer";

export const CLEAN = "CLEAN";

export function promptBody(agentFile: string): string {
  return agentFile.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
}

export function reviewTask(report: string): string {
  return `Review these comment lines, added during the last turn. Paths are relative to the repository root.\n\n${report}`;
}

export function deliverPrompt(verdicts: string): string {
  return `${MARK} reviewed the comments the last turn added, with no stake in them:

${verdicts}

Audit each verdict before acting on it: reject one that misreads the code or reaches outside the lines named. Delete the accepted DELETE lines. For a MUST KILL, make the fix if it is small and inside a file the last turn already changed, then delete the comment; otherwise list it for the user and leave the code. Report in one line what you deleted, fixed, rejected, and left open.`;
}
