import { isDelegatedSession } from "./delegation-marker";

export type DecisionLogHookInput = {
  agent_id?: string;
  hook_event_name?: string;
  stop_hook_active?: boolean;
  // Codex marks both required on SessionStart and Stop; Claude sends them too.
  session_id?: string;
  cwd?: string;
};

export type ReminderDeps = {
  isDelegated: typeof isDelegatedSession;
  now: () => number;
};

const defaultDeps: ReminderDeps = {
  isDelegated: isDelegatedSession,
  now: () => Date.now(),
};

export function shouldSkipDecisionLogReminder(
  env: Record<string, string | undefined>,
  input: DecisionLogHookInput,
  deps: ReminderDeps = defaultDeps,
): boolean {
  if (
    env.RELAY_DELEGATED === "1" ||
    (env.CLAUDE_CODE_ENTRYPOINT ?? "").startsWith("sdk") ||
    (input.hook_event_name === "Stop" && input.stop_hook_active === true) ||
    Boolean(input.agent_id)
  ) {
    return true;
  }

  // Codex only. Its interactive TUI runs the session on a shared app-server
  // daemon whose environment froze at daemon start, so the RELAY_DELEGATED
  // check above can never see a var relay set on the pane. The on-disk
  // delegation marker is the signal that crosses that boundary. `PLUGIN_ROOT`
  // is the harness tell: Codex sets it, Claude Code sets only the CLAUDE_
  // prefixed one. Gating on it keeps the marker from ever silencing a Claude
  // session that merely shares a repo with a running delegate.
  if (!env.PLUGIN_ROOT) return false;
  try {
    return deps.isDelegated(env, input.cwd, input.session_id, deps.now());
  } catch {
    return false; // a broken marker store must never silence a real session
  }
}
