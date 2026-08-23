#!/usr/bin/env bun
// Answers one question: did a Herdr protocol upgrade break THIS plugin?
//
// It compares the running server's API schema against a committed baseline,
// narrowed to the request methods the plugin actually sends. Reading full
// schemas into an agent's context costs tens of thousands of tokens and invites
// a guess; a diff against a baseline is usually empty and costs a few hundred.
//
// The schema-shaping and diff logic is exported and pure. Only main() touches
// subprocesses, so the interesting behaviour is testable without a live server.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import { execFileSync } from "node:child_process";

type JsonSchema = Record<string, unknown>;
export type Shape = {
  required: string[];
  props: string[];
  schemas: Record<string, JsonSchema>;
};
export type Baseline = {
  protocol: number;
  methods: Record<string, Shape>;
  responses: Record<string, Shape>;
};

function normalizedSchema(
  node: any,
  defs: Record<string, any>,
  resolving = new Set<string>(),
): JsonSchema {
  if (!node || typeof node !== "object") return {};
  if (node.$ref) {
    const name = String(node.$ref).split("/").pop() ?? "";
    if (resolving.has(name)) return { $ref: name };
    const next = new Set(resolving).add(name);
    return normalizedSchema(defs[name], defs, next);
  }

  const result: JsonSchema = {};
  for (const key of Object.keys(node).sort()) {
    const value = node[key];
    if (key === "description" || key === "title" || key === "default") continue;
    if (key === "properties") {
      result[key] = Object.fromEntries(
        Object.entries(value ?? {})
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, schema]) => [
            name,
            normalizedSchema(schema, defs, resolving),
          ]),
      );
    } else if (key === "items") {
      result[key] = normalizedSchema(value, defs, resolving);
    } else if (key === "oneOf" || key === "anyOf" || key === "allOf") {
      result[key] = (value ?? [])
        .map((part: unknown) => normalizedSchema(part, defs, resolving))
        .sort((a: JsonSchema, b: JsonSchema) =>
          JSON.stringify(a).localeCompare(JSON.stringify(b)),
        );
    } else if (Array.isArray(value)) {
      result[key] = [...value].sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

/** Sorted and dereferenced so reordering and $ref placement do not hide changes. */
export const shapeOf = (node: any, defs: Record<string, any> = {}): Shape => {
  const props = Object.keys(node?.properties ?? {}).sort();
  return {
    required: [...(node?.required ?? [])].sort(),
    props,
    schemas: Object.fromEntries(
      props.map((name) => [
        name,
        normalizedSchema(node.properties[name], defs),
      ]),
    ),
  };
};

/** Every method the server accepts, mapped to the $defs name of its params. */
export function serverMethods(schema: any): Record<string, string> {
  const found: Record<string, string> = {};
  for (const variant of schema?.schemas?.request?.oneOf ?? []) {
    const method = variant.properties?.method?.const;
    if (method) {
      found[method] =
        String(variant.properties?.params?.$ref ?? "")
          .split("/")
          .pop() ?? "";
    }
  }
  return found;
}

/**
 * The methods this plugin sends: the server's list intersected with the string
 * literals in its source. Deriving it beats a hand-kept list, because a new call
 * site cannot silently fall outside the check.
 */
export function usedMethods(schema: any, literals: Set<string>): string[] {
  return Object.keys(serverMethods(schema))
    .filter((method) => literals.has(method))
    .sort();
}

export function buildBaseline(
  schema: any,
  used: string[],
  literals: Set<string> = new Set(),
): Baseline {
  const paramsDefs = schema?.schemas?.request?.$defs ?? {};
  const methodParams = serverMethods(schema);
  const baseline: Baseline = {
    protocol: schema?.protocol,
    methods: {},
    responses: {},
  };

  for (const method of used) {
    baseline.methods[method] = shapeOf(
      paramsDefs[methodParams[method]],
      paramsDefs,
    );
  }

  const okDefs: Record<string, any> =
    schema?.schemas?.success_response?.$defs ?? {};
  for (const variant of okDefs.ResponseResult?.oneOf ?? []) {
    const kind = variant.properties?.type?.const;
    if (kind && literals.has(kind)) {
      baseline.responses[kind] = shapeOf(variant, okDefs);
    }
  }
  return baseline;
}

function compare(
  kind: string,
  was: Record<string, Shape>,
  now: Record<string, Shape>,
  // A request gaining a required field invalidates the plugin's existing calls.
  // A response gaining one only means the server always sends it, which is safe.
  newRequiredBreaks: boolean,
): string[] {
  const breaks: string[] = [];
  for (const [name, before] of Object.entries(was)) {
    const after = now[name];
    if (!after) {
      breaks.push(`${kind} ${name}: gone`);
      continue;
    }
    const dropped = before.props.filter((p) => !after.props.includes(p));
    if (dropped.length)
      breaks.push(`${kind} ${name}: dropped ${dropped.join(", ")}`);
    const changed = before.props.filter(
      (prop) =>
        before.schemas !== undefined &&
        after.props.includes(prop) &&
        schemaBreaks(
          before.schemas?.[prop] ?? {},
          after.schemas?.[prop] ?? {},
          newRequiredBreaks,
        ),
    );
    if (changed.length)
      breaks.push(`${kind} ${name}: changed ${changed.join(", ")} schema`);
    if (newRequiredBreaks) {
      const added = after.required.filter((r) => !before.required.includes(r));
      if (added.length)
        breaks.push(`${kind} ${name}: now requires ${added.join(", ")}`);
    } else {
      const optional = before.required.filter(
        (field) => !after.required.includes(field),
      );
      if (optional.length)
        breaks.push(`${kind} ${name}: may omit ${optional.join(", ")}`);
    }
  }
  return breaks;
}

function schemaBreaks(
  before: JsonSchema,
  after: JsonSchema,
  requestDirection: boolean,
): boolean {
  const beforeProps = before.properties as JsonSchema | undefined;
  const afterProps = after.properties as JsonSchema | undefined;
  if (beforeProps || afterProps) {
    for (const [name, schema] of Object.entries(beforeProps ?? {})) {
      if (!afterProps?.[name]) return true;
      if (
        schemaBreaks(
          schema as JsonSchema,
          afterProps[name] as JsonSchema,
          requestDirection,
        )
      )
        return true;
    }
    const beforeRequired = new Set((before.required as string[]) ?? []);
    const afterRequired = new Set((after.required as string[]) ?? []);
    const unsafeRequired = requestDirection
      ? [...afterRequired].some((name) => !beforeRequired.has(name))
      : [...beforeRequired].some((name) => !afterRequired.has(name));
    if (unsafeRequired) return true;
  }

  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === "properties" || key === "required") continue;
    const was = before[key];
    const now = after[key];
    if (key === "items" && was && now) {
      if (schemaBreaks(was as JsonSchema, now as JsonSchema, requestDirection))
        return true;
      continue;
    }
    if (JSON.stringify(was) === JSON.stringify(now)) continue;
    if (key === "enum" || key === "type") {
      const oldValues = new Set(Array.isArray(was) ? was : [was]);
      const newValues = new Set(Array.isArray(now) ? now : [now]);
      const safe = requestDirection
        ? [...oldValues].every((value) => newValues.has(value))
        : [...newValues].every((value) => oldValues.has(value));
      if (safe) continue;
    }
    if (
      key === "minimum" &&
      typeof was === "number" &&
      typeof now === "number"
    ) {
      if (requestDirection ? now <= was : now >= was) continue;
    }
    if (
      key === "maximum" &&
      typeof was === "number" &&
      typeof now === "number"
    ) {
      if (requestDirection ? now >= was : now <= was) continue;
    }
    if (
      key === "additionalProperties" &&
      typeof was === "boolean" &&
      typeof now === "boolean"
    ) {
      if (requestDirection ? !was && now : was && !now) continue;
    }
    if (was === undefined && !requestDirection) continue;
    if (now === undefined && requestDirection) continue;
    return true;
  }
  return false;
}

