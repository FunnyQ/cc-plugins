export const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

export type Page = {
  title: string;
  main: string;
  project: string;
  generatedAt: string;
};

type Io = {
  read: (path: string) => Promise<string>;
  write: (path: string, text: string) => Promise<void>;
  exists: (path: string) => Promise<boolean>;
  mkdir: (dir: string) => Promise<void>;
};

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ESCAPES[c]);

// regex pass, not a parser: a fork writing malformed markup on purpose can slip past; take a parser if an explainer is seen to load or navigate
export const cleanMain = (main: string): string =>
  main
    .replace(
      /<(script|style|iframe|object|embed|form|foreignObject)\b[\s\S]*?<\/\1\s*>/gi,
      "",
    )
    .replace(
      /<\/?(script|style|iframe|object|embed|form|foreignObject|meta|base|link|frame|image)\b[^>]*>/gi,
      "",
    )
    .replace(/\s(on[\w-]+|style)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(
      /\s(href|src|xlink:href)\s*=\s*("(?!#)[^"]*"|'(?!#)[^']*'|(?![#"'])[^\s>]+)/gi,
      "",
    );

export const assemble = (template: string, page: Page): string =>
  template.replace(
    /\{\{(csp|title|project|generatedAt|main)\}\}/g,
    (_, key: string) => {
      if (key === "csp") return CSP;
      if (key === "main") return cleanMain(page.main);
      return escapeHtml(page[key as "title" | "project" | "generatedAt"]);
    },
  );

const trimDashes = (s: string): string => s.replace(/^-+|-+$/g, "");

export const slugOf = (title: string): string => {
  const dashed = trimDashes(
    title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-"),
  );
  return trimDashes([...dashed].slice(0, 40).join("")) || "explainer";
};

const pad = (n: number): string => String(n).padStart(2, "0");

export const explainerPath = (
  home: string,
  project: string,
  at: Date,
  title: string,
): string => {
  const day = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}${pad(at.getMinutes())}`;
  return `${home}/.local/share/q-lab/runes/explain/${slugOf(project)}/${day}-${time}-${slugOf(title)}.html`;
};

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const mastheadTime = (at: Date): string =>
  `${at.getDate()} ${MONTHS[at.getMonth()]} ${at.getFullYear()} · ${pad(at.getHours())}:${pad(at.getMinutes())}`;

export const writeExplainer = async (
  io: Io,
  root: string,
  home: string,
  page: Omit<Page, "generatedAt">,
  at: Date,
): Promise<string> => {
  const template = await io.read(`${root}/hooks/explain/template.html`);
  const first = explainerPath(home, page.project, at, page.title);
  await io.mkdir(first.slice(0, first.lastIndexOf("/")));
  let path = first;
  for (let n = 2; await io.exists(path); n++)
    path = first.replace(/\.html$/, `-${n}.html`);
  await io.write(
    path,
    assemble(template, { ...page, generatedAt: mastheadTime(at) }),
  );
  return path;
};
