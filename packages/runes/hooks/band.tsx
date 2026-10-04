import { read } from 'claude-code'
import type { On } from 'claude-code'

import { clawd, seen, sprite, spriteColumns } from './clawd/mascot'
import { config } from './config'
import { inlineMap } from './minimap/minimap'
import { stem } from './minimap/rows'

// the band's state by their keys: the state scan needs literals written in the file that reads them, and `claude plugin validate` fails a key types/index.d.ts does not declare
const FRAME = { plugin: 'runes', key: 'frame' } as const
const MAP_ROWS = { plugin: 'runes', key: 'minimapRows' } as const
const MAP_SHOWN = { plugin: 'runes', key: 'minimapShown' } as const

// the one AbovePrompt hook of the plugin: Clawd on the right, the minimap on the left, either alone when the other is off
export const band = (on: On) => {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // the band serves the map too, so Clawd off leaves it drawing when the minimap is on
    const hasMap = config.enabled.minimap && e.surface === 'terminal'
    if ((!config.enabled.clawd && !hasMap) || e.props.hasSurvey) return next(e)

    seen(e.requestId, e.surface === 'desktop')
    if (e.surface !== 'desktop' && e.surface !== 'terminal') return next(e)
    const ui = $.ui.resolve(e)
    const { Box } = ui
    // the minimap fills the band's empty left side; Clawd sits on its bottom edge
    const [{ value: frame = { clip: clawd.clip, index: clawd.index } }, list, shown] = await Promise.all([
      $.state.get(FRAME),
      hasMap ? read($, MAP_ROWS) : undefined,
      hasMap ? read($, MAP_SHOWN) : undefined,
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

    if (!config.enabled.clawd) return map ? row() : next(e)
    return row(sprite(ui, e.surface === 'desktop', frame))
  })
}
