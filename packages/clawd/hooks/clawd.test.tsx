import { expect, test } from 'claude-code/testing'

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
