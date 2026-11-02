import { basename, dirname, extname, resolve } from "node:path";

export type Spring = { stiffness: number; damping: number; mass: number };
export type Bezier = [number, number, number, number];

type Base = {
  id: string;
  label: string;
  folder: string;
  bind: "css" | "js";
  target: string;
};
export type NumericParam = Base & {
  type: "range" | "number" | "duration";
  min: number;
  max: number;
  step: number;
  unit: string;
  default: number;
};
export type Param =
  | NumericParam
  | (Base & { type: "color"; default: string })
  | (Base & { type: "select"; options: string[]; default: string })
  | (Base & { type: "toggle"; default: boolean })
  | (Base & { type: "bezier"; default: Bezier })
  | (Base & { type: "spring"; default: Spring });
export type Value = Param["default"];

export type Spec = {
  title: string;
  mode: "isolated" | "in-situ";
  snippet?: string;
  params: Param[];
};

export class SpecError extends Error {}

const TYPES = [
  "range",
  "number",
  "duration",
  "color",
  "select",
  "toggle",
  "bezier",
  "spring",
];
const isNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

function fail(id: string, message: string): never {
  throw new SpecError(`param "${id}": ${message}`);
}

function labelFor(id: string): string {
  const words = id.replace(/[-_]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function numeric(raw: Record<string, unknown>, base: Base): NumericParam {
  const type = raw.type as NumericParam["type"];
  const duration = type === "duration";
  const min = raw.min ?? (duration ? 0 : undefined);
  const max = raw.max ?? (duration ? 2000 : undefined);
  if (!isNum(min) || !isNum(max))
    fail(base.id, `${type} needs numeric min and max`);
  if (min >= max) fail(base.id, `min ${min} is not below max ${max}`);
  const step = raw.step ?? (duration ? 10 : (max - min) / 100);
  if (!isNum(step) || step <= 0)
    fail(base.id, "step must be a positive number");
  const value = raw.default ?? min;
  if (!isNum(value) || value < min || value > max)
    fail(base.id, `default must lie within ${min}–${max}`);
  const unit = raw.unit ?? (duration ? "ms" : "");
  if (typeof unit !== "string") fail(base.id, "unit must be a string");
  return { ...base, type, min, max, step, unit, default: value };
}

function param(raw: unknown, specTarget: string): Param {
  if (typeof raw !== "object" || raw === null)
    throw new SpecError("every param must be an object");
  const r = raw as Record<string, unknown>;
  const id = r.id;
  if (typeof id !== "string" || !/^[a-z][a-z0-9-]*$/i.test(id))
    throw new SpecError(
      `param id ${JSON.stringify(id)} must be letters, digits and hyphens`,
    );
  if (typeof r.type !== "string" || !TYPES.includes(r.type))
    fail(id, `type must be one of ${TYPES.join(", ")}`);
  if (r.bind !== undefined && r.bind !== "css" && r.bind !== "js")
    fail(id, 'bind must be "css" or "js"');
  const base: Base = {
    id,
    label: typeof r.label === "string" ? r.label : labelFor(id),
    folder: typeof r.folder === "string" ? r.folder : "Params",
    bind: (r.bind as Base["bind"]) ?? "css",
    target: typeof r.target === "string" ? r.target : specTarget,
  };

  switch (r.type) {
    case "range":
    case "number":
    case "duration":
      return numeric(r, base);
    case "color": {
      const value = r.default ?? "#000000";
      if (
        typeof value !== "string" ||
        !/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)
      )
        fail(id, "colour default must be #rgb or #rrggbb");
      return { ...base, type: "color", default: value };
    }
    case "select": {
      const options: unknown[] = Array.isArray(r.options) ? r.options : [];
      if (
        options.length === 0 ||
        !options.every((o): o is string => typeof o === "string")
      )
        fail(id, "select needs a non-empty list of string options");
      const value = r.default ?? options[0];
      if (!options.includes(value as string))
        fail(id, `default ${JSON.stringify(value)} is not one of the options`);
      return { ...base, type: "select", options, default: value as string };
    }
    case "toggle": {
      const value = r.default ?? false;
      if (typeof value !== "boolean")
        fail(id, "toggle default must be true or false");
      return { ...base, type: "toggle", default: value };
    }
    case "bezier": {
      const value = r.default ?? [0.25, 0.1, 0.25, 1];
      if (!Array.isArray(value) || value.length !== 4 || !value.every(isNum))
        fail(id, "bezier default must be four numbers");
      if (value[0] < 0 || value[0] > 1 || value[2] < 0 || value[2] > 1)
        fail(id, "bezier x values must lie within 0–1");
      return { ...base, type: "bezier", default: value as Bezier };
    }
    default: {
      const d = (r.default ?? {}) as Record<string, unknown>;
      const value = {
        stiffness: d.stiffness ?? 170,
        damping: d.damping ?? 26,
        mass: d.mass ?? 1,
      };
      if (
        ![value.stiffness, value.damping, value.mass].every(
          (n) => isNum(n) && n > 0,
        )
      )
        fail(id, "spring stiffness, damping and mass must be positive numbers");
      return { ...base, type: "spring", default: value as Spring };
    }
  }
}

export function parseSpec(raw: unknown, specPath: string): Spec {
  if (typeof raw !== "object" || raw === null)
    throw new SpecError("the spec must be a JSON object");
  const r = raw as Record<string, unknown>;
  const mode = r.mode ?? "isolated";
  if (mode !== "isolated" && mode !== "in-situ")
    throw new SpecError('mode must be "isolated" or "in-situ"');
  if (!Array.isArray(r.params) || r.params.length === 0)
    throw new SpecError("params must be a non-empty list");
  const target = typeof r.target === "string" ? r.target : ":root";
  const params = r.params.map((p) => param(p, target));
  const seen = new Set<string>();
  for (const p of params) {
    if (seen.has(p.id)) throw new SpecError(`duplicate param id "${p.id}"`);
    seen.add(p.id);
  }
  let snippet: string | undefined;
  if (mode === "isolated") {
    if (typeof r.snippet !== "string")
      throw new SpecError("an isolated spec needs a snippet path");
    snippet = resolve(dirname(specPath), r.snippet);
  }
  const title =
    typeof r.title === "string"
      ? r.title
      : basename(specPath, extname(specPath));
  return { title, mode, snippet, params };
}
