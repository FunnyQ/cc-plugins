// Codex token usage, folded into the agent that drove it.
//
// With `CFG.devEngine: 'codex'` the dev step is a cheap Haiku *driver* that shells out
// to the codex CLI. Only the driver leaves a Claude transcript, so flightdeck used to
// report the driver's own spend as if it were the dev step's — the codex side landed in
// ~/.codex/ and was counted nowhere. This module reads that side and adds it back.
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { fleetIdentity } from "./fleet";
import { nextCursor, readRange, splitCompleteLines } from "./tail";
import { addCounts, emptyCounts, type AgentUsage } from "./usage-types";

/** One codex CLI run, distilled from its rollout file. */
export type CodexRun = {
  /** Absolute path of the rollout. The stable identity across passes. */
  file: string;
  /** Working directory codex was launched in. Null when the meta line is missing. */
  cwd: string | null;
  /** ISO timestamp of the rollout's first line. Null when the file is empty. */
  startedAt: string | null;
  /**
   * Relay scratch directory this run was driven from, when relay drove it. The
   * delegation prompt arrives as `Read the file /tmp/relay/<dir>/live-prompt.md`,
   * and the driver's own transcript names the same directory.
   */
  relayDir: string | null;
  /**
   * Who launched codex: `codex_exec` for a headless `codex exec`, `codex-tui` for an
   * interactive session. The discriminator the time-window join leans on — see
   * `attachCodexUsage`. Null when the meta line is missing.
   */
  originator: string | null;
  counts: ReturnType<typeof emptyCounts>;
};

export type CodexSource = { read(): CodexRun[] };

const RELAY_DIR = /\/relay\/(\d{8}-\d{6}-\d+-\d+-[0-9a-f]+)/;

/**
 * Map codex's counters onto the four this dashboard already carries.
 *
 * Codex reports a *cumulative* snapshot per turn, and its fields overlap in ways a
 * naive copy would double-count. Verified over 166 rollouts carrying usage:
 *   - `input_tokens + output_tokens === total_tokens`, always;
 *   - `cached_input_tokens` is a SUBSET of `input_tokens`, never an addition to it;
 *   - `reasoning_output_tokens` is a subset of `output_tokens`, so it needs no field
 *     of its own — adding one would count reasoning twice;
 *   - `cache_write_input_tokens` was 0 in all 771 rollouts on disk, so whether it sits
 *     inside `input_tokens` is unobservable. `input` is therefore derived by
 *     subtraction rather than copied, which conserves the total whichever it turns out
 *     to be.
 *
 * `cacheWrite` carries the fresh (non-cached) prompt tokens because that is the field
 * the panel prints, and fresh prompt content is what Claude bills as cache creation —
 * see `freshTokens` in dashboard/dist/modules/format.js. `input` stays 0: codex has no
 * counter separate from the prompt total, and inventing a split would inflate the sum.
 */
export function mapCodexUsage(raw: unknown): ReturnType<typeof emptyCounts> {
  const counts = emptyCounts();
  if (typeof raw !== "object" || raw === null) return counts;
  const record = raw as Record<string, unknown>;

  const read = (key: string): number => {
    const value = record[key];
    return typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0
      ? value
      : 0;
  };

  const total = read("total_tokens");
  const output = read("output_tokens");
  const cached = read("cached_input_tokens");
  const cacheWrite = read("cache_write_input_tokens");

  counts.output = output;
  counts.cacheRead = cached;
  // Never negative: a rollout mid-write can carry a total that trails its parts, and a
  // negative drives the row's figure below zero, which the formatter renders as N/A —
  // corruption disguised as "no data".
  counts.cacheWrite = Math.max(0, total - output - cached - cacheWrite);
  return counts;
}

type FileState = {
  cursor: number;
  partial: string;
  decoder: TextDecoder;
  cwd: string | null;
  startedAt: string | null;
  relayDir: string | null;
  originator: string | null;
  counts: ReturnType<typeof emptyCounts>;
};

