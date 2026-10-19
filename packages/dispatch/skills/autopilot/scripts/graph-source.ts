import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import type {
  GraphNode,
  NodeValidity,
} from "../../flightplan/scripts/lib/graph-node";
import {
  type FlightlogEntry,
  type StateEntry,
  readLog,
  runLogPath,
} from "../../flightplan/scripts/lib/flightlog";

export type DeckSource = "tasks" | "graph" | "none";

/** The two sources that actually carry a plan. */
export type DeckSourceKind = Exclude<DeckSource, "none">;

/** Impure: looks for a tasks/ directory, then a graph.json file. */
export function detectSource(planDir: string): DeckSource {
  // Every stat error is swallowed, not just ENOENT: `throwIfNoEntry: false` still
  // throws ENOTDIR when planDir is itself a file, and the caller owns that message.
  const stat = (name: string) => {
    try {
      return statSync(join(planDir, name));
    } catch {
      return undefined;
    }
  };
  // An existing task plan keeps its behaviour when someone drops a graph file beside it.
  if (stat("tasks")?.isDirectory()) return "tasks";
  if (stat("graph.json")?.isFile()) return "graph";
  return "none";
}

/** One error shape for both loaders, so the payload can concatenate them. */
export type PlanError = { file: string; bucket: string; reason: string };

export type ParsedGraph = {
  title: string;
  repoRoot: string;
  lanes: string[];
  /** Keyed by ref. Empty when the file failed validation. */
  nodes: Record<string, GraphNode>;
  errors: PlanError[];
};

// Empty bucket means no lane can be attributed to a whole-file or unplaceable-node error.
const FILE_BUCKET = "";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStrings(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function display(value: unknown): string {
  return value === undefined ? "missing" : JSON.stringify(value);
}

/** Pure: the fallback is supplied explicitly because an error label is not a directory. */
export function parseGraph(
  text: string,
  fileLabel: string,
  fallbackTitle: string,
): ParsedGraph {
  const result: ParsedGraph = {
    title: fallbackTitle,
    repoRoot: "",
    lanes: [],
    nodes: {},
    errors: [],
  };
  const error = (reason: string, bucket = FILE_BUCKET) => {
    result.errors.push({ file: fileLabel, bucket, reason });
  };

  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    error(`Invalid JSON; received ${display(text)}`);
    return result;
  }
  if (!isObject(root)) {
    error(`root must be an object; received ${display(root)}`);
    return result;
  }

  if (root.version !== 1)
    error(`version must be the number 1; received ${display(root.version)}`);
  if ("title" in root) {
    if (typeof root.title === "string") result.title = root.title;
    else error(`title must be a string; received ${display(root.title)}`);
  }
  if (
    typeof root.repoRoot !== "string" ||
    !root.repoRoot ||
    !isAbsolute(root.repoRoot)
  ) {
    error(
      `repoRoot must be a non-empty absolute path; received ${display(root.repoRoot)}`,
    );
  } else result.repoRoot = root.repoRoot;

  // Doubles as the per-node membership test below, so nodes never rescan the array.
  const declaredLanes = new Set<string>();
  if (!isStrings(root.lanes) || root.lanes.length === 0) {
    error(
      `lanes must be a non-empty array of strings; received ${display(root.lanes)}`,
    );
  } else {
    result.lanes = root.lanes;
    for (const lane of root.lanes) {
      if (declaredLanes.has(lane))
        error(
          `lanes contains duplicate ${display(lane)}; received ${display(root.lanes)}`,
        );
      declaredLanes.add(lane);
    }
  }

  if (!Array.isArray(root.nodes) || root.nodes.length === 0) {
    error(`nodes must be a non-empty array; received ${display(root.nodes)}`);
    return result;
  }

  const refs = new Set<string>();
  let finalReviewRef: string | undefined;
  for (const [index, node] of root.nodes.entries()) {
    if (!isObject(node)) {
      error(`nodes[${index}] must be an object; received ${display(node)}`);
      continue;
    }
    const bucket = typeof node.lane === "string" ? node.lane : FILE_BUCKET;
    const label = `nodes[${index}] (${display(node.ref)})`;
    const before = result.errors.length;
    for (const field of ["ref", "lane", "title"]) {
      if (typeof node[field] !== "string")
        error(
          `${label} ${field} must be a string; received ${display(node[field])}`,
          bucket,
        );
    }
    if (typeof node.ref === "string") {
      if (!/^[a-z][a-z0-9-]*\/\d{2}$/.test(node.ref)) {
        error(
          `${label} ref must match /^[a-z][a-z0-9-]*\\/\\d{2}$/; received ${display(node.ref)}`,
          bucket,
        );
      }
      if (refs.has(node.ref))
        error(`${label} ref is duplicate: ${display(node.ref)}`, bucket);
      refs.add(node.ref);
    }
    if (typeof node.lane === "string" && !declaredLanes.has(node.lane)) {
      error(
        `${label} lane must be listed in lanes; received ${display(node.lane)}`,
        bucket,
      );
    }
    for (const field of ["dependsOn", "blocks"]) {
      if (field in node && !isStrings(node[field])) {
        error(
          `${label} ${field} must be an array of strings; received ${display(node[field])}`,
          bucket,
        );
      }
    }
    if ("finalReview" in node && typeof node.finalReview !== "boolean") {
      error(
        `${label} finalReview must be a boolean; received ${display(node.finalReview)}`,
        bucket,
      );
    }
    if (node.finalReview === true && typeof node.ref === "string") {
      if (finalReviewRef !== undefined) {
        error(
          `${label} finalReview is true for both ${display(finalReviewRef)} and ${display(node.ref)}; keep at most one`,
          bucket,
        );
      }
      finalReviewRef = node.ref;
    }

    if (
      result.errors.length !== before ||
      typeof node.ref !== "string" ||
      typeof node.lane !== "string" ||
      typeof node.title !== "string"
    )
      continue;
    result.nodes[node.ref] = {
      ref: node.ref,
      bucket: node.lane,
      nn: node.ref.slice(-2),
      title: node.title,
      status: null,
      validity: { kind: "unfinished", status: null },
      dependsOn: isStrings(node.dependsOn) ? node.dependsOn : [],
      blocks: isStrings(node.blocks) ? node.blocks : [],
      finalReview:
        typeof node.finalReview === "boolean" ? node.finalReview : false,
    };
  }

  // A broken contract cannot be partially trusted; loading any nodes would suggest a run in progress.
  if (result.errors.length > 0) {
    result.nodes = {};
    return result;
  }
  // A bad edge leaves a sound graph: remove it so readiness cannot wait forever on a missing node.
  for (const node of Object.values(result.nodes)) {
    node.dependsOn = node.dependsOn.filter((ref) => {
      if (Object.hasOwn(result.nodes, ref)) return true;
      error(
        `Node ${display(node.ref)} dependsOn references undeclared ${display(ref)}; dependency removed`,
        node.bucket,
      );
      return false;
    });
  }
  return result;
}

