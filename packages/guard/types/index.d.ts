/** A reviewer in flight: when it was spawned, in epoch ms. */
export type Review = { since: number };

declare module "claude-code" {
  interface PluginState {
    guard: {
      review: Review | null;
      /** A turn ended unswept, so the next turn keeps the old baseline and its sweep covers both. */
      carry: boolean;
      /** The running main turn is guard's own delivery of verdicts. */
      ownTurn: boolean;
    };
  }
}
