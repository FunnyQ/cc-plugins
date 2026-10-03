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

// breaks styled runs by cell width, each piece keeping its run's style; glow leaves a code block's long lines unwrapped
export const wrapRuns = <R extends Styled>(runs: R[], width: number): R[][] => {
  const lines: R[][] = [[]];
  let used = 0;
  for (const run of runs)
    for (const ch of run.text) {
      const w = cellWidth(ch);
      if (used + w > width && used > 0) {
        lines.push([]);
        used = 0;
      }
      const line = lines[lines.length - 1]!;
      const last = line[line.length - 1];
      if (last && sameStyle(last, run)) last.text += ch;
      else line.push({ ...run, text: ch });
      used += w;
    }
  return lines;
};

const sameStyle = (a: Styled, b: Styled) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  keys.delete("text");
  return [...keys].every((k) => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k]);
};
