import type { EngineInterface } from "claude-code";

export type Ui = ReturnType<EngineInterface["ui"]["resolve"]>;
