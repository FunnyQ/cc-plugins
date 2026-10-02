// Port of janus-hud's MascotDirector (Island/Mascot.swift): picks the next clip each time one ends.
import { CLIPS } from './frames'

export type Mood = 'call' | 'crowd' | 'celebrate' | 'hot' | 'work' | 'idle'
export type Inputs = { blocked: number; busy: number; done: boolean; longestTurn: number; idleFor: number }

export const CROWD = 3
export const LONG_TURN = 300
export const SLEEP_AFTER = 300
const WORK_BASES = ['crabWalking', 'typing']
const CROWD_BASES = [...WORK_BASES, 'juggling', 'conducting']
const HOT_BASES = [...WORK_BASES, 'building']
const WORK = ['building', 'builder', 'sweeping', 'carrying', 'pushing', 'debugger', 'thinking', 'wizard', 'ultrathink', 'confused']
const CELEBRATIONS = ['happy', 'success', 'doubleJump']
const IDLE_BASES = ['follow', 'living', 'look']
const IDLES = ['reading', 'music', 'smoking', 'doze']
const REACTIONS = ['annoyed', 'panic', 'dragged', 'lookLeft', 'lookRight']
// Clip lengths in tenths of a second, the frames' own resolution, so stints count down exactly.
const TENTHS: Record<string, number> = Object.fromEntries(
  Object.entries(CLIPS).map(([name, frames]) => [name, Math.round(frames.reduce((sum, f) => sum + f.ms, 0) / 100)]),
)
// A special repeats until it has run 8 s, so a 2 s clip reads as more than a blip.
const SPECIAL_STINT = 80

export const mood = ({ blocked, busy, done, longestTurn }: Inputs): Mood => {
  if (blocked > 0) return 'call'
  if (busy >= CROWD) return 'crowd'
  if (busy === 0) return done ? 'celebrate' : 'idle'
  return longestTurn >= LONG_TURN ? 'hot' : 'work'
}

const pick = (clips: string[], random: () => number) => clips[Math.min(clips.length - 1, Math.floor(random() * clips.length))]!

export class Director {
  private current: string | undefined
  private cheering = false
  private reacting = false
  // The base or special now looping, with the tenths it has left to run.
  private stint: { clip: string; left: number } | undefined
  private lastSpecial: string | undefined

  cheer() { this.cheering = true }

  react() { this.reacting = true }

  next(inputs: Inputs, random: () => number = Math.random): string {
    this.current = this.choose(mood(inputs), inputs.idleFor, random)
    return this.current
  }

  private choose(m: Mood, idleFor: number, random: () => number): string {
    // A click wakes a sleeping Clawd before it reacts.
    if (this.current === 'collapse' || this.current === 'sleeping') return m === 'idle' && !this.reacting ? 'sleeping' : 'wake'
    if (this.reacting) {
      this.reacting = false
      return pick(REACTIONS, random)
    }
    if (this.cheering) {
      this.cheering = false
      return pick(CELEBRATIONS, random)
    }
    switch (m) {
      case 'call': return 'notification'
      case 'celebrate':
        if (this.current && CELEBRATIONS.includes(this.current)) return this.current
        return pick(CELEBRATIONS, random)
      case 'crowd': return this.rotate(CROWD_BASES, WORK, random)
      case 'work': return this.rotate(WORK_BASES, WORK, random)
      case 'hot':
        return this.rotate(HOT_BASES, this.lastSpecial === 'overheated' ? WORK.filter(c => c !== 'building') : ['overheated'], random)
      case 'idle':
        if (idleFor >= SLEEP_AFTER) return this.current === 'yawn' ? 'collapse' : 'yawn'
        return this.rotate(IDLE_BASES, IDLES, random)
    }
  }

  // Loops the current stint while it lasts and still suits the mood; a spent base hands over to a
  // special, and a spent special, or one the mood no longer has, back to a base.
  private rotate(bases: string[], specials: string[], random: () => number): string {
    const stint = this.stint
    if (stint && stint.left > 0 && [...bases, ...specials].includes(stint.clip)) {
      this.stint = { clip: stint.clip, left: stint.left - TENTHS[stint.clip]! }
      return stint.clip
    }
    const isSpecial = stint ? bases.includes(stint.clip) : false
    const clip = isSpecial ? pick(specials.filter(c => c !== this.lastSpecial), random) : pick(bases, random)
    if (isSpecial) this.lastSpecial = clip
    // A base runs 20 to 40 s between specials.
    const length = isSpecial ? SPECIAL_STINT : 200 + Math.floor(random() * 200)
    this.stint = { clip, left: length - TENTHS[clip]! }
    return clip
  }
}
