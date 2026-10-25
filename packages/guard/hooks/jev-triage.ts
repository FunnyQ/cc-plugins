/**
 * Asks TypeSafe's Jev for the reviewer's own verdict on each added comment
 * line, and settles the whole report without the reviewer subagent only when
 * Jev is sure of every block. A DELETE it gets wrong still meets the main
 * agent's audit, so it needs 0.6; a KEEP it gets wrong is never seen again, so
 * it needs 0.8; a MUST KILL always goes to the reviewer, which names the test.
 * One unsure block sends the whole report to the reviewer, since it runs anyway.
 * Measured over 35 blocks the reviewer had judged (130 lines, five repos): 9
 * blocks settle, 9 of 26 reports skip the reviewer, and 1 settled line differs
 * from the reviewer's verdict, a KEEP on a pointer to a README. Judged per line
 * instead of per block, the same thresholds let 16 differing KEEPs through.
 */

import type { CommentBlock } from "./comment-core.ts";
import type { Post } from "./jev-screen.ts";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
const CONTEXT_LINES = 40;
const SETTLE = { delete: 0.6, keep: 0.8 } as const;

// Worded from agents/comments-reaper.md, so Jev and the reviewer judge against one definition.
const CRITERIA = {
  keep: "Says something no test, type, lint or assertion in this codebase can carry: a constraint from outside this codebase (a dependency, platform, vendor, protocol, harness or OS behaviour), a measured fact, history or a rejected alternative a reader would otherwise retry, a licence header, a usage or exit-code contract printed for a CLI's callers, or a link to an issue or RFC explaining a constraint",
  delete:
    "Restates what the code already says, narrates steps, labels a section, describes the edit itself, or is commented-out code",
  must_kill:
    "States a rule about this codebase's own code (an ordering, an invariant, a precondition, a case a function must handle) or excuses a workaround, special case or surprise in it, so a test, type, lint rule, runtime assertion or rename could carry it instead",
};

type Probs = Partial<Record<keyof typeof CRITERIA, number>>;
export type Changed = { file: string; text: string; blocks: CommentBlock[] };

async function settle(
  file: string,
  code: string[],
  block: CommentBlock,
  opts: { apiKey: string; fetch: Post },
): Promise<string[] | null> {
  if (block.tags.some(Boolean)) return null;
  const numbers = block.lines.map((_, k) => block.start + k);
  const asked = numbers.filter((_, k) => block.added[k]);
  const questions = Object.fromEntries(
    asked.map((n) => [
      `l${n}`,
      {
        type: "choice",
        instructions: `A reviewer who wants fewer comments judges the comment on line ${n} of \`code\` (its text: \`${block.lines[n - block.start]!.trim()}\`). Read the code around it and the rest of its block.`,
        criteria: CRITERIA,
      },
    ]),
  );
  const first = Math.max(1, block.start - CONTEXT_LINES);
  const last = Math.min(
    code.length,
    block.start + block.height - 1 + CONTEXT_LINES,
  );
  try {
    const response = await opts.fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        state: {
          file,
          block: block.lines.map((l, k) => `${numbers[k]}\t${l}`).join("\n"),
          code: code
            .slice(first - 1, last)
            .map((l, k) => `${first + k}\t${l}`)
            .join("\n"),
        },
        questions,
      }),
    });
    if (!response.ok) return null;
    const { answers } = (await response.json()) as {
      answers?: Record<string, { probabilities?: Probs }>;
    };
    const verdicts: string[] = [];
    for (const n of asked) {
      const p = answers?.[`l${n}`]?.probabilities ?? {};
      if ((p.keep ?? 0) >= SETTLE.keep) continue;
      if ((p.delete ?? 0) < SETTLE.delete) return null;
      verdicts.push(
        `${file}:${n} DELETE — Jev p=${p.delete!.toFixed(2)}: restates the code`,
      );
    }
    return verdicts;
  } catch {
    return null;
  }
}

export async function triage(
  changed: Changed[],
  opts: { apiKey: string | undefined; fetch: Post },
): Promise<string[] | null> {
  const { apiKey } = opts;
  if (!apiKey) return null;
  const settled = await Promise.all(
    changed.flatMap(({ file, text, blocks }) => {
      const code = text.split("\n");
      return blocks.map((block) =>
        settle(file, code, block, { apiKey, fetch: opts.fetch }),
      );
    }),
  );
  return settled.some((s) => s === null) ? null : settled.flatMap((s) => s!);
}
