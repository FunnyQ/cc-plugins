// Pure decision layer for the nested-subagent spawn depth setting.
//
// Claude Code 2.1.217 stopped letting subagents spawn nested subagents by
// default, which breaks every Chronicle orchestrator (lawspeaker/storykeeper/
// oathkeeper) — they exist to spawn children. `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`
// re-enables it. Chronicle needs exactly two levels: main → orchestrator → child.

export const ENV_KEY = "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH";
export const REQUIRED_DEPTH = 2;

export type SpawnDepthDecision = {
  action: "ok" | "write" | "unparsable";
  value: number;
  reason: string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decideSpawnDepth(settings: unknown): SpawnDepthDecision {
  if (!isPlainObject(settings)) {
    return {
      action: "unparsable",
      value: REQUIRED_DEPTH,
      reason: "settings.json isn't a JSON object — leaving it untouched.",
    };
  }

  const env = settings.env ?? {};
  if (!isPlainObject(env)) {
    return {
      action: "unparsable",
      value: REQUIRED_DEPTH,
      reason: `settings.json "env" isn't a JSON object — leaving it untouched.`,
    };
  }

  const raw = env[ENV_KEY];
  if (raw === undefined) {
    return {
      action: "write",
      value: REQUIRED_DEPTH,
      reason: `${ENV_KEY} is not set — Chronicle's orchestrators cannot spawn their children.`,
    };
  }

  const current = Number(raw);
  if (!Number.isFinite(current)) {
    return {
      action: "write",
      value: REQUIRED_DEPTH,
      reason: `${ENV_KEY} is ${JSON.stringify(raw)}, which is not a number.`,
    };
  }

  // Only ever raise. A larger value belongs to the user (or another plugin).
  if (current < REQUIRED_DEPTH) {
    return {
      action: "write",
      value: REQUIRED_DEPTH,
      reason: `${ENV_KEY} is ${current}, below the ${REQUIRED_DEPTH} Chronicle needs.`,
    };
  }

  return {
    action: "ok",
    value: current,
    reason: `${ENV_KEY} is ${current} — nested spawning is already enabled.`,
  };
}
