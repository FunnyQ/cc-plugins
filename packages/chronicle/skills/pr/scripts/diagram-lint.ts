// Catch the one Mermaid mistake the skald actually makes: node syntax smuggled into an
// EDGE label.
//
//     A -.Cut1["Cut 1: exit on stdin EOF"].-> B      ← not Mermaid at all
//     A -. "Cut 1: exit on stdin EOF" .-> B          ← what it meant
//
// Mermaid rejects the first form and GitHub renders the whole fenced block as a red error
// box in the PR body — strictly worse than shipping no diagram.
//
// The rules below are not guessed. Every one was derived by feeding candidates to
// mermaid's OWN parser (monitor's diagram-lint runs the vendored bundle headless) and
// recording what it actually does. The obvious rule — "an edge label may not contain
// brackets" — is FALSE: `-. N[t] .-> B` parses fine. What breaks it is the quote.
//
//   -. text .->      accept       -->|text|      accept
//   -. a[b] .->      accept       -->|a[b]|      REJECT
//   -. "quoted" .->  accept       -->|"quoted"|  accept
//   -. a"b" .->      REJECT       -->|a"b"|      REJECT
//   -. N["t"] .->    REJECT       -->|N["t"]|    REJECT
//
// So: a `"` that does not wrap the WHOLE label kills every form, and the pipe form
// additionally rejects any bracket.
//
// This is deliberately NOT a Mermaid parser. `monitor` already has the real thing
// (skills/cockpit/scripts/diagram-lint.ts) and it catches this exact bug — but chronicle
// cannot reach it: the plugins install independently, so importing across them breaks for
// anyone who has chronicle without monitor. The alternatives cost more than they are
// worth — `mermaid` from npm pulls 110 packages / 151 MB, and vendoring a second copy of
// the 3.3 MB bundle duplicates monitor's. Sharing monitor's linter is the right long-term
// answer; that is a repo-structure call for the maintainer.

type LinkForm = {
  re: RegExp;
  hint: string;
  // The pipe form is stricter: mermaid's `|…|` lexer rejects brackets outright.
  rejectsBrackets: boolean;
};

// The two halves of every LABELLED link, and the label caught between them. Unlabelled
// links (`-->`, `-.->`, `==>`) match none of these — there is no label to inspect.
const LINK_FORMS: LinkForm[] = [
  {
    re: /[-.=]{2,3}[>ox]\|([^|\n]*)\|/g,
    hint: '-->|label| B   (or -->|"label with spaces"| B)',
    rejectsBrackets: true,
  },
  {
    re: /-\.([^\n]*?)\.-{1,2}[>ox]?/g,
    hint: '-. "label" .-> B',
    rejectsBrackets: false,
  },
  {
    re: /--([^\n>|-][^\n>|]*?)--[->ox]/g,
    hint: '-- "label" --> B',
    rejectsBrackets: false,
  },
  {
    re: /==([^\n>|=][^\n>|]*?)==[>ox]/g,
    hint: '== "label" ==> B',
    rejectsBrackets: false,
  },
];

// A label is legal quoted or bare — but not half-quoted. `"a b"` is fine, `a"b"` is not.
function hasStrayQuote(label: string): boolean {
  const t = label.trim();
  if (!t.includes('"')) return false;
  return !/^"[^"]*"$/.test(t);
}

export function lintEdgeLabels(src: string): string[] {
  const problems: string[] = [];

  for (const { re, hint, rejectsBrackets } of LINK_FORMS) {
    for (const match of src.matchAll(re)) {
      const label = match[1] ?? "";
      const shown = label.trim();

      if (hasStrayQuote(label)) {
        problems.push(
          `edge label \`${shown}\` has a quote that does not wrap the whole label — ` +
            `mermaid cannot parse it. An edge label is plain text: quote ALL of it or ` +
            `none of it. Write \`${hint}\`, or make the explanation a real node and draw ` +
            `a plain edge to it.`,
        );
        continue;
      }

      const bracket = rejectsBrackets
        ? shown.match(/[[\](){}]/)?.[0]
        : undefined;
      if (bracket) {
        problems.push(
          `edge label \`${shown}\` contains \`${bracket}\` — the \`|label|\` form rejects ` +
            `brackets outright. Write \`${hint}\`, or use the \`-- label -->\` form, which ` +
            `tolerates them.`,
        );
      }
    }
  }

  return problems;
}

if (import.meta.main) {
  const problems = lintEdgeLabels(await Bun.stdin.text());
  if (problems.length) {
    for (const p of problems) console.error(`diagram: ${p}`);
    process.exit(1);
  }
}