/** Additions are ignored throughout: they are what a safe protocol bump looks like. */
export function diff(base: Baseline, current: Baseline): string[] {
  const legacy = Object.values(base.methods).some(
    (shape) => shape.schemas === undefined,
  );
  return [
    ...compare("method", base.methods, current.methods, true),
    ...(legacy
      ? []
      : compare("response", base.responses, current.responses, false)),
  ];
}

export function summary(
  base: Baseline,
  current: Baseline,
  breaks: string[],
): string[] {
  const move =
    base.protocol === current.protocol
      ? `protocol ${current.protocol} unchanged`
      : `protocol ${base.protocol} → ${current.protocol}`;
  const used = Object.keys(current.methods).length;

  if (breaks.length === 0) {
    return [
      `${move}: no breaking change across ${used} methods this plugin sends.`,
      "Safe to raise the minimum-protocol constant. Rerun with --update afterwards.",
    ];
  }
  return [
    `${move}: ${breaks.length} breaking change(s).`,
    ...breaks.map((line) => `  ${line}`),
    "Fix the call sites before touching the constant.",
  ];
}

/** One pattern, fed to both `git grep -E` and RegExp. Kept to the dialects'
 *  common subset: POSIX ERE has no `(?:`, so the group stays capturing and
 *  extractLiterals reads group 1. Two copies would drift, and a narrowed
 *  pattern silently stops detecting methods — which is this script's whole job. */
