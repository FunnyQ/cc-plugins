export type DecisionLogHookInput = {
  agent_id?: string;
  hook_event_name?: string;
  stop_hook_active?: boolean;
};

export function shouldSkipDecisionLogReminder(
  env: Record<string, string | undefined>,
  input: DecisionLogHookInput,
): boolean {
  return (
    env.RELAY_DELEGATED === "1" ||
    (env.CLAUDE_CODE_ENTRYPOINT ?? "").startsWith("sdk") ||
    (input.hook_event_name === "Stop" && input.stop_hook_active === true) ||
    Boolean(input.agent_id)
  );
}
