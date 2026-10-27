export const ENGLISH = 0.7;
export const IMPROVE = 0.6;

export const OUTCOMES = [
  "jev-failed",
  "gated",
  "no-reply",
  "empty",
  "same",
  "not-rewrite",
  "shown",
] as const;
export type Outcome = (typeof OUTCOMES)[number];

export type Attempt = {
  prompt: string;
  english: number | null;
  improve: number | null;
  englishMin: number;
  improveMin: number;
  outcome: Outcome;
  better: string | null;
  quip: string | null;
  system: string;
};

export type AttemptRow = Attempt & {
  at: string;
  project: string;
  session: string;
  model: string;
  effort: string;
};

export const VERDICTS = [
  "good",
  "bad-model",
  "bad-prompt",
  "bad-gate",
] as const;
export type Verdict = (typeof VERDICTS)[number];
