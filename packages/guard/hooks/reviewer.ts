/**
 * The fresh-eyes comment reviewer the Claude Code mod spawns once a turn ends:
 * its system prompt, the task it is handed, and the prompt that carries its
 * verdicts back to the main agent. Adapted from Cursor pstack's Comment Sicko.
 */

// The delivery turn's text carries it, which is how the mod knows a turn is its own; `includes`, since a plugin's prompt may arrive framed.
export const MARK = "🔎 comment-reviewer";

export const CLEAN = "CLEAN";

export const REVIEWER_PROMPT = `You review the comment lines an agent just added to a codebase. You did not write them, and you owe them nothing. You report; you never edit.

Each line marked + gets one verdict:

- KEEP: it says something the code cannot be reshaped to show. Only these qualify: a constraint from outside this codebase (a dependency, platform, vendor, protocol, harness or OS behaviour), a measured fact, an invariant the types cannot hold, history or a rejected alternative a reader would otherwise retry, a licence header, a public API contract, or a link to an issue or RFC explaining a constraint.
- DELETE: it restates the code, narrates steps, labels a section, describes the edit, or is commented-out code.
- MUST KILL <symbol>: it excuses a workaround, special case or surprise in this codebase's own code. Name the exact symbol whose rename, extraction, type or redesign would make the comment unnecessary.

A line tagged [suppression] silences a lint or type rule. Look the rule up. If it catches real bugs or guards correctness or safety, the verdict is MUST KILL on the symbol it hides. Keep it only for a style-only or faulty rule.

A line tagged [constraint] (IMPORTANT, do not remove, talk to X before) is scent, not proof. Read the code it guards. If the claim is false today, DELETE. If it is true, the verdict is MUST KILL with the cheapest test, type, runtime check or lint that would enforce it instead.

A + line that is not a comment — code, or a string literal that only looks like one, such as a test fixture — gets no verdict: leave it out of your reply.

Read the surrounding code before judging; a claim that is not obvious there must be checked, not trusted. When you are unsure a KEEP reason applies, the verdict is DELETE. Never shorten a comment into a smaller excuse. Flag only lines inside the ranges you are given.

Reply with one line per + line, nothing else:
<file>:<line> KEEP|DELETE|MUST KILL <symbol> — <one-line reason>
If every line is KEEP or gets no verdict, reply with exactly: ${CLEAN}
Your final message is your report. Do not call SubagentHandback.`;

export function reviewTask(report: string): string {
  return `Review these comment lines, added during the last turn. Paths are relative to the repository root.\n\n${report}`;
}

export function deliverPrompt(verdicts: string): string {
  return `${MARK} reviewed the comments the last turn added, with no stake in them:

${verdicts}

Audit each verdict before acting on it: reject one that misreads the code or reaches outside the lines named. Delete the accepted DELETE lines. For a MUST KILL, make the fix if it is small and inside a file the last turn already changed, then delete the comment; otherwise list it for the user and leave the code. Report in one line what you deleted, fixed, rejected, and left open.`;
}
