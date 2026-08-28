import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { nextCursor, readRange, splitCompleteLines } from "./tail";
import type { AgentUsage, TokenCounts } from "./usage-types";

export type TranscriptSource = {
  /**
   * Re-scan and return the current state of every discovered agent.
   * Cheap to call repeatedly: only bytes appended since the last call are read.
   */
  read(): AgentUsage[];
};

/**
 * Claude Code names a project directory after the session's absolute cwd with every
 * non-alphanumeric character replaced by `-`. Uppercase survives, and a leading `/`
 * produces a leading `-`; a rule that trims or collapses dashes finds nothing on disk.
 * Verified by hand against real directory names — see `../_context/data-model.md`.
 */
export function projectSlug(absPath: string): string {
  return absPath.replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * Walk up from `planDir` until a `.git` entry exists, and return that directory.
 * Tested for existence, not directory-ness: a git worktree's `.git` is a plain file.
 */
export function repoRootOf(planDir: string): string | null {
  let dir = planDir;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Two prompt shapes cover every agent in the reference run — see ../_context/data-model.md.
const ANNOUNCE = /--task (\S+) --role (\S+)/;
const ATTEMPT = /--attempt (\d+)/;
const FINALIZE = /Finalize flightplan task (\S+) at /;

/** `message.content` is usually a string but may be an array of content blocks. */
function contentText(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content ?? "");
}

export function parseAgentPrompt(content: unknown): {
  task: string | null;
  role: string | null;
  attempt: number | undefined;
} {
  const text = contentText(content);

  const announce = ANNOUNCE.exec(text);
  if (announce) {
    const attemptMatch = ATTEMPT.exec(text);
    return {
      task: announce[1]!,
      role: announce[2]!,
      attempt: attemptMatch ? Number(attemptMatch[1]) : undefined,
    };
  }

  const finalize = FINALIZE.exec(text);
  if (finalize) {
    return { task: finalize[1]!, role: "mark-done", attempt: undefined };
  }

  // Unrecognised agent, not a failure — its usage still counts toward the plan total.
  return { task: null, role: null, attempt: undefined };
}

export function emptyCounts(): TokenCounts {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

// Wire names (Claude Code's snake_case) -> the repo's camelCase `TokenCounts` fields.
const WIRE_KEYS: Record<string, keyof TokenCounts> = {
  input_tokens: "input",
  output_tokens: "output",
  cache_read_input_tokens: "cacheRead",
  cache_creation_input_tokens: "cacheWrite",
};

/**
 * Sum only the four named counters and ignore everything else — future versions may
 * add nested or non-numeric fields, and a blind reduce would crash or invent tokens.
 */
export function addUsage(into: TokenCounts, raw: unknown): void {
  if (typeof raw !== "object" || raw === null) return;
  const record = raw as Record<string, unknown>;
  for (const [wireKey, field] of Object.entries(WIRE_KEYS)) {
    const value = record[wireKey];
    if (typeof value === "number" && Number.isInteger(value)) {
      into[field] += value;
    }
  }
}

type Membership = "pending" | "included" | "excluded";

type FileState = {
  cursor: number;
  partial: string;
  decoder: TextDecoder;
  counts: TokenCounts;
  models: string[];
  task: string | null;
  role: string | null;
  attempt: number | undefined;
  startedAt: string | null;
  membership: Membership;
};

function freshState(): FileState {
  return {
    cursor: 0,
    partial: "",
    decoder: new TextDecoder(),
    counts: emptyCounts(),
    models: [],
    task: null,
    role: null,
    attempt: undefined,
    startedAt: null,
    membership: "pending",
  };
}

function toAgentUsage(file: string, state: FileState): AgentUsage {
  return {
    file,
    task: state.task,
    role: state.role,
    attempt: state.attempt,
    startedAt: state.startedAt,
    models: [...state.models],
    counts: { ...state.counts },
  };
}

function listNames(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Workflow agents live under `<slug>/<sessionId>/subagents/workflows/wf_<runId>/`,
 * never directly under `subagents/` — that path holds plain Agent() subagents and returns
 * zero files for a Workflow run, which reads as "Workflow agents leave no transcript"
 * (the trap this whole feature exists past; see ../_context/data-model.md).
 * `journal.jsonl` and `.meta.json` sidecars are skipped: neither carries usage or a
 * label, and the `agent-*.jsonl` name filter excludes both for free.
 */
function discoverAgentFiles(slugDir: string): string[] {
  const found: string[] = [];
  for (const sessionId of listNames(slugDir)) {
    const workflowsDir = join(slugDir, sessionId, "subagents", "workflows");
    if (!isDirectory(workflowsDir)) continue;
    for (const wf of listNames(workflowsDir)) {
      if (!wf.startsWith("wf_")) continue;
      const wfDir = join(workflowsDir, wf);
      if (!isDirectory(wfDir)) continue;
      for (const name of listNames(wfDir)) {
        if (!name.startsWith("agent-") || !name.endsWith(".jsonl")) continue;
        found.push(join(wfDir, name));
      }
    }
  }
  return found;
}

/**
 * Decide membership from the file's first complete line. Both prompt shapes embed
 * the plan's absolute directory path, so the file belongs to this plan when the
 * stringified `message.content` contains it. Permanent once decided either way.
 */
function decideMembership(
  planDir: string,
  state: FileState,
  record: Record<string, unknown>,
): void {
  const message =
    typeof record.message === "object" && record.message !== null
      ? (record.message as Record<string, unknown>)
      : undefined;
  const content = message ? message.content : undefined;

  if (!contentText(content).includes(planDir)) {
    state.membership = "excluded";
    return;
  }

  state.membership = "included";
  const prompt = parseAgentPrompt(content);
  state.task = prompt.task;
  state.role = prompt.role;
  state.attempt = prompt.attempt;
  state.startedAt =
    typeof record.timestamp === "string" ? record.timestamp : null;
}

function ingestLine(planDir: string, state: FileState, rawLine: string): void {
  const line = rawLine.trim();
  if (!line) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return; // Malformed line: drop it, keep the rest.
  }
  if (typeof parsed !== "object" || parsed === null) return;
  const record = parsed as Record<string, unknown>;

  if (state.membership === "pending") {
    decideMembership(planDir, state, record);
  }
  if (state.membership !== "included") return;

  // A `started` or `result` line has no `message` key at all, so this guard is what
  // stops `line.message.usage` from throwing and killing the whole pass.
  if (
    record.type === "assistant" &&
    typeof record.message === "object" &&
    record.message !== null
  ) {
    const message = record.message as Record<string, unknown>;
    addUsage(state.counts, message.usage);
    if (
      typeof message.model === "string" &&
      !state.models.includes(message.model)
    ) {
      state.models.push(message.model);
    }
  }
}

/**
 * Tail one file from `state.cursor` to `size`. Reads new bytes first and only
 * mutates `state` once that read succeeds, so a throw from `readRange` (a lock, a
 * permission blip) never leaves the file half-reset with its prior counts erased.
 */
function processFile(
  planDir: string,
  file: string,
  state: FileState,
  size: number,
): void {
  const next = nextCursor(state.cursor, size);
  const from = next.reset ? 0 : next.from;
  if (size <= from) return; // Nothing new since the last pass.

  const bytes = readRange(file, from, size);

  let counts = state.counts;
  let models = state.models;
  let partial = state.partial;
  if (next.reset) {
    // A reset re-reads the whole file, so the old counts must not survive it —
    // keeping them would double-count everything already tallied before the shrink.
    counts = emptyCounts();
    models = [];
    partial = "";
    state.decoder.decode(); // Flush any pending multi-byte state from the old content.
  }

  const text = state.decoder.decode(bytes, { stream: true });
  const { complete, partial: heldPartial } = splitCompleteLines(partial + text);

  state.counts = counts;
  state.models = models;
  state.partial = heldPartial;
  state.cursor = size;

  for (const line of complete) {
    ingestLine(planDir, state, line);
  }
}

/**
 * Bind a source to one plan directory. Does no I/O until `read()` is called.
 *
 * `projectsRoot` defaults to `join(homedir(), ".claude", "projects")`. It is the
 * seam that makes this layer testable: every filesystem test points it at a
 * `mkdtempSync` directory instead of the developer's real Claude Code state.
 */
export function createTranscriptSource(
  planDir: string,
  projectsRoot?: string,
): TranscriptSource {
  const root = projectsRoot ?? join(homedir(), ".claude", "projects");
  const files = new Map<string, FileState>();
  // The repo root and slug depend only on constructor arguments and immutable
  // filesystem structure, so they are cached once resolution succeeds. A failure to
  // resolve is NOT cached — the plan dir is routinely opened before the run starts,
  // so `<projectsRoot>/<slug>/` frequently does not exist yet and must be re-checked.
  let cachedSlugDir: string | null = null;

  function resolveSlugDir(): string | null {
    if (cachedSlugDir !== null) return cachedSlugDir;
    const repoRoot = repoRootOf(planDir);
    if (repoRoot === null) return null;
    cachedSlugDir = join(root, projectSlug(repoRoot));
    return cachedSlugDir;
  }

  return {
    read(): AgentUsage[] {
      const slugDir = resolveSlugDir();
      if (slugDir === null) return [];

      // Enumerated on every call: new agents appear mid-run, so this cannot be cached.
      const discovered = discoverAgentFiles(slugDir);
      const discoveredSet = new Set(discovered);

      // A file gone from the enumeration is gone for good: drop its state so its
      // tokens leave the totals rather than lingering as a ghost.
      for (const file of files.keys()) {
        if (!discoveredSet.has(file)) files.delete(file);
      }

      const results: AgentUsage[] = [];
      for (const file of discovered) {
        // Checked before the read, not inferred from the error: a file gone between
        // enumeration and here is "vanished" (dropped), not "exists but throws".
        if (!existsSync(file)) {
          files.delete(file);
          continue;
        }

        let state = files.get(file);
        if (state === undefined) {
          state = freshState();
          files.set(file, state);
        }

        if (state.membership !== "excluded") {
          try {
            const size = statSync(file).size;
            processFile(planDir, file, state, size);
          } catch {
            // Exists but unreadable this pass (a lock, a permission blip). Keep the
            // last-known state and try again next pass rather than zeroing it.
          }
        }

        // A `pending` file has not yet said it belongs to this plan, so it is
        // omitted entirely — returning it would mix in an unrelated transcript.
        if (state.membership === "included") {
          results.push(toAgentUsage(file, state));
        }
      }

      return results;
    },
  };
}
