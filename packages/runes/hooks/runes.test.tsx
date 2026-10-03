import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 20 }, view: {} } } as const

// the kit has no store of its own; this one stands in for the host's
const memoryStore = (on: On) => {
  const values = new Map<string, unknown>()
  on('store.get', (_$, e) => ({ value: values.get(e.key) }) as never)
  on('store.set', (_$, e) => { values.set(e.key, e.value); return { value: undefined } as never })
}

test('/runes clawd off hides Clawd and /runes on brings it back', async ($, on) => {
  mock.clock(on)
  memoryStore(on)
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.render', ($, e) => { const { Text } = $.ui.resolve(e); return <Text key="engine">engine</Text> })
  on('session.start', (_$, e) => e as never)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect((await $.command.run({ command: 'runes', args: 'clawd off' } as never)).text).toContain('clawd: off')
  const off = await $.ui.mount({ plugin: 'runes', surface: 'terminal', ...BAND })
  expect(await off.find({ key: 'clawd' })).toBeUndefined()
  await off.unmount()

  await $.command.run({ command: 'runes', args: 'on' } as never)
  const back = await $.ui.mount({ plugin: 'runes', surface: 'terminal', ...BAND })
  expect(await back.find({ key: 'clawd' })).toBeDefined()
  await back.unmount()
})
