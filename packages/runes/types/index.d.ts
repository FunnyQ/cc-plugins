export type Frame = { clip: string; index: number }

declare module 'claude-code' {
  interface PluginState {
    runes: { frame: Frame }
  }
}
