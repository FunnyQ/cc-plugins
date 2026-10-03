// what a bubble's bar, its margin, the transcript gutter and the side borders take from the viewport
const CHROME = 7;

// East Asian wide ranges and emoji take two cells
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1F300}-\u{1FAFF}]/u;

const cellWidth = (ch: string) => (WIDE.test(ch) ? 2 : 1);

// both bubbles share this, so their edges line up
export const innerWidth = (columns = 80) => Math.max(10, columns - CHROME);

export const cells = (text: string): number =>
  [...text].reduce((n, ch) => n + cellWidth(ch), 0);

// breaks by cell width, not at word boundaries: the fallback when glow cannot word-wrap
export const wrap = (text: string, width: number): string[] =>
  text.split("\n").flatMap((line) => {
    const out: string[] = [];
    let cur = "";
    let used = 0;
    for (const ch of line) {
      const w = cellWidth(ch);
      if (used + w > width && cur) {
        out.push(cur);
        cur = "";
        used = 0;
      }
      cur += ch;
      used += w;
    }
    out.push(cur);
    return out;
  });

type Styled = { text: string };

// equal in every field but text; per character in wrapRuns, so it allocates nothing
export const sameStyle = (a: object, b: object) => {
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  for (const k in x) if (k !== "text" && x[k] !== y[k]) return false;
  for (const k in y) if (k !== "text" && x[k] !== y[k]) return false;
  return true;
};

// breaks styled runs by cell width, each piece keeping its run's style; a `lead` opens every wrapped line
export const wrapRuns = <R extends Styled>(runs: R[], width: number, lead?: R): R[][] => {
  const indent = lead ? cells(lead.text) : 0;
  const lines: R[][] = [[]];
  let used = 0;
  for (const run of runs)
    for (const ch of run.text) {
      const w = cellWidth(ch);
      if (used + w > width && used > indent) {
        lines.push(lead ? [{ ...lead }] : []);
        used = indent;
      }
      const line = lines[lines.length - 1]!;
      const last = line[line.length - 1];
      if (last && sameStyle(last, run)) last.text += ch;
      else line.push({ ...run, text: ch });
      used += w;
    }
  return lines;
};
