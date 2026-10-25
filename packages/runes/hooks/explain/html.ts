export const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

export type Page = {
  title: string;
  main: string;
  project: string;
  generatedAt: string;
  lang?: string;
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

const cleanOnce = (main: string): string =>
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

// regex passes repeated until nothing changes, so a tag spliced across a removed one (`<me<base>ta …>`) is caught on the next pass; a parser if an explainer is still seen to load or navigate
export const cleanMain = (main: string): string => {
  for (let prev = ""; prev !== main; ) [prev, main] = [main, cleanOnce(main)];
  return main;
};

// settings.language is free text ("zh-TW", "Japanese"); only a BCP 47 shaped tag becomes the page's lang
export const langTag = (language?: string): string => {
  const tag = language?.trim() ?? "";
  return /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(tag) ? tag : "";
};

export const assemble = (template: string, page: Page): string =>
  template.replace(
    /\{\{(csp|title|project|generatedAt|main|lang)\}\}/g,
    (_, key: string) => {
      if (key === "csp") return CSP;
      if (key === "lang") return langTag(page.lang);
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

export const explainRoot = (home: string): string =>
  `${home}/.local/share/q-lab/runes/explain/`;

const pad = (n: number): string => String(n).padStart(2, "0");

export const explainerPath = (
  home: string,
  project: string,
  session: string,
  at: Date,
  title: string,
): string => {
  const day = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}${pad(at.getMinutes())}`;
  return `${explainRoot(home)}${slugOf(project)}/${day}-${session.slice(0, 8)}/${time}-${slugOf(title)}.html`;
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
  session: string,
  page: Omit<Page, "generatedAt">,
  at: Date,
): Promise<string> => {
  const template = await io.read(`${root}/hooks/explain/template.html`);
  const first = explainerPath(home, page.project, session, at, page.title);
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
