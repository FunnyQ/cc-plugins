export type Review = { since: number };

declare module "claude-code" {
  interface PluginState {
    guard: {
      review: Review | null;
      carry: boolean;
      ownTurn: boolean;
    };
  }
}
