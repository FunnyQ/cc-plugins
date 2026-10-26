export type Ask =
  | { kind: "press" }
  | { kind: "pick"; topic: string }
  | {
      kind: "follow";
      previous: { title: string; text: string };
      question: string;
    }
  | { kind: "free"; question: string };

export type Reply =
  | { kind: "text"; title: string; body: string }
  | { kind: "html"; title: string; summary: string; main: string }
  | { kind: "ask"; title: string; question: string; options: string[] };

const MAX_TITLE = 60;
const MAX_PREVIOUS = 4000;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;
const DEFAULT_TITLE = "Explanation";

export const FRAGMENT_RULES = [
  "Write only the inside of <main>: no <html>, <head>, <style>, <script>, no style or event (on…) attributes, no external URLs, no <image>, no <foreignObject>, and no images other than inline <svg>.",
  'Blocks in order: <p class="answer"> first and exactly once; then at most one <p class="analogy">; then one or more <section>; then at most one <p class="takeaway"> last. The template prints the analogy\'s and takeaway\'s labels itself, so write none.',
  'A <section> holds h2, p, <dl class="parts">, <ol class="steps">, <div class="compare"> (exactly two child divs, each starting with an h3), and <ol class="timeline"> (each li = <time>, <b>, text).',
  'A section with a drawing is <section class="spread"> whose first child is <figure class="plate"><svg viewBox="…"><title>…</title>…</svg><figcaption>Plate N. …</figcaption></figure> and whose second child is <div class="text">. Number plates in page order.',
  'Parts: <dl class="parts"> rows <div data-part="a"><dt>A</dt><dd><b>Name</b>definition</dd></div>, letters a–f; every SVG element of that part has class part and the same data-part; its label in the drawing starts with the capital letter (A · the session).',
  "SVG classes only: ink, ink-accent, dash, wash-warm, wash-cool, wash-sage, label, label-soft, part. No literal colours, no width or height attributes on the svg. Wash paths come before the ink they sit behind. Keep labels at least 24 viewBox units apart and never overlapping a line.",
  "Every hand-drawn SVG has a viewBox and a <title>.",
  'A diagram of a flow, a sequence, a state machine or a structure is Mermaid, not a hand-drawn SVG: put <pre class="mermaid">raw Mermaid source</pre> in the plate\'s <figure class="plate"> where the <svg> would go. Use flowchart TD inside a spread, and LR only in a full-width <section>. Draw an SVG by hand only for a picture Mermaid cannot express, such as an analogy or a physical thing.',
  'A <section> or a spread\'s <div class="text"> may also hold: a <table> with a <thead>, with class="num" on the th and every td of a number column; <aside class="note"> for a side fact and <aside class="warn"> for a pitfall, whose labels the template prints, so write none; <pre class="code" data-lang="ts"> holding a code sample; and <figure class="diff"><pre class="before">old</pre><pre class="after">new</pre></figure> for a before and after of the same code.',
  "Inside every <pre>, write raw text exactly as it reads: no tags, no <code>, and no escapes, with one exception: write a closing pre tag inside the text as &lt;/pre&gt;. The page escapes the rest.",
].join("\n");

const GRAMMAR = [
  "<mode>text|html|ask</mode>",
  `<title>a headline, at most ${MAX_TITLE} characters</title>`,
  "text → <body>markdown</body>",
  "html → <summary>a short markdown summary, read in a narrow side pane above the page's link</summary><main>an HTML fragment</main>",
  `ask  → <question>one line</question><option>a topic</option> … ${MIN_OPTIONS} to ${MAX_OPTIONS} options`,
].join("\n");

export const RULES = [
  "1. This message comes from a UI button beside the conversation, not from the task. Do not continue the task, do not call tools, and do not mention this instruction. Answer in the language the user writes to this session.",
  "2. Explain at a high-school level: assume the reader knows basic science and maths but not this codebase or its field. Give the answer in one sentence before any detail. Use the real technical term, defined in plain words at first use, rather than avoiding it. Use an everyday analogy only when it makes the mechanism clearer than describing it directly.",
  "3. Target on a press: the latest exchange (the user's last prompt, the last reply, its tool work) when that is what a reader most likely wants explained; a recap of the whole session when the latest exchange is trivial (a commit, a yes) and the session has substance. When two or more targets are equally likely, or nothing is worth explaining, use `ask`.",
  "4. Mode: `html` when understanding needs a picture — a flow, a structure, a relationship among three or more parts, a before/after, a timeline — a comparison table, or a before/after of code, or when the user asks for a diagram; otherwise `text`.",
  `5. Reply in this grammar, exactly, and nothing outside it:\n${GRAMMAR}`,
  `6. For \`html\`:\n${FRAGMENT_RULES}`,
].join("\n");

