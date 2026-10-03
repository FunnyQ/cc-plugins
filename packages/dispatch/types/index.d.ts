// The flightdeck pane's drawn state: the ticker, the command and the tool hook write it, the render reads it.
// `snapshot` is a DeckSnapshot (hooks/flightdeck/types.ts), typed loosely because a contract may import nothing.
export type FlightdeckDeck = {
  snapshot: object | null;
  stale: boolean;
  message: string | null;
};

declare module "claude-code" {
  interface PluginState {
    dispatch: { flightdeck: FlightdeckDeck };
  }
}
