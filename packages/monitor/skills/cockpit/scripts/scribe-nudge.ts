#!/usr/bin/env bun
/**
 * scribe-nudge — Stop-hook driver for thoughtful auto-logging.
 *
 * The SessionStart guidance is one-shot: injected at the top of the conversation
 * and steadily buried as the session grows, so agents rarely act on it. This hook
 * re-surfaces the reminder at the natural "a chunk of work just completed"
 * boundary (end of every turn) via the Stop hook's `additionalContext` — which
 * Claude Code injects non-intrusively on the next model call (no `decision: block`,
 * so the agent is never forced to continue).
 *
 * It is gated to stay high-signal, NOT naggy:
 *   1. Only nudges when code actually changed since the last nudge (git signature).
 *   2. Throttled — no second nudge within the throttle window.
 *   3. One nudge per distinct code-state: if the agent ignores it and makes no new
 *      edits, the signature is unchanged so it stays quiet ("missing some is fine").
 *
 * When the change looks structural (many files / many lines), the reminder also
 * emphasizes attaching a Mermaid `--diagram` so the shape of the change is legible
 * at a glance.
 *
 * Stop hooks must emit JSON to influence the model — plain stdout does NOT reach
 * the context (unlike SessionStart). We print `{ hookSpecificOutput: { ... } }`.
 */

import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { cockpitHome } from "./cockpit-home";
import { nudgeEnabledFor } from "./nudge-toggle";

// ── Tunables ────────────────────────────────────────────────────────────────
const THROTTLE_MS = Number(process.env.COCKPIT_NUDGE_THROTTLE_MS) || 8 * 60_000;
const MARKER_TTL_MS = 24 * 60 * 60_000; // prune session entries older than this
// "Structural" thresholds — either trips the diagram emphasis.
const STRUCTURAL_FILES = 3;
const STRUCTURAL_LINES = 80;

const COCKPIT_HOME = cockpitHome();
const MARKER_PATH = join(COCKPIT_HOME, "scribe-nudge.json");

// ── Pure core (unit-tested) ──────────────────────────────────────────────────

export type Complexity = { files: number; lines: number; structural: boolean };

/**
 * Parse `git diff --numstat` (tracked changes) plus `git status --porcelain`
 * (to fold in brand-new untracked files, which `git diff HEAD` omits entirely —
 * adding new modules is exactly the structural case) into a complexity verdict.
 */
export function assessComplexity(numstat: string, porcelain = ""): Complexity {
  let files = 0;
  let lines = 0;
  for (const raw of numstat.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const [added, deleted] = line.split(/\s+/);
    files++;
    // Binary files report "-" for added/deleted — count them as a touched file
    // but contribute no line delta.
    const a = added === "-" ? 0 : Number(added) || 0;
    const d = deleted === "-" ? 0 : Number(deleted) || 0;
    lines += a + d;
  }
  // Untracked entries ("?? path") aren't in `git diff HEAD`; count each as a
  // touched file. Their line counts stay unknown (no cheap diff), but adding
  // files alone is enough to trip the structural threshold.
  for (const raw of porcelain.split("\n")) {
    if (raw.startsWith("??")) files++;
  }
  return {
    files,
    lines,
    structural: files >= STRUCTURAL_FILES || lines >= STRUCTURAL_LINES,
  };
}

/**
 * Decide whether to nudge this turn. Nudge only when code changed since the last
 * nudge (signature differs) AND the throttle window has elapsed.
 */
export function decideNudge(opts: {
  now: number;
  currentSig: string;
  lastSig: string | null;
  lastNudgeMs: number | null;
  throttleMs?: number;
}): boolean {
  const { now, currentSig, lastSig, lastNudgeMs } = opts;
  const throttleMs = opts.throttleMs ?? THROTTLE_MS;
  if (!currentSig) return false; // no detectable code change
  if (currentSig === lastSig) return false; // already nudged for this exact state
  if (lastNudgeMs != null && now - lastNudgeMs < throttleMs) return false;
  return true;
}

/**
 * Build the `additionalContext` reminder injected back into the model. Kept
 * deliberately terse — the full how-to (the fork mechanics + policy) is taught
 * once by the SessionStart hook, so this is a light poke, not a repeated manual.
 * Two tiers by change size control only the tone; both are diagram-first.
 */
