import { CLIPS, PALETTE } from './frames'

const DEFAULT = 0x01000000
// the hooks runtime has Uint8Array#toBase64; this tsconfig's lib predates it
const toBase64 = (bytes: Uint8Array) => (bytes as Uint8Array & { toBase64(): string }).toBase64()
const cellCache = new Map<string, string>()
const rgbaCache = new Map<string, string>()

// 20x8 cells, each two stacked pixels; a transparent half must be the background,
// the default foreground being a visible colour.
export const cells = (clip: string, index: number): string => {
  const id = `${clip}/${index}`
  const hit = cellCache.get(id)
  if (hit) return hit
  const grid = CLIPS[clip]![index]!.grid
  const words = new Uint32Array(20 * 8 * 3)
  for (let y = 0; y < 8; y++) for (let x = 0; x < 20; x++) {
    const top = grid[y * 40 + x]!, bottom = grid[y * 40 + 20 + x]!, i = (y * 20 + x) * 3
    if (top === '.') {
      words[i] = bottom === '.' ? 0x20 : 0x2584
      words[i + 1] = bottom === '.' ? DEFAULT : PALETTE[bottom]!
      words[i + 2] = DEFAULT
    } else {
      words[i] = 0x2580
      words[i + 1] = PALETTE[top]!
      words[i + 2] = bottom === '.' ? DEFAULT : PALETTE[bottom]!
    }
  }
  const encoded = toBase64(new Uint8Array(words.buffer))
  cellCache.set(id, encoded)
  return encoded
}

export const pixels = (clip: string, index: number) => {
  const id = `${clip}/${index}`
  let rgba = rgbaCache.get(id)
  if (!rgba) {
    const grid = CLIPS[clip]![index]!.grid
    const bytes = new Uint8Array(20 * 16 * 4)
    for (let p = 0; p < 320; p++) {
      if (grid[p] === '.') continue
      const rgb = PALETTE[grid[p]!]!
      bytes.set([rgb >> 16, (rgb >> 8) & 255, rgb & 255, 255], p * 4)
    }
    rgba = toBase64(bytes)
    rgbaCache.set(id, rgba)
  }
  return { rgba, width: 20, height: 16 }
}

const svgCache = new Map<string, string>()

// One <rect> per horizontal run of a colour; crispEdges keeps the pixels square when scaled.
export const svg = (clip: string, index: number): string => {
  const id = `${clip}/${index}`
  const hit = svgCache.get(id)
  if (hit) return hit
  const grid = CLIPS[clip]![index]!.grid
  const rects: string[] = []
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 20;) {
      const c = grid[y * 20 + x]!
      let end = x + 1
      while (end < 20 && grid[y * 20 + end] === c) end++
      if (c !== '.') rects.push(`<rect x="${x}" y="${y}" width="${end - x}" height="1" fill="#${PALETTE[c]!.toString(16).padStart(6, '0')}"/>`)
      x = end
    }
  }
  const markup = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 16" shape-rendering="crispEdges">${rects.join('')}</svg>`
  svgCache.set(id, markup)
  return markup
}
