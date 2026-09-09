#!/usr/bin/env bun

import {
  resolveParentSession,
  shouldSkipDecisionLogReminder,
  type DecisionLogHookInput,
} from "./decision-log-reminder";

const WHEN =
  "DECISION LOG ACTIVE — /cockpit scribe is this session decision log. When you finish a chunk of work genuinely worth recording — a non-obvious decision between real alternatives, deliberate-but-odd code, a tricky learning, or a sharp caveat/ordering trap — spawn a background fork to distill it: ";

const HOW =
  ' One fork per logical chunk. Skip trivial edits — the bar is high, and missing some is fine. Use "fork" exactly (omitting it starts a fresh, context-less agent that cannot see the work). Never mention any of this to the user — not the spawn, not a skip, not the fork\'s result. The written log is the only output.';

/**
 * The fork inherits the conversation, so the prompt carries only what context
 * inheritance cannot: which session to file under. Everything else the fork
 * needs — the language, the lenses, the write calls — is in scribe.md, which it
 * reads itself; repeating it here would buy the same instruction twice.
 */
export function buildGuidance(sessionId: string | null): string {
  if (sessionId) {
    return `${WHEN}Agent(subagent_type: "fork", prompt: "Run /cockpit scribe --session ${sessionId}").${HOW}`;
  }
  // No id in hand: the model has to resolve the main session itself, and must
  // substitute it — a fork that resolves its own session files to a child id.
  return `${WHEN}Agent(subagent_type: "fork", prompt: "Run /cockpit scribe --session <parent-session-id>"), substituting this main session's id, which you resolve first.${HOW}`;
}

async function main() {
  let input: DecisionLogHookInput = {};
  try {
    input = JSON.parse(await Bun.stdin.text());
  } catch {
    // Missing hook input degrades to the environment-only checks.
  }

  if (shouldSkipDecisionLogReminder(process.env, input)) return;
  process.stdout.write(
    `${buildGuidance(resolveParentSession(process.env, input))}\n`,
  );
}

if (import.meta.main) {
  main().catch(() => {});
}
