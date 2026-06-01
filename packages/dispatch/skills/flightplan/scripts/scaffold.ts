#!/usr/bin/env bun
/**
 * Scaffold a flightplan tree for a topic.
 *
 *   docs/<slug>/
 *     tasks/
 *       _context/
 *       <bucket>/        (one dir per bucket; empty)
 *
 * Only creates directories. Content (PLAN.md, _context/*.md, tasks/<bucket>/*.md)
 * is written by the caller afterwards. That keeps the script atomic enough — if
 * later content writes fail, the empty tree is fine to delete and retry
 * (`trash docs/<slug>/`).
 *
 * The root `docs/<slug>/` dir is created non-recursively so a TOCTOU race
 * between checkCollision() and mkdir() throws EEXIST instead of silently
 * overwriting.
 *
 * Usage:
 *   bun scaffold.ts [--check] <slug> [<bucket>[,<bucket>...]] [--docs-root <path>]
 */
import { mkdir, access } from "node:fs/promises";
import { join } from "node:path";

export type CollisionResult = {
  exists: boolean;
  suggestedAlt: string | null;
};

export type ScaffoldInput = {
  slug: string;
  buckets: string[];
  docsRoot: string; // default "docs"
};

export type ScaffoldResult = {
  rootDir: string;
  bucketDirs: string[];
};

const SLUG_REGEX = /^[a-z][a-z0-9-]*$/;
// BUCKETs must be a single kebab token (no internal dashes). The H1 parser
// in lib/parse-task.ts treats BUCKET as one uppercase token, so dashed bucket
// names would scaffold but never lint or appear in build-readme output.
const BUCKET_REGEX = /^[a-z][a-z0-9]*$/;

/** Check whether docs/<slug>/ exists. Returns a suggested alt slug if it does. */
export async function checkCollision(
  slug: string,
  docsRoot = "docs",
): Promise<CollisionResult> {
  const dir = join(docsRoot, slug);
  try {
    await access(dir);
  } catch {
    return { exists: false, suggestedAlt: null };
  }
  return { exists: true, suggestedAlt: await nextAvailable(slug, docsRoot) };
}

async function nextAvailable(slug: string, docsRoot: string): Promise<string> {
  for (let i = 2; i < 100; i++) {
    const candidate = `${slug}-v${i}`;
    try {
      await access(join(docsRoot, candidate));
    } catch {
      return candidate;
    }
  }
  return `${slug}-v${Date.now()}`;
}

export function validateInput(input: ScaffoldInput): string | null {
  if (!SLUG_REGEX.test(input.slug)) {
    return `slug must be kebab-case (got: ${JSON.stringify(input.slug)})`;
  }
  if (input.buckets.length === 0) {
    return "at least one bucket is required";
  }
  for (const b of input.buckets) {
    if (!BUCKET_REGEX.test(b)) {
      return `bucket must be a single kebab token without internal dashes (got: ${JSON.stringify(b)})`;
    }
  }
  return null;
}

export async function scaffold(input: ScaffoldInput): Promise<ScaffoldResult> {
  const err = validateInput(input);
  if (err) throw new Error(err);

  const collision = await checkCollision(input.slug, input.docsRoot);
  if (collision.exists) {
    throw new Error(
      `${input.docsRoot}/${input.slug} already exists — refuse to overwrite. Try slug "${collision.suggestedAlt}".`,
    );
  }

  const rootDir = join(input.docsRoot, input.slug);

  // Ensure docsRoot exists, but create rootDir non-recursively so a TOCTOU
  // race throws EEXIST instead of silently merging into an existing dir.
  await mkdir(input.docsRoot, { recursive: true });
  await mkdir(rootDir); // throws if rootDir already exists

  const tasksDir = join(rootDir, "tasks");
  await mkdir(tasksDir);
  await mkdir(join(tasksDir, "_context"));

  const bucketDirs: string[] = [];
  for (const bucket of input.buckets) {
    const dir = join(tasksDir, bucket);
    await mkdir(dir);
    bucketDirs.push(dir);
  }

  return { rootDir, bucketDirs };
}

function parseArgs(argv: string[]): {
  slug?: string;
  buckets: string[];
  docsRoot: string;
  checkOnly: boolean;
} {
  const args = {
    slug: undefined as string | undefined,
    buckets: [] as string[],
    docsRoot: "docs",
    checkOnly: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--docs-root") {
      args.docsRoot = argv[++i] ?? args.docsRoot;
    } else if (argv[i] === "--check") {
      args.checkOnly = true;
    } else {
      positional.push(argv[i]);
    }
  }
  args.slug = positional[0];
  if (positional[1]) {
    args.buckets = positional[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return args;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    console.error(
      "Usage: bun scaffold.ts [--check] <slug> [<bucket>[,<bucket>...]] [--docs-root <path>]",
    );
    process.exit(2);
  }
  const args = parseArgs(argv);
  if (!args.slug) {
    console.error("Missing slug.");
    process.exit(2);
  }

  if (args.checkOnly) {
    const collision = await checkCollision(args.slug, args.docsRoot);
    if (collision.exists) {
      console.log(`EXISTS: ${collision.suggestedAlt}`);
      process.exit(1);
    }
    console.log("OK");
    return;
  }

  try {
    const result = await scaffold({
      slug: args.slug,
      buckets: args.buckets,
      docsRoot: args.docsRoot,
    });
    console.log(`Scaffolded ${result.rootDir}`);
    for (const d of result.bucketDirs) console.log(`  + ${d}/`);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
