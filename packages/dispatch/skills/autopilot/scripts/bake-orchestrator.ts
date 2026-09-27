/**
 * Bake the canonical orchestrator into a runnable Workflow script on disk.
 *
 * The fenced block in `references/orchestrator.md` is ~1,500 lines, too large to
 * transcribe reliably into `Workflow({ script })`. This extracts it, replaces
 * each `CFG` field with the scouted value, and writes it under the plan's
 * self-ignored `.flightlog/`, for `Workflow({ scriptPath })`. The file must sit
 * inside the working directory: scriptPath rejects a `/tmp` path.
 *
 *   bun bake-orchestrator.ts <<'EOF'
 *   { "slug": "my-plan", "repoRoot": "/abs/repo", ... }
 *   EOF
 *
 * Prints the absolute path of the baked script.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { FLIGHTLOG_DIRNAME } from "../../flightplan/scripts/lib/flightlog";

const ORCHESTRATOR = join(
  import.meta.dir,
  "..",
  "references",
  "orchestrator.md",
);

// A field left at its placeholder ('/abs/repo/...') scouts a tree that does not exist, which reads as "no work".
const REQUIRED = [
  "slug",
  "repoRoot",
  "tasksDir",
  "planPath",
  "logFile",
  "planGoal",
  "scriptsDir",
  "baseRef",
];
const PATHS = [
  "repoRoot",
  "tasksDir",
  "planPath",
  "logFile",
  "scriptsDir",
  "relayPath",
  "resumeTaskPath",
  "attestationFile",
];

/** The first ```javascript block of the orchestrator doc. */
export function extractScript(doc: string): string {
  const start = doc.indexOf("```javascript");
  if (start === -1)
    throw new Error("no ```javascript block in orchestrator.md");
  const bodyStart = doc.indexOf("\n", start) + 1;
  const end = doc.indexOf("\n```", bodyStart);
  if (end === -1) throw new Error("unterminated ```javascript block");
  return doc.slice(bodyStart, end);
}

/** Replace `CFG` field values with JS source literals, keeping each line's comment. */
export function bakeConfig(
  script: string,
  literals: Record<string, string>,
): string {
  const cfgStart = script.indexOf("const CFG = {");
  if (cfgStart === -1)
    throw new Error("no `const CFG = {` block in orchestrator script");
  const cfgEnd = script.indexOf("\n}", cfgStart);
  let cfg = script.slice(cfgStart, cfgEnd);
  for (const [field, literal] of Object.entries(literals)) {
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^(\\s*${escaped}:\\s*)[^,\\n]+(,.*)$`, "m");
    if (!pattern.test(cfg)) {
      throw new Error(
        `config field not found in orchestrator script: ${field}`,
      );
    }
    // A function replacement, so a `$` inside the value is never read as a group reference.
    cfg = cfg.replace(
      pattern,
      (_, head: string, tail: string) => `${head}${literal}${tail}`,
    );
  }
  return script.slice(0, cfgStart) + cfg + script.slice(cfgEnd);
}

/** Validate scouted CFG values and bake them into the orchestrator doc's script. */
export function bakeOrchestrator(
  doc: string,
  values: Record<string, unknown>,
): string {
  const missing = REQUIRED.filter(
    (field) => values[field] === undefined || values[field] === "",
  );
  if (missing.length > 0)
    throw new Error(`missing required CFG fields: ${missing.join(", ")}`);
  for (const field of PATHS) {
    const value = values[field];
    if (typeof value === "string" && value !== "" && !isAbsolute(value)) {
      throw new Error(`CFG.${field} must be an absolute path: ${value}`);
    }
  }
  const literals = Object.fromEntries(
    Object.entries(values).map(([field, value]) => [
      field,
      JSON.stringify(value),
    ]),
  );
  return bakeConfig(extractScript(doc), literals);
}

/** Where the baked script lands: beside the run log, inside the self-ignored `.flightlog/`. */
export function bakedScriptPath(planPath: string): string {
  return join(dirname(planPath), FLIGHTLOG_DIRNAME, "orchestrator.js");
}

if (import.meta.main) {
  try {
    const values = JSON.parse(await Bun.stdin.text()) as Record<
      string,
      unknown
    >;
    const script = bakeOrchestrator(
      await readFile(ORCHESTRATOR, "utf-8"),
      values,
    );
    const out = bakedScriptPath(values.planPath as string);
    await mkdir(dirname(out), { recursive: true });
    // Without the self-ignore, the inter-wave commit would sweep the baked script into the branch.
    const gitignore = join(dirname(out), ".gitignore");
    if (!existsSync(gitignore)) await writeFile(gitignore, "*\n");
    await writeFile(out, script);
    console.log(out);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
