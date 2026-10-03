// every rune; a new rune adds its name here and gates its hooks on `enabled[name]`
export const RUNES = ['clawd'] as const

// register.tsx loads this from $.store at session.start and redraws on every change; a missing rune is on
export const enabled: Record<string, boolean> = {}
