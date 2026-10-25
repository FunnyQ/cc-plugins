import { atom } from "claude-code";
import type { ModelUsage } from "claude-code";
import type { ExplainEntry, ExplainUsage, ExplainView } from "../../types";

export const MAX_ENTRIES = 12; // the pane draws every entry, so this is also the history list's height
export const view = atom(
  { plugin: "runes", key: "explain" } as const,
  { entries: [], isRunning: false } as ExplainView,
);
export const usageOf = (u: ModelUsage): ExplainUsage => ({
  input: u.input_tokens + u.cache_creation_input_tokens,
  cacheRead: u.cache_read_input_tokens,
  output: u.output_tokens,
});
export const selectedOf = (v: ExplainView): ExplainEntry | undefined =>
  v.entries.find((e) => e.id === v.selected) ?? v.entries[0];
export const withEntry = (
  v: ExplainView,
  entry: ExplainEntry,
): ExplainView => ({
  ...v,
  entries: [entry, ...v.entries].slice(0, MAX_ENTRIES),
  selected: entry.id,
});
export const patchEntry = (
  v: ExplainView,
  id: string,
  patch: Partial<ExplainEntry>,
): ExplainView => ({
  ...v,
  entries: v.entries.map((e) =>
    e.id === id ? ({ ...e, ...patch } as ExplainEntry) : e,
  ),
});
