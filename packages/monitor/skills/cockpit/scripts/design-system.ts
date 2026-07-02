// cockpit design-system API: reads this plugin's own DESIGN.md and returns a
// compact, structured visual model for the dashboard instrument panel.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { readRegistry } from "./registry";

export type DesignToken = {
  key: string;
  name: string;
  value: string;
};

export type TypographyToken = DesignToken & {
  fontSize?: string;
  fontWeight?: string | number;
  lineHeight?: string | number;
  letterSpacing?: string;
};

export type ComponentToken = {
  key: string;
  name: string;
  backgroundColor?: string;
  textColor?: string;
  rounded?: string;
  padding?: string;
  height?: string;
  note?: string;
};

export type DesignRule = {
  name: string;
  body: string;
};

export type CockpitDesignSystem = {
  name: string;
  description: string;
  colors: DesignToken[];
  typography: TypographyToken[];
  rounded: DesignToken[];
  spacing: DesignToken[];
  components: ComponentToken[];
  rules: DesignRule[];
};

// The dashboard's DESIGN button reflects the *selected project's* design doc,
// not cockpit's own — we look for either casing directly under the project root.
const DESIGN_FILENAMES = ["DESIGN.md", "design.md"];

function titleize(key: string): string {
  return key.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function scalar(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : undefined;
}

function tokenList(source: unknown): DesignToken[] {
  if (!source || typeof source !== "object") return [];
  return Object.entries(source)
    .filter(([, value]) => scalar(value))
    .map(([key, value]) => ({
      key,
      name: titleize(key),
      value: String(value),
    }));
}

function typographyList(source: unknown): TypographyToken[] {
  if (!source || typeof source !== "object") return [];
  return Object.entries(source).map(([key, raw]) => {
    const spec =
      raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    return {
      key,
      name: titleize(key),
      value: scalar(spec.fontFamily) || "",
      fontSize: scalar(spec.fontSize),
      fontWeight: scalar(spec.fontWeight),
      lineHeight: scalar(spec.lineHeight),
      letterSpacing: scalar(spec.letterSpacing),
    };
  });
}

function componentList(source: unknown): ComponentToken[] {
  if (!source || typeof source !== "object") return [];
  return Object.entries(source).map(([key, raw]) => {
    const spec =
      raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    return {
      key,
      name: titleize(key),
      backgroundColor: scalar(spec.backgroundColor),
      textColor: scalar(spec.textColor),
      rounded: scalar(spec.rounded),
      padding: scalar(spec.padding),
      height: scalar(spec.height),
      note: scalar(spec.note),
    };
  });
}

function extractRules(markdown: string): DesignRule[] {
  const rules: DesignRule[] = [];
  const re =
    /\*\*(The [^*]+?Rule)\.\*\*\s*([\s\S]*?)(?=\n\n\*\*The [^*]+?Rule|\n## |\n### |$)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    rules.push({
      name: match[1],
      body: match[2].replace(/\s+/g, " ").trim(),
    });
  }
  return rules;
}

export function parseCockpitDesignSystem(
  markdown: string,
): CockpitDesignSystem {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error("DESIGN.md frontmatter not found");
  const fm = Bun.YAML.parse(match[1]) as Record<string, unknown>;
  if (!fm || typeof fm !== "object")
    throw new Error("DESIGN.md frontmatter invalid");

  return {
    name: scalar(fm.name) || "Design System",
    description: scalar(fm.description) || "",
    colors: tokenList(fm.colors),
    typography: typographyList(fm.typography),
    rounded: tokenList(fm.rounded),
    spacing: tokenList(fm.spacing),
    components: componentList(fm.components),
    rules: extractRules(markdown),
  };
}

// Resolve the project's design doc, path-confined to the project root (mirrors
// project-info.ts). A candidate that is a symlink resolving outside the root is
// rejected — its realpath won't equal <realRoot>/<filename>.
function resolveDesignPath(projectDir: string): string | null {
  let realRoot: string;
  try {
    realRoot = realpathSync(projectDir);
  } catch {
    return null;
  }
  for (const name of DESIGN_FILENAMES) {
    const candidate = join(projectDir, name);
    if (!existsSync(candidate)) continue;
    try {
      const realFile = realpathSync(candidate);
      if (realFile === join(realRoot, name)) return realFile;
    } catch {
      /* unreadable / dangling symlink — try the next name */
    }
  }
  return null;
}

export function readProjectDesignSystem(
  projectDir: string,
): CockpitDesignSystem {
  const path = resolveDesignPath(projectDir);
  if (!path) throw new Error("DESIGN.md not found");
  return parseCockpitDesignSystem(readFileSync(path, "utf8"));
}

function json(payload: object, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export function handleDesignSystem(projectDir?: string | null): Response {
  if (!projectDir) return json({ error: "project required" }, 404);
  // Confine: only serve projects the daemon already knows from the registry.
  const known = new Set(readRegistry().map((e) => e.project));
  if (!known.has(projectDir)) return json({ error: "unknown project" }, 404);
  try {
    return json(readProjectDesignSystem(projectDir));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: msg }, /not found/.test(msg) ? 404 : 500);
  }
}