const METHOD_LITERAL = "[\"'`]([a-z_]+(\\.[a-z_]+)*)[\"'`]";

/** Quoted identifiers in tracked source, including single and multi-part methods. */
export function extractLiterals(source: string): Set<string> {
  return new Set(
    [...source.matchAll(new RegExp(METHOD_LITERAL, "g"))].map(
      (match) => match[1],
    ),
  );
}

export function sourceLiterals(
  repo: string,
  baselinePath?: string,
): Set<string> {
  // The baseline names every method it tracks, so grepping it would feed those
  // names back in and widen the check to methods the plugin never sends. The
  // path is the caller's to decide (--baseline), hence not hardcoded here.
  const baseline = relative(
    repo,
    baselinePath ?? `${repo}/.herdr-protocol.json`,
  );
  let matches = "";
  try {
    // Prose is excluded deliberately: a plugin's docs tend to describe Herdr's
    // whole API surface, which would widen the check to uncalled methods.
    matches = execFileSync(
      "git",
      [
        "-C",
        repo,
        "grep",
        "-hoE",
        METHOD_LITERAL,
        "--",
        ":!*.md",
        ":!*.txt",
        ":!docs/",
        // A baseline outside the repo is not tracked, so it needs no exclusion —
        // and `:!../x` is not a pathspec git accepts.
        ...(baseline.startsWith("..") ? [] : [`:!${baseline}`]),
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (error: any) {
    // git grep exits non-zero when nothing matches, which is not an error here.
    if (error?.status !== 1) throw error;
  }
  return extractLiterals(matches);
}

function main(argv: string[]): number {
  const flag = (name: string, fallback: string) => {
    const at = argv.indexOf(name);
    return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
  };
  const repo = flag("--repo", process.cwd());
  const baselinePath = flag("--baseline", `${repo}/.herdr-protocol.json`);

  const schema = JSON.parse(
    execFileSync("herdr", ["api", "schema", "--json"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
  const literals = sourceLiterals(repo, baselinePath);
  const used = usedMethods(schema, literals);
  if (used.length === 0) {
    throw new Error(`No Herdr methods found in tracked source under ${repo}`);
  }
  const current = buildBaseline(schema, used, literals);

  const save = (why: string) => {
    writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
    console.log(
      `${why}: wrote protocol ${current.protocol} baseline to ${baselinePath}`,
    );
    console.log(`Tracking ${used.length} methods: ${used.join(", ")}`);
  };

  if (argv.includes("--update")) {
    save("Updated");
    return 0;
  }
  if (!existsSync(baselinePath)) {
    save("No baseline yet");
    console.log("Commit it. Later upgrades diff against this file.");
    return 0;
  }

  const base: Baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const breaks = diff(base, current);
  for (const line of summary(base, current, breaks)) console.log(line);
  return breaks.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
