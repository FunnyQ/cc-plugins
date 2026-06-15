import type { Backend } from "../types";
import { claudeBackend } from "./claude";
import { codexBackend } from "./codex";
import { opencodeBackend } from "./opencode";

export const BACKENDS: Record<string, Backend> = {
  codex: codexBackend,
  opencode: opencodeBackend,
  claude: claudeBackend,
};
