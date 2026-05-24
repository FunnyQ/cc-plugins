// cockpit design-system API: reads this plugin's own DESIGN.md and returns a
// compact, structured visual model for the dashboard instrument panel.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

const DESIGN_PATH = join(import.meta.dir, "..", "DESIGN.md");

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

export function readCockpitDesignSystem(): CockpitDesignSystem {
  if (!existsSync(DESIGN_PATH)) throw new Error("DESIGN.md not found");
  return parseCockpitDesignSystem(readFileSync(DESIGN_PATH, "utf8"));
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

export function handleDesignSystem(): Response {
  try {
    return json(readCockpitDesignSystem());
  } catch (err) {
    return json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
}
