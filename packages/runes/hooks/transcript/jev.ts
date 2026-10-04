// Asks TypeSafe's Jev whether Bash output the sniffer cannot place is worth a glow render, so a `gh pr view` or a
// `git show` of a source file is highlighted like a `cat`. Measured over 128 outputs of one session against opus labels:
// 0 of 100 plain outputs rendered, 81% of the render-worthy ones found (the sniffer alone found 22%).
//
// The command is asked about first, with no output: a command that settles it (or looks risky) is decided there, which
// keeps the output of about half the calls on this machine. Only an unsure command sends the head of its output.
// A draw never waits on this: it takes the verdict if there is one, plain text otherwise, and redraws when one lands.

import { config } from "../config";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
// the call never blocks a draw, so this is generous next to the measured max of 1.5 s
const TIMEOUT_MS = 5_000;
const COMMAND_CHARS = 300;
const OUTPUT_CHARS = 800;
// each rule is on the probability of plain (or of risk): a literal compares exactly where 1 - 0.95 does not
const RISK_BLOCK = 0.6;
const SURE_RENDER = 0.05;
const SURE_PLAIN = 0.95;
const OUTPUT_RENDER = 0.3;
const CACHE_SIZE = 200;

export type Probs = Record<string, number>;
type Answers = { kind: Probs; language: Probs; risk: number };
export type Next = { done: true; lang: string | undefined } | { done: false };

// the fence language for the likeliest kind that is not plain; code in a language the list lacks stays plain
const fenceOf = (kind: Probs, language: Probs): string | undefined => {
  const kinds = ["markdown", "json", "diff", "code"] as const;
  const best = kinds.reduce((a, b) => ((kind[b] ?? 0) > (kind[a] ?? 0) ? b : a));
  if (best !== "code") return best;
  const [top] = Object.entries(language).sort((a, b) => b[1] - a[1]);
  return top && top[0] !== "other" ? top[0] : undefined;
};

export const afterCommand = ({ kind, language, risk }: Answers): Next => {
  const plain = kind.plain ?? 0;
  if (risk >= RISK_BLOCK || plain >= SURE_PLAIN) return { done: true, lang: undefined };
  if (plain <= SURE_RENDER) return { done: true, lang: fenceOf(kind, language) };
  return { done: false };
};

export const afterOutput = ({ kind, language }: Pick<Answers, "kind" | "language">): string | undefined =>
  (kind.plain ?? 0) <= OUTPUT_RENDER ? fenceOf(kind, language) : undefined;

// what a command or an output sample may carry that must not leave the machine; patterns, so not a guarantee
const SECRETS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[private key]"],
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, "[key]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[token]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[key]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, "Bearer [token]"],
  [/(:\/\/[^\s:/@]+:)[^\s@/]+(@)/g, "$1[password]$2"],
  [/\b((?:password|passwd|secret|token|api[_-]?key|access[_-]?key)\s*[:=]\s*)\S{6,}/gi, "$1[secret]"],
  [/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]"],
];
export const scrub = (text: string): string => SECRETS.reduce((t, [re, to]) => t.replace(re, to), text);

