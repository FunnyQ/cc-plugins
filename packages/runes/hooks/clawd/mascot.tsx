import { read } from 'claude-code'
import type { On } from 'claude-code'

import { Director } from './director'
import { IMAGE_COLUMNS, IMAGE_ROWS, octants, pixels, svg } from './encode'
import { CLIPS } from './frames'
import { config } from '../config'
import { inlineMap } from '../minimap/minimap'
import { stem } from '../minimap/rows'

const TICK_MS = 50
// a finished turn keeps Clawd celebrating this long, unless a new prompt comes first
const DONE_MS = 5_000
// 20x16 grid at 2 CSS px per pixel
const SVG_WIDTH = 40
const SVG_HEIGHT = 32
// the columns Clawd takes in each drawing, so the map keeps minimap.gap columns clear of it: the octant text is 10 cells wide
const TEXT_COLUMNS = 10

// read while drawing, so a frame redraws the band alone; an invalidate redrew every transcript row runes hooks
const FRAME = { plugin: 'runes', key: 'frame' } as const
// the minimap's atoms by their keys: the state scan needs literals written in the file that reads them
const MAP_ROWS = { plugin: 'runes', key: 'minimapRows' } as const
const MAP_SHOWN = { plugin: 'runes', key: 'minimapShown' } as const

export const mascot = (on: On) => {
  const director = new Director()
  let requestId: string | undefined
  let now = 0
  let isWorking = false
  let blocked = 0
  let subagents = 0
  let turnStartedAt = 0
  let doneAt = -Infinity
  let lastActiveAt = 0
  let clip = 'living'
  let index = 0
  let elapsed = 0
  // terminals without kitty Unicode placeholders (herdr's libghostty) deny Image blits
  let useText = false
  // the desktop has no blit, so each frame is a redraw of a static SVG (transparent, unlike an isInteractive frame)
  let isDesktop = false

  const inputs = () => ({
    blocked,
    busy: (isWorking ? 1 : 0) + subagents,
    done: now - doneAt < DONE_MS,
    longestTurn: isWorking ? (now - turnStartedAt) / 1000 : 0,
    idleFor: isWorking ? 0 : (now - lastActiveAt) / 1000,
  })

  // register.tsx holds the unmatched session.start; a mascot only matters where someone watches
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    clip = director.next(inputs())
    $.clock.every(TICK_MS, () => {
      now += TICK_MS
      elapsed += TICK_MS
      if (!config.enabled.clawd || requestId === undefined || elapsed < CLIPS[clip]![index]!.ms) return
      elapsed = 0
      index += 1
      if (index === CLIPS[clip]!.length) {
        index = 0
        clip = director.next(inputs())
      }
      if (isDesktop || useText) {
        void $.state.set(FRAME, { clip, index })
        return
      }
      $.ui.blit({ requestId, key: 'clawd', source: pixels(clip, index) }).then(r => {
        if (!('deny' in r)) return
        useText = true
        void $.state.set(FRAME, { clip, index })
      })
    })

    return next(e)
  })

  on('prompt.submit', ($, e, next) => {
    isWorking = true
    turnStartedAt = now
    doneAt = -Infinity
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    // fires for each subagent turn too; only the main loop's ends the work, and subagents outlive it
    if (e.agentId) return next(e)
    isWorking = false
    blocked = 0
    doneAt = now
    lastActiveAt = now
    director.cheer()
    return next(e)
  })

  on('classic.PermissionRequest', ($, e, next) => {
    blocked = 1
    return next(e)
  })

  on('classic.PostToolUse', ($, e, next) => {
    blocked = 0
    return next(e)
  })

  on('classic.PermissionDenied', ($, e, next) => {
    blocked = 0
    return next(e)
  })

  on('classic.SubagentStart', ($, e, next) => {
    subagents += 1
    return next(e)
  })

  on('classic.SubagentStop', ($, e, next) => {
    subagents = Math.max(0, subagents - 1)
    lastActiveAt = now
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // the band serves the map too, so Clawd off leaves it drawing when the minimap is on
    const hasMap = config.enabled.minimap && e.surface === 'terminal'
    if ((!config.enabled.clawd && !hasMap) || e.props.hasSurvey) return next(e)

    requestId = e.requestId
    if (e.surface !== 'desktop' && e.surface !== 'terminal') return next(e)
    const { value: frame = { clip, index } } = await $.state.get(FRAME)
    const ui = $.ui.resolve(e)
    const { Box, Image, Svg, Text } = ui
    // the minimap fills the band's empty left side; Clawd sits on its bottom edge
    const list = hasMap ? (await read($, MAP_ROWS)) ?? [] : []
    const here = new Set(((await read($, MAP_SHOWN)) ?? []).map(stem))
    const spriteColumns = !config.enabled.clawd ? 0 : useText ? TEXT_COLUMNS : IMAGE_COLUMNS
    const room = (e.props.bodyColumns ?? 0) - spriteColumns - (config.enabled.clawd ? config.minimap.gap : 0)
    const map = list.length && room > 4
      ? inlineMap(ui, list, here, room, config.minimap.bar_rows, target => () => void $.ui.scroll({ to: { requestId: target }, block: 'start' })).node
      : undefined
    // bodyColumns, not the viewport: a docked pane narrows the band
    const row = (sprite?: ReturnType<typeof h>) => (
      <Box key="clawd-row" flexDirection="row" justifyContent={!sprite ? 'flex-start' : map ? 'space-between' : 'flex-end'} alignItems="flex-end" width={e.props.bodyColumns}>{map}{sprite}</Box>
    )

    if (!config.enabled.clawd) return map ? row() : next(e)
    if (e.surface === 'desktop') {
      isDesktop = true
      return row(<Svg key="clawd" source={svg(frame.clip, frame.index)} alt={`Clawd ${frame.clip}`} width={SVG_WIDTH} height={SVG_HEIGHT} />)
    }
    // Raster refuses non-BMP characters, so octants go out as plain coloured Text
    if (useText) {
      return row(
        <Box key="clawd" flexDirection="column">
          {octants(frame.clip, frame.index).map((runs, y) => (
            <Text key={String(y)}>{runs.map((run, x) => <Text key={String(x)} color={run.color} backgroundColor={run.backgroundColor}>{run.text}</Text>)}</Text>
          ))}
        </Box>
      )
    }

    return row(<Image key="clawd" columns={IMAGE_COLUMNS} rows={IMAGE_ROWS} alt=" " source={pixels(clip, index)} />)
  })
}