/** Impure: reads <dir>/graph.json and turns read failures into the same error shape. */
export async function loadGraph(dir: string): Promise<ParsedGraph> {
  const file = join(dir, "graph.json");
  const fallbackTitle = basename(dir);
  let text: string;
  try {
    text = await readFile(file, "utf-8");
  } catch (error) {
    return {
      title: fallbackTitle,
      repoRoot: "",
      lanes: [],
      nodes: {},
      errors: [
        {
          file,
          bucket: FILE_BUCKET,
          reason: `Cannot read ${display(file)}: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
  return parseGraph(text, file, fallbackTitle);
}

/** Pure. Folds state declarations into a new node map without changing either input. */
export function applyStateEntries(
  nodes: Record<string, GraphNode>,
  entries: FlightlogEntry[],
): { nodes: Record<string, GraphNode>; errors: PlanError[] } {
  const errors: PlanError[] = [];
  const unknownRefs = new Set<string>();
  const latest = new Map<string, StateEntry>();
  const file = runLogPath("");
  for (const entry of entries) {
    if (!Object.hasOwn(nodes, entry.task)) {
      // One error per unknown ref, in first-seen order.
      if (unknownRefs.has(entry.task)) continue;
      unknownRefs.add(entry.task);
      errors.push({
        file,
        bucket: FILE_BUCKET,
        reason: `Entry task ${display(entry.task)} references an undeclared node`,
      });
      continue;
    }
    if (entry.kind === "state") latest.set(entry.task, entry);
  }

  const mapped = Object.fromEntries(
    Object.entries(nodes).map(([ref, node]) => {
      // The existing ladder requires todo for an unstarted node to become ready or in-progress.
      const updated = { ...node, status: node.status ?? "todo" };
      const entry = latest.get(ref);
      if (entry !== undefined) {
        const state: string = entry.state;
        switch (state) {
          case "done":
            updated.status = "done";
            updated.validity = { kind: "complete" };
            break;
          case "blocked":
            updated.status = "blocked";
            updated.validity = { kind: "unfinished", status: "blocked" };
            break;
          case "failed":
            updated.validity = {
              kind: "invalid",
              rule: "failed",
              reason: entry.message ?? "agent reported failure with no message",
            };
            break;
          default: {
            const reason = `Node ${display(ref)} declares unknown state ${display(state)}`;
            updated.validity = {
              kind: "invalid",
              rule: "unknown-state",
              reason,
            };
            errors.push({ file, bucket: node.bucket, reason });
          }
        }
      }
      return [ref, updated];
    }),
  );
  return { nodes: mapped, errors };
}

/** Impure: adapts the graph and shared trail for the existing pure payload builder. */
export async function loadGraphPlan(planDir: string) {
  const [graph, entries] = await Promise.all([
    loadGraph(planDir),
    readLog(runLogPath(planDir)),
  ]);
  const resolved = applyStateEntries(graph.nodes, entries);
  return {
    slug: basename(planDir),
    planTitle: graph.title,
    repo: basename(graph.repoRoot),
    bucketDirs: graph.lanes,
    loaded: {
      byRef: resolved.nodes,
      errors: [...graph.errors, ...resolved.errors],
    },
    entries,
  };
}