function freshState(): FileState {
  return {
    cursor: 0,
    partial: "",
    decoder: new TextDecoder(),
    cwd: null,
    startedAt: null,
    relayDir: null,
    originator: null,
    counts: emptyCounts(),
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
 * Rollouts live at `<sessionsRoot>/YYYY/MM/DD/rollout-*.jsonl`. The three levels are
 * walked rather than globbed so a stray file at any level is skipped by the same
 * `listNames` that returns [] for a missing directory — one enumeration, no stat.
 */
export function discoverRollouts(sessionsRoot: string): string[] {
  const found: string[] = [];
  for (const year of listNames(sessionsRoot)) {
    for (const month of listNames(join(sessionsRoot, year))) {
      const monthDir = join(sessionsRoot, year, month);
      for (const day of listNames(monthDir)) {
        for (const name of listNames(join(monthDir, day))) {
          if (!name.startsWith("rollout-") || !name.endsWith(".jsonl"))
            continue;
          found.push(join(monthDir, day, name));
        }
      }
    }
  }
  return found;
}

function ingestLine(state: FileState, rawLine: string): void {
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
  const payload =
    typeof record.payload === "object" && record.payload !== null
      ? (record.payload as Record<string, unknown>)
      : undefined;

  if (state.startedAt === null && typeof record.timestamp === "string") {
    state.startedAt = record.timestamp;
  }

  if (record.type === "session_meta" && payload) {
    if (typeof payload.cwd === "string") state.cwd = payload.cwd;
    if (typeof payload.originator === "string") {
      state.originator = payload.originator;
    }
    return;
  }

  // The delegation prompt is a plain user message, so the relay path is matched on the
  // raw line — cheaper than reaching into the content-block array to find it.
  if (state.relayDir === null && line.includes("/relay/")) {
    const match = RELAY_DIR.exec(line);
    if (match) state.relayDir = match[1]!;
  }

  // Cumulative, not incremental: every token_count line restates the run's whole spend,
  // so the last one wins outright. Adding them would multiply the run by its turn count.
  if (record.type === "event_msg" && payload?.type === "token_count") {
    const info =
      typeof payload.info === "object" && payload.info !== null
        ? (payload.info as Record<string, unknown>)
        : undefined;
    if (info) state.counts = mapCodexUsage(info.total_token_usage);
  }
}

function processFile(file: string, state: FileState, size: number): void {
  const next = nextCursor(state.cursor, size);
  const from = next.reset ? 0 : next.from;
  if (size <= from) return; // Nothing new since the last pass.

  const bytes = readRange(file, from, size);

  if (next.reset) {
    // A reset re-reads from byte 0, so nothing derived from the old content may
    // survive it — identity included, or a reused path files its tokens under
    // whatever run used to live there.
    state.partial = "";
    state.decoder.decode();
    state.cwd = null;
    state.startedAt = null;
    state.relayDir = null;
    state.originator = null;
    state.counts = emptyCounts();
  }

  const text = state.decoder.decode(bytes, { stream: true });
  const { complete, partial } = splitCompleteLines(state.partial + text);
  state.partial = partial;
  state.cursor = size;

  for (const line of complete) ingestLine(state, line);
}

/**
 * Bind a source to the codex sessions tree. Does no I/O until `read()` is called.
 * `sessionsRoot` is the seam that makes this testable against a temp directory
 * instead of the developer's real codex state.
 */
export function createCodexSource(sessionsRoot?: string): CodexSource {
  const root = sessionsRoot ?? join(homedir(), ".codex", "sessions");
  const files = new Map<string, FileState>();

  return {
    read(): CodexRun[] {
      // Enumerated every call: a delegation starts mid-run and writes a new rollout.
      const discovered = discoverRollouts(root);
      const discoveredSet = new Set(discovered);
      for (const file of files.keys()) {
        if (!discoveredSet.has(file)) files.delete(file);
      }

      const results: CodexRun[] = [];
      for (const file of discovered) {
        let state = files.get(file);
        if (state === undefined) {
          state = freshState();
          files.set(file, state);
        }

        try {
          processFile(file, state, statSync(file).size);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            files.delete(file);
            continue;
          }
          // Unreadable this pass: keep the last-known state rather than zeroing it.
        }

        results.push({
          file,
          cwd: state.cwd,
          startedAt: state.startedAt,
          relayDir: state.relayDir,
          originator: state.originator,
          counts: { ...state.counts },
        });
      }
      return results;
    },
  };
}

/** Epoch ms, or null when unparseable — never NaN/0, which would read as 1970. */
function toEpochMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Whether the flightlog still reports this agent's row running. An agent whose opening
 * prompt named no task or role has no fleet identity at all, so it can never be one of
 * the open rows and keeps the ordinary window.
 */
function isOpen(
  agent: AgentUsage,
  openIdentities: ReadonlySet<string> | undefined,
): boolean {
  if (openIdentities === undefined) return false;
  if (agent.task === null || agent.role === null) return false;
  return openIdentities.has(
    fleetIdentity(agent.task, agent.role, agent.attempt),
  );
}

/** Whether `cwd` is at or under `root`, on a segment boundary. */
function insideRepo(cwd: string | null, root: string): boolean {
  if (cwd === null) return false;
  if (cwd === root) return true;
  return cwd.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Attach each codex run's spend to the agent that drove it, returning new agent objects.
 *
 * Attached, never added: `counts` stays the driver's own Claude spend and `codexCounts`
 * carries the external model's, so the panel can print the two side by side. Merging
 * them would make a 40K Haiku driver and a 210K codex run indistinguishable from one
 * 250K Claude agent.
 *
 * Two joins, strongest first:
 *
 *  1. **Relay directory.** A live-pane delegation names `/tmp/relay/<dir>/live-prompt.md`
 *     in the codex rollout, and the driver's own transcript names `<dir>` in the command
 *     that created it. That is an exact string match on a per-delegation identifier —
 *     no guessing, and it survives parallel waves.
 *  2. **Repo and time window.** The headless path pipes the prompt on stdin, so no
 *     shared identifier reaches the rollout. It falls back to: cwd under the repo root,
 *     and a start inside some driver's [startedAt, lastAt]. Nearest start wins, one
 *     driver per run, so two concurrent delegations cannot both claim one rollout.
 *
 * A run matching neither is dropped rather than spread across the plan: codex sessions
 * the user started by hand share the repo, and folding those in would silently inflate
 * whichever task happened to be running.
 *
 * `openIdentities` carries the fleet identities the flightlog still reports in flight,
 * and it exists because a driver waiting on the codex CLI writes nothing while it
 * waits: its `lastAt` is the moment it shelled out, which is *before* the rollout it is
 * waiting on even opens. Closing the window there hid every live delegation until its
 * driver returned — and with several drivers in flight, only the one still writing (a
 * relay live pane it polls) showed a figure. For an open identity the window has no
 * end; the moment the driver finishes, `lastAt` and the relay directory both land and
 * the ordinary joins take over.
 */
export function attachCodexUsage(
  agents: AgentUsage[],
  runs: CodexRun[],
  repoRoot: string,
  options?: { openIdentities?: ReadonlySet<string> },
): AgentUsage[] {
  const folded = agents.map((agent) => ({
    ...agent,
    counts: { ...agent.counts },
  }));

  // One driver can make several delegations — relay's collect loop reattaches to the
  // same pane, and a pane that restarts writes a second rollout. Accumulate rather
  // than assign, or only the last one counts.
  const attach = (agent: (typeof folded)[number], run: CodexRun): void => {
    const into = (agent.codexCounts ??= emptyCounts());
    addCounts(into, run.counts);
  };

  const byRelayDir = new Map<string, (typeof folded)[number]>();
  for (const agent of folded) {
    for (const dir of agent.relayDirs) {
      // First writer wins: a directory named by two agents is ambiguous, and the
      // driver that created it is the one that logged it first.
      if (!byRelayDir.has(dir)) byRelayDir.set(dir, agent);
    }
  }

  const claimed = new Set<(typeof folded)[number]>();
  const unjoined: CodexRun[] = [];

  for (const run of runs) {
    const exact =
      run.relayDir === null ? undefined : byRelayDir.get(run.relayDir);
    if (exact) {
      attach(exact, run);
      claimed.add(exact);
      continue;
    }
    unjoined.push(run);
  }

  for (const run of unjoined) {
    if (!insideRepo(run.cwd, repoRoot)) continue;
    const runMs = toEpochMs(run.startedAt);
    if (runMs === null) continue;

    let best: (typeof folded)[number] | undefined;
    let bestDistance = Infinity;
    for (const agent of folded) {
      // Only an agent that actually shelled out to an external CLI may claim a run
      // this way. Both originators count — a relay live pane is `codex-tui` and a
      // headless delegation is `codex_exec` — but so is the user's own codex window,
      // and without this gate a judge running beside it absorbs its whole spend.
      // Observed: judge:foundation/02#1 picked up 30,039 fresh tokens from a session
      // it never launched.
      if (!agent.externalDriver) continue;
      // An agent already paired by relay directory drove that run, not this one.
      if (claimed.has(agent)) continue;
      const startMs = toEpochMs(agent.startedAt);
      if (startMs === null || runMs < startMs) continue;
      if (!isOpen(agent, options?.openIdentities)) {
        const endMs = toEpochMs(agent.lastAt);
        if (endMs === null || runMs > endMs) continue;
      }
      const distance = runMs - startMs;
      // Ties break on file path so the pairing is deterministic across calls.
      if (
        distance < bestDistance ||
        (distance === bestDistance &&
          best !== undefined &&
          agent.file < best.file)
      ) {
        best = agent;
        bestDistance = distance;
      }
    }

    if (best) {
      attach(best, run);
      claimed.add(best);
    }
  }

  return folded;
}
