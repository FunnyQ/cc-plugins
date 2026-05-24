// cockpit project-info — reads a project's locked settings (goal + project-meta
// prose + assistant instruction files) and parses its DESIGN.md design tokens
// into a flat map the SPA applies as CSS custom properties.
//
// DESIGN.md format assumption: the Google DESIGN.md open standard — a Markdown
// file whose YAML frontmatter holds `colors:` / `typography:` / `rounded:` /
// `spacing:` maps (see github.com/google-labs-code/design.md). We parse that
// frontmatter with Bun.YAML and map a few semantic slots onto cockpit's tokens.
// If DESIGN.md is absent or unparseable, tokens = null (SPA keeps its defaults).
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { readRegistry, readProjectGoal } from "./registry";
import { jsonResponse as json } from "./http";

export type ProjectTokens = {
  colorBg?: string;
  colorSurface?: string;
  colorFg?: string;
  colorMuted?: string;
  colorBorder?: string;
  accent?: string;
  fontSans?: string;
  fontMono?: string;
  radius?: string;
  radiusSm?: string;
};

export type ProjectInfo = {
  projectGoal: string;
  meta: string; // prose body of project-meta.md (after frontmatter)
  claudeMd: string | null;
  agentsMd: string | null;
  tokens: ProjectTokens | null;
};

// ---------- meta prose ----------

function readMetaBody(project: string): string {
  const p = join(project, ".cockpit", "project-meta.md");
  if (!existsSync(p)) return "";
  try {
    const raw = readFileSync(p, "utf8");
    const m = raw.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
    return (m ? m[1] : raw).trim();
  } catch {
    return "";
  }
}

// ---------- instruction files (path-confined to the project root) ----------

function readRootMarkdown(
  project: string,
  filename: "CLAUDE.md" | "AGENTS.md",
): string | null {
  const candidate = join(project, filename);
  if (!existsSync(candidate)) return null;
  try {
    const realProject = realpathSync(project);
    const realFile = realpathSync(candidate);
    // Confine: accept only the project root's own file. If the entry is a
    // symlink that resolves anywhere else (outside the root, or to a different
    // in-project path), its realpath won't equal <root>/<filename> -> reject.
    if (realFile !== join(realProject, filename)) {
      return null;
    }
    return readFileSync(realFile, "utf8");
  } catch {
    return null;
  }
}

// ---------- DESIGN.md → tokens ----------

