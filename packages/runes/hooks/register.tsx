import type { Register } from 'claude-code'

import { mascot } from './clawd/mascot'
import { RUNES, type Rune } from './switch'

// the engine lists $.state refs per file, so each file spells this one out
const RUNES_ON = { plugin: 'runes', key: 'enabled' } as const

// the switches live in $.state for the session, mirrored to $.store so they outlast it
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const enabled: Record<string, boolean> = {}
    for (const r of RUNES) enabled[r] = (await $.store.get(`rune:${r}`)) !== false
    await $.state.set(RUNES_ON, enabled)
    await $.command.register({
      name: 'runes',
      description: 'Turn runes (UI mods) on or off',
      argumentHint: `on|off|status, or <${RUNES.join('|')}> on|off`,
    })
    return next(e)
  })

  on('command.run', { command: 'runes' }, async ($, e) => {
    const [first = 'status', second] = e.args.trim().split(/\s+/).filter(Boolean)
    const { value: enabled = {} } = await $.state.get(RUNES_ON)
    const status = (now: Record<string, boolean>) => RUNES.map(r => `${r}: ${now[r] === false ? 'off' : 'on'}`).join(', ')
    const [targets, state] = (RUNES as readonly string[]).includes(first)
      ? [[first as Rune], second]
      : [[...RUNES], first]
    if (state === 'status' || state === undefined) return { text: `Runes — ${status(enabled)}` }
    if (state !== 'on' && state !== 'off') return { text: `Usage: /runes on|off|status, or /runes <${RUNES.join('|')}> on|off` }
    const next = { ...enabled }
    for (const r of targets) {
      next[r] = state === 'on'
      await $.store.set(`rune:${r}`, next[r])
    }
    await $.state.set(RUNES_ON, next)
    return { text: `Runes — ${status(next)}` }
  })

  mascot(on)
}
