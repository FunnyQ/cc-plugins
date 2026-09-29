#!/usr/bin/env bun

import {
  isClaudeCode,
  resolveParentSession,
  shouldSkipDecisionLogReminder,
  type DecisionLogHookInput,
} from "./decision-log-reminder";

const WHEN =
  "DECISION LOG ACTIVE — /cockpit scribe is this session decision log. When you finish a chunk of work genuinely worth recording — a non-obvious decision between real alternatives, deliberate-but-odd code, a tricky learning, or a sharp caveat/ordering trap — spawn a background fork to distill it: ";

const POLICY =
  " One fork per logical chunk. Skip trivial edits — the bar is high, and missing some is fine.";
const FORK_NAME =
  ' Use "fork" exactly (omitting it starts a fresh, context-less agent that cannot see the work).';
const SILENCE =
  " Never mention any of this to the user — not the spawn, not a skip, not the fork's result. The written log is the only output.";

/**
 * The fork inherits the conversation, so the prompt carries only what context
 * inheritance cannot: which session to file under. Everything else the fork
 * needs — the language, the lenses, the write calls — is in scribe.md, which it
 * reads itself; repeating it here would buy the same instruction twice.
 */
export function buildGuidance(
  sessionId: string | null,
  isCodex = false,
): string {
  const spawn = (scribe: string) =>
    isCodex
      ? `a background sub-agent with fork_context: true and no agent_type, prompt: "You are running under Codex. Run ${scribe} --provider codex"`
      : `Agent(subagent_type: "fork", prompt: "Run ${scribe}")`;
  const how = isCodex ? POLICY + SILENCE : POLICY + FORK_NAME + SILENCE;
  if (sessionId) {
    return `${WHEN}${spawn(`/cockpit scribe --session ${sessionId}`)}.${how}`;
  }
  // No id in hand: the model has to resolve the main session itself, and must
  // substitute it — a fork that resolves its own session files to a child id.
  return `${WHEN}${spawn("/cockpit scribe --session <parent-session-id>")}, substituting this main session's id, which you resolve first.${how}`;
}

async function main() {
  let input: DecisionLogHookInput = {};
  try {
    input = JSON.parse(await Bun.stdin.text());
  } catch {
    // Missing hook input degrades to the environment-only checks.
  }

  if (shouldSkipDecisionLogReminder(process.env, input)) return;
  // scribe-nudge launches the scribe itself here; guidance would double it.
  if (isClaudeCode(process.env, input) && Bun.which("claude")) return;
  process.stdout.write(
    `${buildGuidance(resolveParentSession(process.env, input), Boolean(process.env.PLUGIN_ROOT))}\n`,
  );
}

if (import.meta.main) {
  main().catch(() => {});
}
