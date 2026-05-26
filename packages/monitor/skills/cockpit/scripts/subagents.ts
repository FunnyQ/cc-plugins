// Count a Claude session's in-flight subagent delegations.
//
// Why not the parent transcript: a *background* Agent gets an immediate
// synthetic "Async agent launched" tool_result at spawn (51ms after the
// tool_use), and its real completion is never written back as a matching
// tool_result — so a launch/result pairing always reads as closed and misses
// every background agent. The reliable signal is each delegation's own sidechain
// transcript: `<session-dir>/subagents/agent-<id>.jsonl`. A delegation is DONE
// when that file's last conversation entry is an assistant turn that stopped on
// `end_turn` (its final answer); until then it's still running.
//
// Claude-only: Codex has no Agent/Task tool, so its count is always 0.
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { resolveClaudeTranscriptPath } from "./transcript-stream";

// A crashed/abandoned agent can leave a sidechain that never reaches end_turn;
// without a ceiling it would read "running" forever. Past this since its last
// write, treat it as finished regardless. Matches the 10-min liveness window the
// rest of cockpit uses for staleness.
const SUBAGENT_STALE_MS = 10 * 60 * 1000;

// Bounded tail read — a sidechain's terminal entry is its last line, so we only
// need the end of the file, not a multi-MB history every poll.
const TAIL_BYTES = 64 * 1024;

type ContentBlock = { type?: string };

type SidechainEntry = {
  type?: string;
  message?: { stop_reason?: string | null; content?: ContentBlock[] };
  data?: { hookEvent?: string };
};

// A `progress` entry that records the SubagentStop hook firing — the most
// authoritative completion marker, written when the subagent actually stops.
// (Nested under `data.hookEvent`, not the entry's top level.) Only present when
// the user has a SubagentStop hook configured, so it's a strong DONE signal when
// seen, never a RUNNING signal by its absence.
function isSubagentStop(entry: SidechainEntry): boolean {
  return entry.type === "progress" && entry.data?.hookEvent === "SubagentStop";
}

// An assistant turn is terminal (nothing follows) UNLESS it's waiting on a tool.
// Framed as a denylist, not an allowlist of stop reasons: a turn that called a
// tool (stop_reason "tool_use", or a `tool_use` content block) has a result
// coming, so it's still running. Every other ending — "end_turn", null,
// "stop_sequence", "max_tokens", … (all seen in real transcripts, varying by
// version) — means the turn finished, so the agent is done. This is what keeps a
// null- or stop_sequence-stopped final answer from being misread as running.
function assistantIsTerminal(entry: SidechainEntry): boolean {
  if (entry.message?.stop_reason === "tool_use") return false;
  const content = entry.message?.content;
  if (Array.isArray(content) && content.some((b) => b?.type === "tool_use")) {
    return false;
  }
  return true;
}

// True when a sidechain shows the agent has finished. Scans from the end:
//   - a SubagentStop hook_progress → done (authoritative, sits at the very tail);
//   - the last conversation turn: a terminal assistant answer → done, a user
//     turn (awaiting the next assistant) → running.
// Other bookkeeping (fork-context-ref, attachment, non-stop progress, …) is
// skipped. An empty/unreadable sidechain is NOT done — a just-spawned agent
// shouldn't vanish. The SubagentStop check is what fixes version variants whose
// final assistant stops on null rather than end_turn.
export function sidechainIsDone(lines: string[]): boolean {
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    let entry: SidechainEntry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (isSubagentStop(entry)) return true;
    if (entry.type === "assistant") return assistantIsTerminal(entry);
    if (entry.type === "user") return false; // awaiting the next assistant turn
  }
  return false;
}

// Read the last TAIL_BYTES of a file as complete lines (drop the first, likely
// partial, line when we began mid-file). [] on any error.
function readTailLines(filePath: string): string[] {
  try {
    const size = statSync(filePath).size;
    if (size === 0) return [];
    const start = Math.max(0, size - TAIL_BYTES);
    const length = size - start;
    const buf = Buffer.allocUnsafe(length);
    const fd = openSync(filePath, "r");
    try {
      readSync(fd, buf, 0, length, start);
    } finally {
      closeSync(fd);
    }
    let text = buf.toString("utf-8");
    if (start > 0) {
      const nl = text.indexOf("\n");
      text = nl >= 0 ? text.slice(nl + 1) : "";
    }
    return text.split("\n");
  } catch {
    return [];
  }
}

// The subagents dir sits beside the transcript: `<projects>/<enc>/<id>.jsonl`
// pairs with `<projects>/<enc>/<id>/subagents/`. Returns undefined when the
// session has no resolvable transcript (so no delegations either).
function subagentsDirFor(sessionId: string): string | undefined {
  const tx = resolveClaudeTranscriptPath(sessionId);
  if (!tx || !tx.endsWith(".jsonl")) return undefined;
  return join(tx.slice(0, -".jsonl".length), "subagents");
}

// Running-delegation count for a Claude session: each `agent-*.jsonl` that
// hasn't reached `end_turn` and was written within the staleness window.
export function subagentCountForClaude(
  sessionId: string,
  now = Date.now(),
): number {
  const dir = subagentsDirFor(sessionId);
  if (!dir || !existsSync(dir)) return 0;
  let running = 0;
  for (const f of readdirSync(dir)) {
    if (!f.startsWith("agent-") || !f.endsWith(".jsonl")) continue;
    const path = join(dir, f);
    try {
      if (now - statSync(path).mtimeMs > SUBAGENT_STALE_MS) continue;
    } catch {
      continue;
    }
    if (!sidechainIsDone(readTailLines(path))) running++;
  }
  return running;
}
