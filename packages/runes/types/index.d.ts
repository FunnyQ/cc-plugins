export type Frame = { clip: string; index: number };
export type MinimapRow = { id: string; kind: string; size: number };

declare module "claude-code" {
  interface PluginState {
    runes: {
      frame: Frame;
      minimapRows: MinimapRow[];
      minimapShown: string[];
      spinner: number;
    };
  }
}
