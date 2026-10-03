// each rune's switch, keyed by rune name; a rune missing from it is on
export type Switches = Record<string, boolean>

declare module 'claude-code' {
  interface PluginState {
    runes: { enabled: Switches }
  }
}