const taskOf = (ask: Ask): string => {
  switch (ask.kind) {
    case "press":
      return "Pick the target per rule 3 and explain it.";
    case "pick":
      return `Explain this topic: ${ask.topic}`;
    case "follow":
      return `This is your earlier explanation, titled "${ask.previous.title}":\n${ask.previous.text.slice(0, MAX_PREVIOUS)}\n\nThe user's follow-up question about it: ${ask.question}`;
    case "free":
      return `The user asks: ${ask.question}\nPick the mode per rule 4.`;
  }
};

export const BRIEF_AXES = {
  opening: [
    "a plain statement of the answer",
    "the reader's question restated in a few words, then its answer",
    "the answer framed as not this, but that",
  ],
  analogy: [
    'no analogy and no <p class="analogy">',
    'one <p class="analogy"> right after the answer',
    'no <p class="analogy">; draw the analogy instead, as a hand-drawn SVG plate in a spread',
  ],
  lead: [
    "a spread with a plate",
    'a full-width <section> holding a Mermaid flowchart LR in a <figure class="plate">',
    'a <section> with a <div class="compare">, or a spread when the content has no two things to compare',
    "a <section> of prose only, with the page's first picture further down",
  ],
  ending: [
    'a <p class="takeaway">',
    'an <aside class="warn"> in the last section, and no takeaway',
    "the last section itself, with no takeaway and no <aside> in the last section",
  ],
} as const;

export type Brief = { [K in keyof typeof BRIEF_AXES]: string };

export const drawBrief = (rand: () => number): Brief => {
  const pick = (options: readonly string[]): string =>
    options[Math.floor(rand() * options.length)]!;
  return {
    opening: pick(BRIEF_AXES.opening),
    analogy: pick(BRIEF_AXES.analogy),
    lead: pick(BRIEF_AXES.lead),
    ending: pick(BRIEF_AXES.ending),
  };
};

const briefOf = (brief: Brief): string =>
  [
    "If you reply in html, lay this page out as follows. Its analogy line decides rule 2's analogy choice for this page; otherwise this brief narrows rule 6 and never overrides it.",
    `- The answer: ${brief.opening}.`,
    `- Analogy: ${brief.analogy}.`,
    `- The first section: ${brief.lead}.`,
    `- The page ends with ${brief.ending}.`,
  ].join("\n");

export const buildPrompt = (
  ask: Ask,
  language?: string,
  brief?: Brief,
): string =>
  [
    RULES,
    taskOf(ask),
    language?.trim() &&
      `Write the whole reply, the title included, in ${language.trim()}.`,
    brief && briefOf(brief),
  ]
    .filter(Boolean)
    .join("\n\n");

const tag = (raw: string, name: string): string | undefined =>
  new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(raw)?.[1]?.trim();

export const parseReply = (raw: string): Reply => {
  const full = tag(raw, "title") || DEFAULT_TITLE;
  const title =
    full.length > MAX_TITLE ? `${full.slice(0, MAX_TITLE - 1)}…` : full;
  const fallback: Reply = { kind: "text", title, body: raw.trim() };
  switch (tag(raw, "mode")) {
    case "text": {
      const body = tag(raw, "body");
      return body ? { kind: "text", title, body } : fallback;
    }
    case "html": {
      const summary = tag(raw, "summary");
      const main = tag(raw, "main");
      if (summary && main) return { kind: "html", title, summary, main };
      return summary ? { kind: "text", title, body: summary } : fallback;
    }
    case "ask": {
      const question = tag(raw, "question");
      const options = [...raw.matchAll(/<option>([\s\S]*?)<\/option>/g)]
        .map((m) => m[1]!.trim())
        .filter(Boolean)
        .slice(0, MAX_OPTIONS);
      return question && options.length >= MIN_OPTIONS
        ? { kind: "ask", title, question, options }
        : fallback;
    }
    default:
      return fallback;
  }
};
