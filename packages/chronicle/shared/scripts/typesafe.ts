/**
 * One call to TypeSafe's Jev model. Every outcome — no key, an HTTP error, a
 * timeout, a partial answer — comes back as a value, never a throw, because Jev
 * only ever sharpens a step the flow can finish without it.
 */

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
const TIMEOUT_MS = 5_000;

export type JevQuestion = {
  type: "choice" | "noul" | "score";
  instructions: string;
  criteria?: Record<string, string> | string[];
};

export type JevAnswer = {
  type: string;
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
  noul?: number;
};

/** `ms` is the round trip, so the user sees what the call cost this run. */
export type JevResult =
  | { answers: Record<string, JevAnswer>; ms: number }
  | { skipped: string; ms?: number };

export async function askJev(
  request: { state: unknown; questions: Record<string, JevQuestion> },
  opts: { apiKey: string | undefined; fetch?: typeof fetch },
): Promise<JevResult> {
  if (!opts.apiKey) return { skipped: "TYPESAFE_API_KEY not set" };

  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  try {
    const response = await (opts.fetch ?? fetch)(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: MODEL, ...request }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return { skipped: `HTTP ${response.status}`, ms: ms() };

    const { answers } = (await response.json()) as {
      answers?: Record<string, JevAnswer>;
    };
    if (!answers || Object.keys(request.questions).some((k) => !answers[k])) {
      return { skipped: "response is missing answers", ms: ms() };
    }
    return { answers, ms: ms() };
  } catch (err) {
    return {
      skipped: err instanceof Error ? err.message : String(err),
      ms: ms(),
    };
  }
}

export function renderJevLine(label: string, result: JevResult): string {
  if ("answers" in result) return `[TypeSafe ${label}: ${result.ms} ms]`;
  const after = result.ms === undefined ? "" : ` after ${result.ms} ms`;
  return `[TypeSafe ${label} skipped${after}: ${result.skipped}]`;
}