export function buildReminder(c: Complexity): string {
  if (c.structural) {
    return (
      `📐 Sizable change (${c.files} files, ~${c.lines} lines). If it hid a real ` +
      'decision/learning/caveat, spawn a fork (subagent_type:"fork") to run ' +
      "/cockpit scribe — draw it with a Mermaid `--diagram` first (flow / sequence " +
      "/ state / fan-out), prose only for what a picture can't carry."
    );
  }
  return (
    "💭 If that change hid a real decision/learning/caveat, spawn a fork " +
    '(subagent_type:"fork") to run /cockpit scribe — prefer a Mermaid `--diagram` ' +
    "if it has any shape, else a terse note. Otherwise skip."
  );
}

// ── Marker store ─────────────────────────────────────────────────────────────

type MarkerEntry = { lastNudgeMs: number; lastSig: string };
type Marker = Record<string, MarkerEntry>;

function readMarker(): Marker {
  try {
    return JSON.parse(readFileSync(MARKER_PATH, "utf8")) as Marker;
  } catch {
    return {};
  }
}

function writeMarker(marker: Marker, now: number): void {
  // Prune stale session entries to keep the file bounded.
  for (const [key, entry] of Object.entries(marker)) {
    if (now - entry.lastNudgeMs > MARKER_TTL_MS) delete marker[key];
  }
  try {
    mkdirSync(COCKPIT_HOME, { recursive: true });
    writeFileSync(MARKER_PATH, JSON.stringify(marker));
  } catch {
    /* best-effort — a write failure must never break the agent's turn */
  }
}

// ── Git probes (I/O) ─────────────────────────────────────────────────────────

function git(cwd: string, args: string[]): string | null {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) return null;
  return r.stdout ?? "";
}

/** A signature that changes whenever the tracked code-state changes. */
function codeSignature(
  cwd: string,
): { sig: string; numstat: string; porcelain: string } | null {
  // `git diff HEAD` covers staged + unstaged vs HEAD; numstat gives per-file
  // line counts so re-editing an already-modified file still moves the signature.
  const head = git(cwd, ["rev-parse", "HEAD"]);
  if (head == null) return null; // not a git repo (or no commits) — can't gate
  const numstat = git(cwd, ["diff", "HEAD", "--numstat"]) ?? "";
  const porcelain = git(cwd, ["status", "--porcelain"]) ?? "";
  const hasher = new Bun.CryptoHasher("sha1");
  hasher.update(head + " " + numstat + " " + porcelain);
  return { sig: hasher.digest("hex"), numstat, porcelain };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Headless / SDK runs (`claude -p`, relay delegate/review, SDK apps) have no
  // interactive cockpit and no human to act on a scribe nudge — bail. Interactive
  // TUI sets CLAUDE_CODE_ENTRYPOINT=cli; headless sets sdk-cli (SDK apps: sdk-*).
  if ((process.env.CLAUDE_CODE_ENTRYPOINT ?? "").startsWith("sdk")) return;

  let input: { session_id?: string; cwd?: string } = {};
  try {
    input = JSON.parse(await Bun.stdin.text());
  } catch {
    return; // no/garbled stdin — nothing to do
  }

  const cwd = input.cwd || process.cwd();

  // Multi-scope opt-out, flipped via `cockpit nudge` (session / project / user).
  // Most-specific defined scope wins; all-unset stays enabled.
  if (!nudgeEnabledFor(input.session_id, cwd, Date.now())) return;

  const probe = codeSignature(cwd);
  if (!probe) return; // not a git repo, or no detectable change basis

  const key = input.session_id || cwd;
  const now = Date.now();
  const marker = readMarker();
  const prev = marker[key] ?? null;

  const shouldNudge = decideNudge({
    now,
    currentSig: probe.sig,
    lastSig: prev?.lastSig ?? null,
    lastNudgeMs: prev?.lastNudgeMs ?? null,
  });
  if (!shouldNudge) return;

  const reminder = buildReminder(
    assessComplexity(probe.numstat, probe.porcelain),
  );
  marker[key] = { lastNudgeMs: now, lastSig: probe.sig };
  writeMarker(marker, now);

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "Stop",
        additionalContext: reminder,
      },
    }),
  );
}

if (import.meta.main) {
  // Never let an error here break the agent's turn.
  main().catch(() => {});
}
