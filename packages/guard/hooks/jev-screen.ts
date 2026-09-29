/**
 * Asks TypeSafe's Jev whether each added comment line says why or what, and
 * drops the blocks it is sure are all why, so the model is not stopped to
 * re-answer a question with an obvious answer. Measured over 708 reported lines
 * (160 labelled by opus): at 0.8 it spares 84 of 222 blocks and passes 4 of 36
 * what-lines, at p50 220 ms per block. Every failure keeps every block, so the
 * hook degrades to asking the model, never to staying silent.
 *
 * A port of chronicle's `askJev`, not an import: plugins never import each other.
 */

import type { CommentBlock } from "./comment-guard.ts";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
// Measured max 344 ms; the whole hook has 10 s and a network stall must not eat it.
const TIMEOUT_MS = 2_000;
const PASS_WHY = 0.8;

const CRITERIA = {
  why: "Carries a reason, constraint, invariant, history, measured fact, rejected alternative, or consequence the code alone cannot show; a line continuing such a sentence counts",
  what: "Restates what the code does, narrates steps, labels a section, describes the edit itself, or names what a thing is without saying why it matters",
};

type Answer = { probabilities?: Record<string, number> };

async function allWhy(
  file: string,
  block: CommentBlock,
  opts: { apiKey: string; fetch?: typeof fetch },
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
    const response = await (opts.fetch ?? fetch)(ENDPOINT, {
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
      signal: AbortSignal.timeout(TIMEOUT_MS),
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

export async function screenBlocks(
  file: string,
  blocks: CommentBlock[],
  opts: { apiKey: string | undefined; fetch?: typeof fetch },
): Promise<CommentBlock[]> {
  const { apiKey } = opts;
  if (!apiKey) return blocks;
  const passed = await Promise.all(
    blocks.map((block) => allWhy(file, block, { apiKey, fetch: opts.fetch })),
  );
  return blocks.filter((_, i) => !passed[i]);
}
