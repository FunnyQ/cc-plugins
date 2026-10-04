import type { EngineInterface } from "claude-code";

// the element table `$.ui.resolve(e)` hands a render hook
export type Ui = ReturnType<EngineInterface["ui"]["resolve"]>;
