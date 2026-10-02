import { expect, test } from 'claude-code/testing'

import { IMAGE_COLUMNS, IMAGE_ROWS, OCTANT, octants, pixels } from './encode'
import { CLIPS, PALETTE } from './frames'

test('pixels pre-scales each block to 3x3 inside a 4x2-cell canvas, anchored bottom-left', () => {
  const { rgba, width, height } = pixels('living', 0)
  expect([width, height, IMAGE_COLUMNS, IMAGE_ROWS]).toEqual([72, 76, 4, 2])

  const bytes = Uint8Array.from(atob(rgba), (c) => c.charCodeAt(0))
  const grid = CLIPS.living![0]!.grid
  const p = [...grid].findIndex((c) => c !== '.')
  const rgb = PALETTE[grid[p]!]!
  const want = [rgb >> 16, (rgb >> 8) & 255, rgb & 255, 255]
  const at = (x: number, y: number) => [
    ...bytes.subarray((y * width + x) * 4, (y * width + x) * 4 + 4),
  ]
  const x = (p % 20) * 3,
    y = 28 + Math.floor(p / 20) * 3
  expect(at(x, y)).toEqual(want)
  expect(at(x + 2, y + 2)).toEqual(want)
  expect(at(0, 0)).toEqual([0, 0, 0, 0])
})

test('OCTANT maps the 2x4 bitmask to its glyph, reusing the older block characters', () => {
  expect(new Set(OCTANT).size).toBe(256)
  expect([OCTANT[0], OCTANT[4], OCTANT[15], OCTANT[85], OCTANT[255], OCTANT[254]]).toEqual([0x20, 0x1cd00, 0x2580, 0x258c, 0x2588, 0x1cde5])
})

test('octants draws every frame as 4 rows of 10 cells with the silhouette intact', () => {
  const glyph = new Map(OCTANT.map((cp, mask) => [cp, mask]))
  for (const [clip, frames] of Object.entries(CLIPS)) frames.forEach((frame, index) => {
    const rows = octants(clip, index)
    expect(rows.length).toBe(4)
    rows.forEach((runs, r) => {
      const cells = runs.flatMap(run => [...run.text].map(ch => ({ mask: glyph.get(ch.codePointAt(0)!)!, bgOpaque: run.backgroundColor !== undefined })))
      expect([clip, index, r, cells.length]).toEqual([clip, index, r, 10])
      cells.forEach(({ mask, bgOpaque }, c) => {
        for (let bit = 0; bit < 8; bit++) {
          const opaque = frame.grid[(r * 4 + (bit >> 1)) * 20 + c * 2 + (bit & 1)] !== '.'
          expect([clip, index, r, c, bit, opaque]).toEqual([clip, index, r, c, bit, bgOpaque || !!(mask & (1 << bit))])
        }
      })
    })
  })
})