// commands whose output is the secret itself: never asked about, never sent, whatever Jev would say
const DENIED: RegExp[] = [
  /^(env|printenv)\b(?!\s*\|\s*wc\b)/,
  /^history\b/,
  /(^|[\s/])\.env(\.(?!example\b|sample\b|template\b)[\w.-]+)?(\s|$|["'])/,
  /\.ssh\/|\bid_(rsa|ed25519|ecdsa)\b/,
  /\.aws\/credentials|\.netrc|\.npmrc|\.pypirc|\.docker\/config\.json|\.kube\/config/,
  /\bgh auth (token|status\s+-t)/,
  /\/proc\/[^\s]*\/environ/,
  /\bsecurity find-(generic|internet)-password/,
  /\bgpg\b.*--export-secret/,
  /\bop (item|read)\b/,
  /\bkubectl\b.*\bget secrets?\b/,
  /\bmaster\.key\b|\bcredentials\.yml\b/,
];
export const isDenied = (command: string): boolean =>
  command.split(/&&|\|\||;|\n/).some((part) => DENIED.some((re) => re.test(part.trim())));

export type Post = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; text: string }>;

const KIND = {
  markdown: "A document written in Markdown: headings, bullet lists, bold, links or fenced blocks, prose a Markdown renderer would improve",
  json: "The whole output is JSON",
  diff: "A unified diff or patch",
  code: "Mostly one source file or config snippet to syntax-highlight, not code appearing inside grep hits or logs",
  plain:
    "Tool output rather than a document: log lines, test runner output, file listings, grep hits with file:line prefixes, git status or log, tables a tool printed, progress, errors, shell session text, key-value dumps",
};
const LANGS = ["typescript", "tsx", "javascript", "ruby", "python", "rust", "go", "bash", "yaml", "toml", "css", "html", "sql", "xml", "other"];
const LANGUAGE = Object.fromEntries(
  LANGS.map((l) => [l, l === "other" ? "Not code, or none of the listed languages" : `${l} source`]),
);
const RISK = {
  true: "Likely or possibly prints a secret or personal data: environment dumps, credential or key files, auth tokens, secret stores, database rows of users, remote URLs, config listings, shell history",
  false: "Prints build output, test results, source code, file listings, version numbers, or repository status that holds no secrets or personal data",
};

const byCommand = (command: string) => ({
  state: { command },
  questions: {
    kind: {
      type: "choice",
      instructions: "How should the output of this `command` be rendered in a terminal card? You see only the command, not its output: judge what it most likely prints.",
      criteria: KIND,
    },
    language: {
      type: "choice",
      instructions: "If the output of `command` is most likely source code or config, which language is it? Pick other when it is not code.",
      criteria: LANGUAGE,
    },
    risk: {
      type: "noul",
      instructions:
        "Could the output printed by running this shell `command` contain secrets (credentials, tokens, API keys, private keys, passwords, connection strings with credentials) or personal data (email addresses, personal names, addresses)? You see only the command, not its output.",
      criteria: RISK,
    },
  },
});

const byOutput = (command: string, output: string) => ({
  state: { command, output },
  questions: {
    kind: {
      type: "choice",
      instructions: "How should this command's `output` be rendered in a terminal card? Judge the content first, the `command` second.",
      criteria: KIND,
    },
    language: {
      type: "choice",
      instructions: "If `output` is source code or config, which language is it? Pick other when it is not code.",
      criteria: LANGUAGE,
    },
  },
});

type Transport = { post: Post; apiKey: string; redraw: () => void };
let transport: Transport | undefined;
// a verdict is a fence language, or undefined for plain; a key absent from both maps is unasked
const verdicts = new Map<string, string | undefined>();
const asked = new Set<string>();

const remember = (key: string, lang: string | undefined) => {
  verdicts.delete(key);
  verdicts.set(key, lang);
  if (verdicts.size > CACHE_SIZE) verdicts.delete(verdicts.keys().next().value!);
};

const ask = async (t: Transport, body: object) => {
  const r = await t.post(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${t.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, ...body }),
  });
  if (!r.ok) throw new Error("jev refused");
  const { answers } = JSON.parse(r.text) as { answers: Record<string, { probabilities?: Probs; noul?: number }> };
  return {
    kind: answers.kind?.probabilities ?? {},
    language: answers.language?.probabilities ?? {},
    risk: answers.risk?.noul ?? 1,
  };
};

const decide = async (t: Transport, command: string, head: string) => {
  const cmd = scrub(command).slice(0, COMMAND_CHARS);
  const first = afterCommand(await ask(t, byCommand(cmd)));
  return first.done ? first.lang : afterOutput(await ask(t, byOutput(cmd, scrub(head))));
};

export const jev = {
  // the fence language for output the sniffer could not place, or undefined while unasked, pending, plain, or switched off
  view(command: string, stdout: string): string | undefined {
    if (!transport || !config.bash.jev || isDenied(command)) return undefined;
    const head = stdout.slice(0, OUTPUT_CHARS);
    const key = `${command}\0${head}`;
    if (verdicts.has(key)) return verdicts.get(key);
    if (asked.has(key)) return undefined;
    asked.add(key);
    const t = transport;
    // any failure leaves the output plain, as it was before Jev
    void decide(t, command, head)
      .catch(() => undefined)
      .then((lang) => {
        asked.delete(key);
        remember(key, lang);
        if (lang) t.redraw();
      });
    return undefined;
  },
  // run from session.start, which holds `$`; no key leaves every draw as it was
  work(next: { apiKey: string | undefined; post: Post; redraw: () => void }) {
    transport = next.apiKey ? { post: next.post, apiKey: next.apiKey, redraw: next.redraw } : undefined;
  },
};
