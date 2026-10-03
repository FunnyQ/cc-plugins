// every rune; a new rune adds its name here and its module to hooks.json
export const RUNES = ['clawd'] as const
export type Rune = (typeof RUNES)[number]
