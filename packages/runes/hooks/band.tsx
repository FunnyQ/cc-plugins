import { read } from 'claude-code'
import type { On } from 'claude-code'

import { clawd, seen, sprite, spriteColumns } from './clawd/mascot'
import { config } from './config'
import { explainPress } from './explain/explain'
import { inlineMap } from './minimap/minimap'
import { stem } from './minimap/rows'
import { TEACHER_COLOR, TEACHER_ICON } from './teacher/lesson'
import { teacher } from './teacher/teacher'
import { bubble } from './transcript/bubble'
import { innerWidth, wrapWords } from './transcript/text'

// the band's state by their keys: the state scan needs literals written in the file that reads them, and `claude plugin validate` fails a key types/index.d.ts does not declare
const FRAME = { plugin: 'runes', key: 'frame' } as const
const MAP_ROWS = { plugin: 'runes', key: 'minimapRows' } as const
const MAP_SHOWN = { plugin: 'runes', key: 'minimapShown' } as const
const VIEW = { plugin: 'runes', key: 'explain' } as const

export const band = (on: On) => {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const hasMap = config.enabled.minimap && e.surface === 'terminal'
    const lesson = e.surface === 'terminal' ? teacher.latest() : undefined
    const hasButton = config.enabled.explain && e.surface === 'terminal'
    if ((!config.enabled.clawd && !hasMap && !lesson && !hasButton) || e.props.hasSurvey) return next(e)

    seen(e.requestId, e.surface === 'desktop')
    if (e.surface !== 'desktop' && e.surface !== 'terminal') return next(e)
    const ui = $.ui.resolve(e)
    const { Box } = ui
    const [{ value: frame = { clip: clawd.clip, index: clawd.index } }, list, shown, view] = await Promise.all([
      $.state.get(FRAME),
      hasMap ? read($, MAP_ROWS) : undefined,
      hasMap ? read($, MAP_SHOWN) : undefined,
      hasButton ? read($, VIEW) : undefined,
    ])
    // the columns Clawd and its gap take off the map's width; bodyColumns, not the viewport, since a docked pane narrows the band
    const reserved = config.enabled.clawd ? spriteColumns() + config.minimap.gap : 0
    const room = (e.props.bodyColumns ?? 0) - reserved
    const map = list?.length && room > 4
      ? inlineMap(ui, list, new Set((shown ?? []).map(stem)), room, config.minimap.bar_rows, target => () => void $.ui.scroll({ to: { requestId: target }, block: 'start' }))
      : undefined
    const row = (picture?: ReturnType<typeof h>) => (
      <Box key="clawd-row" flexDirection="row" justifyContent={!picture ? 'flex-start' : map ? 'space-between' : 'flex-end'} alignItems="flex-end" width={e.props.bodyColumns}>{map}{picture}</Box>
    )

    const inner = innerWidth(e.props.bodyColumns)
    const [first = [], ...rest] = lesson ? wrapWords([{ text: (lesson.quip ?? lesson.better).replace(/\s+/g, ' ') }], inner - 3) : []
    // resolved on the terminal alone: the desktop's Button and Text are other types, and the notice never draws there
    const term = e.surface === 'terminal' ? $.ui.resolve(e) : undefined
    const notice = !lesson || !term ? undefined : bubble({ Box: term.Box, Text: term.Text }, {
      key: 'teacher',
      color: TEACHER_COLOR,
      icon: TEACHER_ICON,
      title: 'Your English Teacher',
      side: 'left',
      bar: false,
      inner,
      rows: [['teacher:0', (
        <term.Button plain onPress={() => { if (lesson.requestId) void $.ui.scroll({ to: { requestId: lesson.requestId }, block: 'start' }) }}>
          {`${first.map((r) => r.text).join('')}${rest.length ? '…' : ''} ↑`}
        </term.Button>
      )]],
    })
    const withNotice = (node: ReturnType<typeof row>) => (notice ? <Box key="teacher-band" flexDirection="column">{notice}{node}</Box> : node)

    const clawdRow = config.enabled.clawd ? row(sprite(ui, e.surface === 'desktop', frame)) : map ? row() : undefined
    if (!hasButton || !term) return clawdRow ? withNotice(clawdRow) : (notice || next(e))
    return (
      <Box key={notice ? 'teacher-band' : 'explain-band'} flexDirection="column">
        {notice}
        {clawdRow}
        <Box key="explain-row" flexDirection="row" width={e.props.bodyColumns}>
          <term.Button key="explain" plain onPress={() => (view?.isRunning ? undefined : explainPress($))}>
            {view?.isRunning ? 'explaining…' : 'hey mate, explain please'}
          </term.Button>
        </Box>
      </Box>
    )
  })
}
