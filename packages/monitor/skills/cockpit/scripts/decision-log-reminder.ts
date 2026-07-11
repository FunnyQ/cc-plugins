export type DecisionLogHookInput = { agent_id?: string };

export function shouldSkipDecisionLogReminder(
  env: Record<string, string | undefined>,
  input: DecisionLogHookInput,
): boolean {
  return (
    env.RELAY_DELEGATED === "1" ||
    (env.CLAUDE_CODE_ENTRYPOINT ?? "").startsWith("sdk") ||
    Boolean(input.agent_id)
  );
}
