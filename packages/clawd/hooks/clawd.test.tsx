import { expect, mock, test } from 'claude-code/testing'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 20 }, view: {} } } as const

test('Clawd draws a 4x2 Image on the terminal and an Svg on the desktop', async ($, on) => {
  on('ui.render', ($, e) => { const { Text } = $.ui.resolve(e); return <Text key="engine">engine</Text> })
  const ui = await $.ui.mount({ plugin: 'clawd', surface: 'terminal', ...BAND })
  expect(await ui.find({ key: 'clawd' })).toBeDefined()
  await ui.unmount()

  const desk = await $.ui.mount({ plugin: 'clawd', surface: 'desktop', ...BAND })
  expect(await desk.find({ type: 'Svg' })).toBeDefined()
  await desk.unmount()
})

const WORKING = ['crabWalking', 'typing', 'building', 'builder', 'sweeping', 'carrying', 'pushing', 'debugger', 'thinking', 'wizard', 'ultrathink', 'confused']
const turnEnd = { answer: '', durationMs: 0, isAborted: false, turnId: 't', reason: 'answer' } as const

const clipAfter = async ($: Parameters<Parameters<typeof test>[1]>[0], on: Parameters<Parameters<typeof test>[1]>[1], act: () => Promise<unknown>) => {
  const clock = mock.clock(on)
  on('ui.render', ($, e) => { const { Text } = $.ui.resolve(e); return <Text key="engine">engine</Text> })
  for (const event of ['session.start', 'prompt.submit', 'classic.SubagentStart'] as const) on(event, (_$, e) => e as never)
  on('turn.complete', () => ({ text: '' }) as never)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const desk = await $.ui.mount({ plugin: 'clawd', surface: 'desktop', ...BAND })
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
