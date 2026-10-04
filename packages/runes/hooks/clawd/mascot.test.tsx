import type { On } from 'claude-code'
import { expect, mock, test, type Engine } from 'claude-code/testing'

import { CONFIG, fakeHost } from '../transcript/test-session'

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


const WORKING = ['crabWalking', 'typing', 'building', 'builder', 'sweeping', 'carrying', 'pushing', 'debugger', 'thinking', 'wizard', 'ultrathink', 'confused']
const turnEnd = { answer: '', durationMs: 0, isAborted: false, turnId: 't', reason: 'answer' } as const

const clipAfter = async ($: Engine, on: On, act: () => Promise<unknown>) => {
  const clock = mock.clock(on)
  fakeHost(on)
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


test("Clawd's frames redraw the band alone, never the transcript", async ($, on) => {
  const clock = mock.clock(on)
  fakeHost(on, { files: new Map([[CONFIG, 'transcript:\n  enabled: false\n']]) })
  let rows = 0
  on('ui.render', ($, e) => {
    if (e.component === 'UserMessage') rows += 1
    const { Text } = $.ui.resolve(e)
    return <Text key="engine">engine</Text>
  })
  on('session.start', (_$, e) => e as never)
  on('prompt.submit', (_$, e) => e as never)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const desk = await $.ui.mount({ plugin: 'runes', surface: 'desktop', ...BAND })
  const row = await $.ui.mount({ plugin: 'runes', surface: 'desktop', component: 'UserMessage', requestId: 'm1', props: { text: 'hi', origin: { kind: 'composer' }, isExpanded: false } } as never)
  await $.prompt.submit({ text: 'go' } as never)
  const before = rows
  const alts = new Set<string>()
  for (let i = 0; i < 20; i++) {
    await clock.advance(500)
    alts.add(JSON.stringify((await desk.find({ type: 'Svg' }))?.props.source))
  }
  await row.unmount()
  await desk.unmount()
  expect(alts.size).toBeGreaterThan(1)
  expect(rows).toBe(before)
})

test('the minimap fills the left of the band on the terminal and never on the desktop', async ($, on) => {
  const clock = mock.clock(on)
  const rows = JSON.stringify({ path: '/t.jsonl', rows: [
    { id: 'u1', kind: 'prompt', size: 20 },
    { id: 'a1', kind: 'reply', size: 200 },
  ] })
  fakeHost(on, {
    files: new Map([[CONFIG, 'minimap:\n  enabled: true\n']]),
    run: ({ argv }) => (argv[0] === 'bun' && argv[1]?.endsWith('minimap/index.ts')
      ? { value: { exitCode: 0, stdout: rows, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      : undefined) as never,
  } as never)
  on('session.id', () => ({ value: 's1' }) as never)
  on('ui.render', ($, e) => { const { Text } = $.ui.resolve(e); return <Text key="engine">engine</Text> })
  on('session.start', (_$, e) => e as never)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(5_000)
  const term = await $.ui.mount({ plugin: 'runes', surface: 'terminal', ...BAND })
  expect((await term.find({ key: 'clawd-row' }))?.props).toMatchObject({ justifyContent: 'space-between' })
  await term.unmount()
  const desk = await $.ui.mount({ plugin: 'runes', surface: 'desktop', ...BAND })
  expect((await desk.find({ key: 'clawd-row' }))?.props).toMatchObject({ justifyContent: 'flex-end' })
  await desk.unmount()
})

test('with Clawd off, the minimap still draws in the band on the terminal, and the desktop has nothing', async ($, on) => {
  const clock = mock.clock(on)
  const rows = JSON.stringify({ path: '/t.jsonl', rows: [
    { id: 'u1', kind: 'prompt', size: 20 },
    { id: 'a1', kind: 'reply', size: 200 },
  ] })
  fakeHost(on, {
    files: new Map([[CONFIG, 'clawd:\n  enabled: false\nminimap:\n  enabled: true\n']]),
    run: ({ argv }) => (argv[0] === 'bun' && argv[1]?.endsWith('minimap/index.ts')
      ? { value: { exitCode: 0, stdout: rows, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      : undefined) as never,
  } as never)
  on('session.id', () => ({ value: 's1' }) as never)
  on('ui.render', ($, e) => { const { Text } = $.ui.resolve(e); return <Text key="engine">engine</Text> })
  on('session.start', (_$, e) => e as never)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(5_000)
  const term = await $.ui.mount({ plugin: 'runes', surface: 'terminal', ...BAND })
  const row = await term.find({ key: 'clawd-row' })
  expect(row?.props).toMatchObject({ justifyContent: 'flex-start', width: 80 })
  expect(await term.find({ key: 'clawd' })).toBeUndefined()
  expect(await term.find({ key: 'line:0' })).toBeDefined()
  await term.unmount()
  // runes draws nothing there: the mount is refused, or it shows the engine's stub and no row of ours
  const desk = await $.ui.mount({ plugin: 'runes', surface: 'desktop', ...BAND }).catch(() => undefined)
  expect(await desk?.find({ key: 'clawd-row' })).toBeUndefined()
  await desk?.unmount()
})
