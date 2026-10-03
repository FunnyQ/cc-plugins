import { CLIPS, PALETTE } from './frames'

// the hooks runtime has Uint8Array#toBase64; this tsconfig's lib predates it
const toBase64 = (bytes: Uint8Array) => (bytes as Uint8Array & { toBase64(): string }).toBase64()

// Octant glyphs (Unicode 16) for a 2x4 bitmask, bit = row * 2 + column. U+1CD00 holds the
// 230 patterns no older block character already drew, in ascending mask order.
const OLDER_BLOCKS: Record<number, number> = {
  0: 0x20, 1: 0x1cea8, 2: 0x1ceab, 3: 0x1fb82, 5: 0x2598, 10: 0x259d, 15: 0x2580, 20: 0x1fbe6, 40: 0x1fbe7,
  63: 0x1fb85, 64: 0x1cea3, 80: 0x2596, 85: 0x258c, 90: 0x259e, 95: 0x259b, 128: 0x1cea0, 160: 0x2597,
  165: 0x259a, 170: 0x2590, 175: 0x259c, 192: 0x2582, 240: 0x2584, 245: 0x2599, 250: 0x259f, 252: 0x2586, 255: 0x2588,
}
let nextOctant = 0x1cd00
export const OCTANT = Array.from({ length: 256 }, (_, mask) => OLDER_BLOCKS[mask] ?? nextOctant++)

// every frame is drawn once per clip and index, then served from the cache
const memo = <T>(draw: (clip: string, index: number) => T) => {
  const cache = new Map<string, T>()
  return (clip: string, index: number): T => {
    const id = `${clip}/${index}`
    if (!cache.has(id)) cache.set(id, draw(clip, index))
    return cache.get(id)!
  }
}

const hex = (rgb: number) => `#${rgb.toString(16).padStart(6, '0')}`
const distance = (a: number, b: number) =>
  ((a >> 16) - (b >> 16)) ** 2 + (((a >> 8) & 255) - ((b >> 8) & 255)) ** 2 + ((a & 255) - (b & 255)) ** 2

export type Run = { text: string; color?: string; backgroundColor?: string }

// a cell holds two colours; a third goes to the commonest so the silhouette survives (1.3% of pixels lost)
export const octants = memo((clip, index): Run[][] => {
  const grid = CLIPS[clip]![index]!.grid
  const rows = Array.from({ length: 4 }, (_, r) => {
    const runs: Run[] = []
    for (let c = 0; c < 10; c++) {
      const block = Array.from({ length: 8 }, (_, bit) => grid[(r * 4 + (bit >> 1)) * 20 + c * 2 + (bit & 1)]!)
      const counts = new Map<string, number>()
      for (const s of block) if (s !== '.') counts.set(s, (counts.get(s) ?? 0) + 1)
      const [fg, bg] = [...counts].sort((a, b) => b[1] - a[1]).map(([s]) => PALETTE[s]!)
      const transparent = block.includes('.')
      let mask = 0
      block.forEach((s, bit) => {
        if (s === '.') return
        if (transparent || bg === undefined || distance(PALETTE[s]!, fg!) <= distance(PALETTE[s]!, bg)) mask |= 1 << bit
      })
      const color = fg === undefined ? undefined : hex(fg)
      const backgroundColor = transparent || bg === undefined ? undefined : hex(bg)
      const last = runs.at(-1)
      const ch = String.fromCodePoint(OCTANT[mask]!)
      if (last && last.color === color && last.backgroundColor === backgroundColor) last.text += ch
      else runs.push({ text: ch, color, backgroundColor })
    }
    return runs
  })
  return rows
})

// The terminal stretches a picture to its box with linear filtering, so the blocks are
// scaled here, nearest-neighbour, to about the box's own pixel size and stay sharp.
// cell size measured off one Ghostty font (18x38 px); read it from the terminal if the API ever exposes it
const BLOCK = 3
const CELL_WIDTH = 18
const CELL_HEIGHT = 38
export const IMAGE_COLUMNS = 4
export const IMAGE_ROWS = 2
const CANVAS_WIDTH = IMAGE_COLUMNS * CELL_WIDTH
const CANVAS_HEIGHT = IMAGE_ROWS * CELL_HEIGHT
const TOP = CANVAS_HEIGHT - 16 * BLOCK

export const pixels = memo((clip, index) => {
  const grid = CLIPS[clip]![index]!.grid
  const bytes = new Uint8Array(CANVAS_WIDTH * CANVAS_HEIGHT * 4)
  for (let p = 0; p < 320; p++) {
    if (grid[p] === '.') continue
    const rgb = PALETTE[grid[p]!]!
    const pixel = [rgb >> 16, (rgb >> 8) & 255, rgb & 255, 255]
    const x = (p % 20) * BLOCK, y = TOP + Math.floor(p / 20) * BLOCK
    for (let dy = 0; dy < BLOCK; dy++) for (let dx = 0; dx < BLOCK; dx++) bytes.set(pixel, ((y + dy) * CANVAS_WIDTH + x + dx) * 4)
  }
  return { rgba: toBase64(bytes), width: CANVAS_WIDTH, height: CANVAS_HEIGHT }
})

// One <rect> per horizontal run of a colour; crispEdges keeps the pixels square when scaled.
export const svg = memo((clip, index): string => {
  const grid = CLIPS[clip]![index]!.grid
  const rects: string[] = []
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 20;) {
      const c = grid[y * 20 + x]!
      let end = x + 1
      while (end < 20 && grid[y * 20 + end] === c) end++
      if (c !== '.') rects.push(`<rect x="${x}" y="${y}" width="${end - x}" height="1" fill="${hex(PALETTE[c]!)}"/>`)
      x = end
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 16" shape-rendering="crispEdges">${rects.join('')}</svg>`
})
