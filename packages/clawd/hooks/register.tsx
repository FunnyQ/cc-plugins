import type { Register } from 'claude-code'

import { Director } from './director'
import { IMAGE_COLUMNS, IMAGE_ROWS, octants, pixels, svg } from './encode'
import { CLIPS } from './frames'

const TICK_MS = 50
// a finished turn keeps Clawd celebrating this long, unless a new prompt comes first
const DONE_MS = 60_000
// 20x16 grid at 2 CSS px per pixel
const SVG_WIDTH = 40
const SVG_HEIGHT = 32

export const register: Register = on => {
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
    busy: isWorking ? 1 + subagents : 0,
    done: now - doneAt < DONE_MS,
    longestTurn: isWorking ? (now - turnStartedAt) / 1000 : 0,
    idleFor: isWorking ? 0 : (now - lastActiveAt) / 1000,
  })

  on('session.start', async ($, e, next) => {
    clip = director.next(inputs())
    $.clock.every(TICK_MS, () => {
      now += TICK_MS
      elapsed += TICK_MS
      if (requestId === undefined || elapsed < CLIPS[clip]![index]!.ms) return
      elapsed = 0
      index += 1
      if (index === CLIPS[clip]!.length) {
        index = 0
        clip = director.next(inputs())
      }
      if (isDesktop || useText) {
        $.ui.invalidate('ui.render')
        return
      }
      $.ui.blit({ requestId, key: 'clawd', source: pixels(clip, index) }).then(r => {
        if (!('deny' in r)) return
        useText = true
        $.ui.invalidate('ui.render')
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
    isWorking = false
    blocked = 0
    subagents = 0
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
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    requestId = e.requestId
    if (e.surface === 'desktop') {
      isDesktop = true
      const { Svg } = $.ui.resolve(e)
      return <Svg key="clawd" source={svg(clip, index)} alt={`Clawd ${clip}`} width={SVG_WIDTH} height={SVG_HEIGHT} />
    }
    if (e.surface !== 'terminal') return next(e)
    const { Box, Image, Text } = $.ui.resolve(e)

    // Raster refuses non-BMP characters, so octants go out as plain coloured Text
    if (useText) {
      return (
        <Box key="clawd" flexDirection="column">
          {octants(clip, index).map((runs, y) => (
            <Text key={y}>{runs.map((run, x) => <Text key={x} color={run.color} backgroundColor={run.backgroundColor}>{run.text}</Text>)}</Text>
          ))}
        </Box>
      )
    }

    return <Image key="clawd" columns={IMAGE_COLUMNS} rows={IMAGE_ROWS} alt=" " source={pixels(clip, index)} />
  })
}
