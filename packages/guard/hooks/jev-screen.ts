/**
 * Asks TypeSafe's Jev whether each added comment line says why, excuses our
 * own code, or says what, and drops the blocks it is sure are all why, so the
 * model is not stopped to re-answer a question with an obvious answer.
 * Measured over 206 blocks (974 lines from six repos, labelled by opus): at 0.8
 * it withdraws 25, 19 of them all-why, and lets 8 of 473 what-lines and 4 of 21
 * excuse-lines out with them. The two-choice criteria it replaced withdrew 40,
 * only 25 all-why, leaking 25 what and 12 excuse. p50 220 ms per block. Every
 * failure keeps every block, so the hook degrades to asking the model, never to
 * staying silent.
 *
 * A port of chronicle's `askJev`, not an import: plugins never import each other.
 */

import type { CommentBlock } from "./comment-core.ts";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
// Measured max 344 ms; the whole hook has 10 s and a network stall must not eat it.
export const TIMEOUT_MS = 2_000;
const PASS_WHY = 0.8;

// `excuse` is its own choice so a workaround's why draws mass away from `why`; folding it into `what` instead leaked 11 of 21 excuse lines at 0.8, against 4.
const CRITERIA = {
  why: "Carries a reason the code cannot be reshaped to show: an outside constraint (dependency, platform, vendor, protocol, harness), an invariant, a measured fact, history, a rejected alternative, or a consequence; a line continuing such a sentence counts",
  excuse:
    "Justifies a workaround, hack, special case, or surprising shape in this codebase's own code, or calls it temporary; a rename, extraction, type, or redesign of our own code could make it obvious or remove it",
  what: "Restates what the code does, narrates steps, labels a section, describes the edit itself, or names what a thing is without saying why it matters",
};

type Answer = { probabilities?: Record<string, number> };

// The caller hands in its transport, and the transport enforces TIMEOUT_MS: the mod has neither a global `fetch` nor `AbortSignal.timeout`.
export type Post = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

async function allWhy(
  file: string,
  block: CommentBlock,
  opts: { apiKey: string; fetch: Post },
): Promise<boolean> {
  const questions: Record<string, unknown> = {};
  block.added.forEach((added, k) => {
    if (!added) return;
    questions[`l:${k}`] = {
      type: "choice",
      instructions: `Under the rule "comment why, never what", does \`comment.lines[${k}]\` say why or what? Read the rest of the block as context.`,
      criteria: CRITERIA,
    };
  });
  try {
    const response = await opts.fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        state: { comment: { file, lines: block.lines } },
        questions,
      }),
    });
    if (!response.ok) return false;
    const { answers } = (await response.json()) as {
      answers?: Record<string, Answer>;
    };
    return Object.keys(questions).every(
      (id) => (answers?.[id]?.probabilities?.why ?? 0) >= PASS_WHY,
    );
  } catch {
    return false;
  }
}

/** `ms` is the slowest request, since they run in parallel; absent when nothing was sent. */
export type Screen = { kept: CommentBlock[]; withdrawn: number; ms?: number };

export async function screenBlocks(
  file: string,
  blocks: CommentBlock[],
  opts: { apiKey: string | undefined; fetch: Post },
): Promise<Screen> {
  const { apiKey } = opts;
  if (!apiKey) return { kept: blocks, withdrawn: 0 };
  const started = performance.now();
  // A tagged line asks more than why-or-what, so a confident "why" from Jev answers the wrong question.
  const passed = await Promise.all(
    blocks.map((block) =>
      block.tags.some(Boolean)
        ? false
        : allWhy(file, block, { apiKey, fetch: opts.fetch }),
    ),
  );
  const kept = blocks.filter((_, i) => !passed[i]);
  return {
    kept,
    withdrawn: blocks.length - kept.length,
    ms: Math.round(performance.now() - started),
  };
}

// Silent when nothing was withdrawn: a withdrawal is the one outcome nobody would otherwise see.
export function screenNote(label: string, screen: Screen): string | null {
  if (screen.withdrawn === 0) return null;
  const total = screen.kept.length + screen.withdrawn;
  return `${label}: Jev withdrew ${screen.withdrawn} of ${total} comment block(s) as why (${screen.ms} ms)`;
}
