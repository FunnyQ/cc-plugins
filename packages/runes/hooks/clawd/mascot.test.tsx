import type { On } from 'claude-code'
import { expect, mock, test, type Engine } from 'claude-code/testing'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 20 }, view: {} } } as const

test('Clawd draws a 4x2 Image on the terminal and an Svg on the desktop', async ($, on) => {
  on('ui.render', ($, e) => { const { Text } = $.ui.resolve(e); return <Text key="engine">engine</Text> })
  const ui = await $.ui.mount({ plugin: 'runes', surface: 'terminal', ...BAND })
  expect(await ui.find({ key: 'clawd' })).toBeDefined()
  await ui.unmount()

  const desk = await $.ui.mount({ plugin: 'runes', surface: 'desktop', ...BAND })
  expect(await desk.find({ type: 'Svg' })).toBeDefined()
  await desk.unmount()
})

test('Clawd sits at the right edge of the band, sized to bodyColumns rather than the viewport', async ($, on) => {
  on('ui.render', ($, e) => { const { Text } = $.ui.resolve(e); return <Text key="engine">engine</Text> })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'runes', surface, ...BAND, props: { ...BAND.props, bodyColumns: 63 } })
    const row = await ui.find({ key: 'clawd-row' })
    expect(row?.props).toMatchObject({ flexDirection: 'row', justifyContent: 'flex-end', width: 63 })
    expect((row?.children?.[0] as { type?: string } | undefined)?.type).toBe(surface === 'desktop' ? 'Svg' : 'Image')
    await ui.unmount()
  }
})

// the kit has no store of its own; this one stands in for the host's
const memoryStore = (on: On) => {
  const values = new Map<string, unknown>()
  on('store.get', (_$, e) => ({ value: values.get(e.key) }) as never)
  on('store.set', (_$, e) => { values.set(e.key, e.value); return { value: undefined } as never })
}

const WORKING = ['crabWalking', 'typing', 'building', 'builder', 'sweeping', 'carrying', 'pushing', 'debugger', 'thinking', 'wizard', 'ultrathink', 'confused']
const turnEnd = { answer: '', durationMs: 0, isAborted: false, turnId: 't', reason: 'answer' } as const

const clipAfter = async ($: Engine, on: On, act: () => Promise<unknown>) => {
  const clock = mock.clock(on)
  memoryStore(on)
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.render', ($, e) => { const { Text } = $.ui.resolve(e); return <Text key="engine">engine</Text> })
  on('session.start', (_$, e) => e as never)
  on('prompt.submit', (_$, e) => e as never)
  on('classic.SubagentStart', (_$, e) => e as never)
  on('turn.complete', () => ({ text: '' }) as never)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const desk = await $.ui.mount({ plugin: 'runes', surface: 'desktop', ...BAND })
  await $.prompt.submit({ text: 'go' } as never)
  await act()
  await clock.advance(30_000)
  const alt = String((await desk.find({ type: 'Svg' }))?.props.alt)
  await desk.unmount()
  return alt.replace('Clawd ', '')
}

test('a subagent still running keeps Clawd at work after the main turn ends', async ($, on) => {
  const clip = await clipAfter($, on, async () => {
    await $.classic.SubagentStart({ agent_id: 'a', agent_type: 'general-purpose' } as never)
    await $.turn.complete(turnEnd)
  })
  expect(WORKING).toContain(clip)
})

test("a subagent's own turn ending does not end the main turn", async ($, on) => {
  const clip = await clipAfter($, on, () => $.turn.complete({ ...turnEnd, agentId: 'a' }))
  expect(WORKING).toContain(clip)
})

