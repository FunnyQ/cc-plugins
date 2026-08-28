import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { nextCursor, readRange, splitCompleteLines } from "./tail";
import {
  emptyCounts,
  replaceCounts,
  type AgentUsage,
  type TokenCounts,
} from "./usage-types";

export type TranscriptSource = {
  /**
   * Re-scan and return the current state of every discovered agent.
   * Cheap to call repeatedly: only bytes appended since the last call are read.
   */
  read(): AgentUsage[];
};

/**
 * Claude Code names a project directory after the session's absolute cwd with every
 * non-alphanumeric character replaced by `-`. Uppercase survives and a leading `/`
 * produces a leading `-`; a rule that trims or collapses dashes finds nothing on disk.
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

// A literal array, not a record walked with `Object.entries`: `addUsage` runs once per
// assistant line, so the entries array would be rebuilt on every line of every transcript.
const WIRE_KEYS: [string, keyof TokenCounts][] = [
  ["input_tokens", "input"],
  ["output_tokens", "output"],
  ["cache_read_input_tokens", "cacheRead"],
  ["cache_creation_input_tokens", "cacheWrite"],
];

/**
 * Sum only the four named counters: a blind reduce would crash or invent tokens on a
 * field a future version adds. A negative drives a total below zero, which the display
 * formatter renders as `N/A` — corruption disguised as "no data".
 */
export function addUsage(into: TokenCounts, raw: unknown): void {
  if (typeof raw !== "object" || raw === null) return;
  const record = raw as Record<string, unknown>;
  for (const [wireKey, field] of WIRE_KEYS) {
    const value = record[wireKey];
    if (
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0
    ) {
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
  /** Last-seen usage per billed request, the subtrahend `applyUsage` swaps out. */
  byRequest: Map<string, TokenCounts>;
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
    byRequest: new Map(),
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

/**
 * Workflow agents live at `<slug>/<sessionId>/subagents/workflows/wf_<runId>/agent-*.jsonl`,
 * never directly under `subagents/` — that path holds plain Agent() subagents and returns
 * zero files for a Workflow run (see ../_context/data-model.md).
 *
 * The enumeration is its own existence check: `readdir` on a missing path, or on one of
 * the `<sessionId>.jsonl` files sitting beside the session directories, throws and
 * `listNames` returns `[]`. A preceding `stat` would ask the kernel the same question twice.
 */
function discoverAgentFiles(slugDir: string): string[] {
  const found: string[] = [];
  for (const sessionId of listNames(slugDir)) {
    const workflowsDir = join(slugDir, sessionId, "subagents", "workflows");
    for (const wf of listNames(workflowsDir)) {
      if (!wf.startsWith("wf_")) continue;
      const wfDir = join(workflowsDir, wf);
      for (const name of listNames(wfDir)) {
        if (!name.startsWith("agent-") || !name.endsWith(".jsonl")) continue;
        found.push(join(wfDir, name));
      }
    }
  }
  return found;
}

/**
 * Whether `text` names a path at or under `planDir`. A bare `includes` is not enough:
 * `docs/foo` would claim every transcript of the sibling `docs/foo-bar` and absorb its
 * tokens, so the character after the match must end the path or separate the next segment.
 */
function mentionsPlanDir(text: string, planDir: string): boolean {
  let from = 0;
  for (;;) {
    const at = text.indexOf(planDir, from);
    if (at === -1) return false;
    const next = text[at + planDir.length];
    if (next === undefined || next === sep || next === "/") return true;
    from = at + 1;
  }
}

/**
 * Decide membership from the file's first complete line. Both prompt shapes embed
 * the plan's absolute directory path, so the file belongs to this plan when the
 * stringified `message.content` names a path under it. Permanent once decided either way.
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

  if (!mentionsPlanDir(contentText(content), planDir)) {
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

/**
 * Identify the billed request a line belongs to. `requestId:message.id` names it;
 * the entry uuid, then a per-line counter, keep unkeyed lines from collapsing onto
 * one another — that would drop every line but the last.
 */
function requestKey(
  record: Record<string, unknown>,
  message: Record<string, unknown>,
  state: FileState,
): string {
  const requestId = record.requestId;
  const messageId = message.id;
  if (typeof requestId === "string" && typeof messageId === "string") {
    return `${requestId}:${messageId}`;
  }
  return typeof record.uuid === "string"
    ? record.uuid
    : `#${state.byRequest.size}`;
}

/**
 * Fold one assistant line's usage into the running total.
 *
 * Claude Code writes a line per streamed block (thinking, text, tool_use), each
 * carrying a progressively completed copy of the SAME request's usage — summing them
 * double-bills. Measured over 842 real workflow transcripts: 88% of requests repeat
 * and a plain sum overcounts cache reads 2.05x. `output_tokens` never decreased across
 * a request's snapshots, so the last snapshot is the complete one and replaces its
 * predecessor rather than adding to it.
 */
function applyUsage(
  state: FileState,
  record: Record<string, unknown>,
  message: Record<string, unknown>,
): void {
  const next = emptyCounts();
  addUsage(next, message.usage);

  const key = requestKey(record, message, state);
  const previous = state.byRequest.get(key);
  replaceCounts(state.counts, previous ?? emptyCounts(), next);
  state.byRequest.set(key, next);
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
    applyUsage(state, record, message);
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

  if (next.reset) {
    // A reset re-reads from byte 0, so nothing derived from the old content may
    // survive it: the counts would double, and identity — read off the first line —
    // would file a reused path's tokens under whatever agent used to live there.
    state.counts = emptyCounts();
    state.byRequest.clear();
    state.models = [];
    state.partial = "";
    state.decoder.decode(); // Flush pending multi-byte state from the old content.
    state.task = null;
    state.role = null;
    state.attempt = undefined;
    state.startedAt = null;
    state.membership = "pending";
  }

  const text = state.decoder.decode(bytes, { stream: true });
  const { complete, partial } = splitCompleteLines(state.partial + text);
  state.partial = partial;
  state.cursor = size;

  for (const line of complete) {
    ingestLine(planDir, state, line);
  }
}

/**
 * Bind a source to one plan directory. Does no I/O until `read()` is called.
 * `projectsRoot` is the seam that makes this layer testable: a test points it at a
 * temp directory instead of the developer's real Claude Code state.
 */
export function createTranscriptSource(
  planDir: string,
  projectsRoot?: string,
): TranscriptSource {
  const root = projectsRoot ?? join(homedir(), ".claude", "projects");
  const files = new Map<string, FileState>();
  // A failure to resolve is deliberately NOT cached: the plan dir is routinely opened
  // before the run starts, so `<projectsRoot>/<slug>/` often does not exist yet.
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
        let state = files.get(file);
        if (state === undefined) {
          state = freshState();
          files.set(file, state);
        }

        if (state.membership !== "excluded") {
          try {
            const size = statSync(file).size;
            processFile(planDir, file, state, size);
          } catch (error) {
            // Told apart by errno, not a preceding `existsSync` — that would stat
            // every file twice on every pass to learn what this stat already reports.
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              // Vanished between enumeration and here: drop it, do not report it.
              files.delete(file);
              continue;
            }
            // Unreadable this pass (a lock, a permission blip): keep the last-known
            // state and retry next pass rather than zeroing it.
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