// Perceptual lightness 0–100 for oklch() or hex colors; null if unknown format.
function lightnessOf(value: string): number | null {
  const s = value.trim();
  const ok = s.match(/oklch\(\s*([\d.]+)%/i);
  if (ok) return parseFloat(ok[1]);
  const hex = s.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/);
  if (hex) {
    let h = hex[1];
    if (h.length === 3)
      h = h
        .split("")
        .map((c) => c + c)
        .join("");
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return ((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255) * 100;
  }
  return null;
}

// Rough chroma/saturation for accent fallback.
function chromaOf(value: string): number {
  const s = value.trim();
  const ok = s.match(/oklch\(\s*[\d.]+%\s+([\d.]+)/i);
  if (ok) return parseFloat(ok[1]);
  const hex = s.match(/^#([0-9a-fA-F]{6})\b/);
  if (hex) {
    const r = parseInt(hex[1].slice(0, 2), 16);
    const g = parseInt(hex[1].slice(2, 4), 16);
    const b = parseInt(hex[1].slice(4, 6), 16);
    return (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
  }
  return 0;
}

type ColorEntry = [string, string];

// First color whose name matches `prefer` (and not `reject`), file order.
function find(
  entries: ColorEntry[],
  prefer: RegExp,
  reject?: RegExp,
): string | undefined {
  for (const [k, v] of entries) {
    if (prefer.test(k) && (!reject || !reject.test(k))) return v;
  }
  return undefined;
}

function extreme(
  entries: ColorEntry[],
  dir: "light" | "dark",
): string | undefined {
  let best: string | undefined;
  let bestL = dir === "light" ? -1 : 101;
  for (const [, v] of entries) {
    const l = lightnessOf(v);
    if (l === null) continue;
    if ((dir === "light" && l > bestL) || (dir === "dark" && l < bestL)) {
      bestL = l;
      best = v;
    }
  }
  return best;
}

function mostSaturated(entries: ColorEntry[]): string | undefined {
  let best: string | undefined;
  let bestC = -1;
  for (const [, v] of entries) {
    const c = chromaOf(v);
    if (c > bestC) {
      bestC = c;
      best = v;
    }
  }
  return best;
}

// Pick the first typography family that looks monospace.
function findMono(typography: Record<string, any>): string | undefined {
  for (const role of Object.values(typography || {})) {
    const fam = (role as any)?.fontFamily;
    if (typeof fam === "string" && /mono/i.test(fam)) return fam;
  }
  return undefined;
}

function defined<T extends object>(obj: T): T | null {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== "") out[k] = v;
  }
  return Object.keys(out).length ? (out as T) : null;
}

export function parseDesignTokens(project: string): ProjectTokens | null {
  const p = join(project, "DESIGN.md");
  if (!existsSync(p)) return null;
  let fm: any;
  try {
    const raw = readFileSync(p, "utf8");
    const m = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!m) return null;
    fm = Bun.YAML.parse(m[1]);
  } catch {
    return null;
  }
  if (!fm || typeof fm !== "object") return null;

  const colors: ColorEntry[] = Object.entries(fm.colors || {})
    .filter(([, v]) => typeof v === "string")
    .map(([k, v]) => [k, v as string]);
  const typography = fm.typography || {};
  const rounded = fm.rounded || {};

  const colorBg =
    find(
      colors,
      /paper|cream|bg|background|canvas|^base|surface|well/i,
      /soft|alpha|sink|-2$/i,
    ) ?? extreme(colors, "light");
  const colorFg =
    find(colors, /ink|fg|foreground|text|black/i, /soft|muted|faint|alpha/i) ??
    extreme(colors, "dark");
  const accent =
    find(colors, /accent|primary|brand|highlight/i, /soft|alpha/i) ??
    find(
      colors,
      /gold|coral|oxblood|teal|azure|violet|magenta|amber|sky/i,
      /soft|alpha/i,
    ) ??
    mostSaturated(colors);

  const tokens: ProjectTokens = {
    colorBg,
    colorSurface: find(
      colors,
      /surface|ash|card|panel|paper-2|cream-2/i,
      /alpha/i,
    ),
    colorFg,
    colorMuted: find(colors, /muted|faint|secondary|ink-soft/i, /alpha/i),
    colorBorder:
      find(colors, /border|edge|rule|divider|line/i, /strong|alpha/i) ??
      find(colors, /border|edge|rule/i, /alpha/i),
    accent,
    fontSans:
      typography.body?.fontFamily ??
      typography.title?.fontFamily ??
      typography.display?.fontFamily,
    fontMono: findMono(typography),
    radius: rounded.md ?? rounded.lg ?? rounded.sm ?? rounded.base,
    radiusSm: rounded.sm ?? rounded.xs ?? rounded.md,
  };

  return defined(tokens);
}

// ---------- builder ----------

export function buildProjectInfo(project: string): ProjectInfo {
  return {
    projectGoal: readProjectGoal(project),
    meta: readMetaBody(project),
    claudeMd: readRootMarkdown(project, "CLAUDE.md"),
    agentsMd: readRootMarkdown(project, "AGENTS.md"),
    tokens: parseDesignTokens(project),
  };
}

// ---------- HTTP handler ----------

export function handleProjectInfo(req: Request): Response {
  try {
    const url = new URL(req.url);
    const project = url.searchParams.get("project") || "";
    // Confine: only serve projects the daemon already knows from the registry.
    const known = new Set(readRegistry().map((e) => e.project));
    if (!project || !known.has(project)) {
      return json({ error: "unknown project" }, 400);
    }
    return json(buildProjectInfo(project));
  } catch (err) {
    return json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
}
