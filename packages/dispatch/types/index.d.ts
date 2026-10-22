// `snapshot` is a DeckSnapshot (hooks/flightdeck/types.ts), typed loosely because a contract may import nothing.
export type FlightdeckDeck = {
  snapshot: object | null;
  stale: boolean;
  message: string | null;
  tokenMode: "fresh" | "billed";
};

declare module "claude-code" {
  interface PluginState {
    dispatch: { flightdeck: FlightdeckDeck };
  }
}
