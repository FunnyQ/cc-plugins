export type Frame = { clip: string; index: number };
export type MinimapRow = { id: string; kind: string; size: number };
export type ExplainUsage = { input: number; cacheRead: number; output: number };
export type ExplainCheck = "pending" | "ok" | "fixed" | "failed" | "skipped";
export type ExplainEntry = {
  id: string;
  at: number;
  title: string;
  usage?: ExplainUsage;
} & (
  | { kind: "text"; body: string }
  | { kind: "ask"; question: string; options: string[] }
  | {
      kind: "html";
      summary: string;
      path: string;
      check: ExplainCheck;
      note?: string;
    }
);
export type ExplainView = {
  entries: ExplainEntry[]; // newest first
  selected?: string; // an entry id; absent means the newest
  isRunning: boolean; // a fork is in flight
  isAsking?: boolean; // [Tell me…] opened the pane for a fresh question; the history stays hidden until a fork starts
  error?: string; // the last failure, cleared by the next press
  draft?: string; // what the ask field holds: a redraw keeps it, a submit clears it
};

declare module "claude-code" {
  interface PluginState {
    runes: {
      frame: Frame;
      minimapRows: MinimapRow[];
      minimapShown: string[];
      explain: ExplainView;
    };
  }
}
