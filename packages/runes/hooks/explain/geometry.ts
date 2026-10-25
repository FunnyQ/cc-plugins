type Box = { x: number; y: number; w: number; h: number };

export type Measure = {
  width: number;
  scrollWidth: number;
  svgs: { box: Box; labels: { text: string; box: Box; onLine: boolean }[] }[];
};

// runs in the page over CDP, which the page's CSP does not reach; a label inside a shape's fill is that shape's own
// (a node's number in its circle), so only the strokes of other shapes count as a line under it
export const MEASURE = `(async () => {
  await document.fonts.ready;
  const box = (b) => ({ x: b.left, y: b.top, w: b.width, h: b.height });
  const svgs = [...document.querySelectorAll("main svg[viewBox]")].map((svg) => {
    const ink = [...svg.querySelectorAll(".ink, .ink-accent, .dash")].filter((g) => g.isPointInStroke);
    const p = svg.createSVGPoint();
    return {
      box: box(svg.getBoundingClientRect()),
      labels: [...svg.querySelectorAll("text")].map((t) => {
        const b = t.getBBox();
        p.x = b.x + b.width / 2;
        p.y = b.y + b.height / 2;
        const own = ink.filter((g) => g.isPointInFill(p));
        const xs = [0.1, 0.3, 0.5, 0.7, 0.9].map((f) => b.x + b.width * f);
        const ys = [];
        for (let y = b.y + b.height * 0.2; y <= b.y + b.height * 0.8; y += 1) ys.push(y);
        const onLine = ink.some((g) => !own.includes(g) && xs.some((x) => ys.some((y) => {
          p.x = x;
          p.y = y;
          return g.isPointInStroke(p);
        })));
        return { text: t.textContent, box: box(t.getBoundingClientRect()), onLine };
      }),
    };
  });
  return JSON.stringify({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, svgs });
})()`;

const crosses = (a: Box, b: Box) =>
  a.x + 1 < b.x + b.w - 1 &&
  b.x + 1 < a.x + a.w - 1 &&
  a.y + 1 < b.y + b.h - 1 &&
  b.y + 1 < a.y + a.h - 1;

const within = (a: Box, b: Box) =>
  a.x >= b.x - 1 &&
  a.y >= b.y - 1 &&
  a.x + a.w <= b.x + b.w + 1 &&
  a.y + a.h <= b.y + b.h + 1;

export function faults(byWidth: Record<number, Measure>): string[] {
  const found: string[] = [];
  for (const [w, m] of Object.entries(byWidth)) {
    if (m.scrollWidth > m.width)
      found.push(`${w}: page ${m.scrollWidth}px wide in a ${m.width}px window`);
    m.svgs.forEach((svg, n) => {
      const at = `${w}: figure ${n + 1}`;
      svg.labels.forEach((label, i) => {
        if (!within(label.box, svg.box))
          found.push(`${at} "${label.text}" outside its svg`);
        if (label.onLine) found.push(`${at} "${label.text}" sits on a line`);
        for (const other of svg.labels.slice(i + 1))
          if (crosses(label.box, other.box))
            found.push(`${at} "${label.text}" overlaps "${other.text}"`);
      });
    });
  }
  return found;
}
