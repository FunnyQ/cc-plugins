import { cells } from "./text";

export type Kind =
  | "prompt"
  | "cmd"
  | "flag"
  | "str"
  | "var"
  | "op"
  | "comment"
  | "text"
  | "space";
export type Token = { text: string; kind: Kind };

// longest first, so `&&` is never read as two `&`
const OPS = ["2>&1", "&&", "||", ">>", "$(", "|", ";", "(", ")", ">", "<", "&"];
// after these the next word is a file or an argument, not a command
const TAKES_ARG = new Set([")", ">", "<", ">>", "2>&1"]);

// a highlighter's reading, not a parser's: heredocs and nested quoting fall back to plain words
export const tokenize = (line: string): Token[] => {
  const out: Token[] = [];
  let expectCmd = true;
  let i = 0;
  while (i < line.length) {
    const rest = line.slice(i);
    const take = (text: string, kind: Kind) => {
      out.push({ text, kind });
      i += text.length;
    };
    const space = rest.match(/^\s+/)?.[0];
    if (space) {
      take(space, "space");
      continue;
    }
    if (rest[0] === "#") {
      take(rest, "comment");
      break;
    }
    const op = OPS.find((o) => rest.startsWith(o));
    if (op) {
      take(op, "op");
      expectCmd = !TAKES_ARG.has(op);
      continue;
    }
    const quoted =
      rest.match(/^"(?:\\.|[^"\\])*"?/)?.[0] ?? rest.match(/^'[^']*'?/)?.[0];
    if (quoted) {
      take(quoted, "str");
      expectCmd = false;
      continue;
    }
    const variable = rest.match(/^\$(?:\{[^}]*\}|\w+|[?@#$!*])/)?.[0];
    if (variable) {
      take(variable, "var");
      expectCmd = false;
      continue;
    }
    const word = rest.match(/^[^\s'"|&;()<>$]+/)?.[0] ?? rest.charAt(0);
    if (expectCmd && /^\w+=/.test(word)) take(word, "var");
    else if (expectCmd) {
      take(word, "cmd");
      expectCmd = false;
    } else take(word, /^-/.test(word) ? "flag" : "text");
  }
  return out;
};

const CONTINUE: Token = { text: "  ", kind: "prompt" };

// breaks by cell width, carrying each character's kind into the line it lands on
const wrapTokens = (tokens: Token[], width: number): Token[][] => {
  const lines: Token[][] = [[]];
  let used = 0;
  for (const t of tokens)
    for (const ch of t.text) {
      const w = cells(ch);
      if (used + w > width && used > CONTINUE.text.length) {
        lines.push([{ ...CONTINUE }]);
        used = CONTINUE.text.length;
      }
      const line = lines[lines.length - 1]!;
      const last = line[line.length - 1];
      if (last?.kind === t.kind) last.text += ch;
      else line.push({ text: ch, kind: t.kind });
      used += w;
    }
  return lines;
};

// a line too wide for the row breaks before each top-level &&, || and |, then hard-wraps what is still too wide
export const layout = (command: string, width: number): Token[][] =>
  command.split("\n").flatMap((src, n) => {
    const lead = n === 0 ? "$ " : "  ";
    const fits = cells(lead + src) <= width;
    const segments: Token[][] = [[]];
    let depth = 0;
    for (const t of tokenize(src)) {
      if (t.kind === "op" && (t.text === "(" || t.text === "$(")) depth++;
      if (t.kind === "op" && t.text === ")") depth--;
      const current = segments[segments.length - 1]!;
      if (
        !fits &&
        depth === 0 &&
        t.kind === "op" &&
        ["&&", "||", "|"].includes(t.text) &&
        current.length
      )
        segments.push([t]);
      else current.push(t);
    }
    return segments.flatMap((seg, s) => {
      while (seg[0]?.kind === "space") seg.shift();
      while (seg[seg.length - 1]?.kind === "space") seg.pop();
      const head = {
        text: s === 0 ? lead : CONTINUE.text,
        kind: "prompt" as const,
      };
      return wrapTokens([head, ...seg], width);
    });
  });
