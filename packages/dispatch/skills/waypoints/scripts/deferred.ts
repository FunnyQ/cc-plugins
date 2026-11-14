export type DeferredItem = {
  criterion: string;
  from: string;
  date: string;
  why: string;
};

const ITEM_REGEX =
  /^- \[[ x]\] (.+)\n {2}- from: (.*?) · deferred: (\S+)\n {2}- why: (.*)$/gm;

export function parseDeferred(md: string): DeferredItem[] {
  return [...md.replace(/\r\n/g, "\n").matchAll(ITEM_REGEX)].map((m) => ({
    criterion: m[1],
    from: m[2],
    date: m[3],
    why: m[4],
  }));
}

export function appendDeferred(
  md: string | null,
  legSlug: string,
  items: DeferredItem[],
): string {
  const head = md?.trim()
    ? md.replace(/\s+$/, "")
    : `# Deferred criteria — ${legSlug}`;
  const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
  const body = items.map(
    (item) =>
      `- [ ] ${oneLine(item.criterion)}\n  - from: ${oneLine(item.from)} · deferred: ${item.date}\n  - why: ${oneLine(item.why)}`,
  );
  return `${[head, ...body].join("\n\n")}\n`;
}

export function legOf(planPath: string): { proj: string; slug: string } | null {
  const m = /(?:^|\/)docs\/([^/]+)\/legs\/(\d{2}(?:[a-z]\d*)?-[^/]+)\/PLAN\.md$/.exec(
    planPath.replace(/\\/g, "/"),
  );
  return m ? { proj: m[1], slug: m[2] } : null;
}
