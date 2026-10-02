import { expect, test } from 'claude-code/testing'

import { Director, mood } from './director'

const idle = { blocked: 0, busy: 0, done: false, longestTurn: 0, idleFor: 0 }

test('mood ranks blocked over crowd over work', () => {
  expect(mood({ ...idle, blocked: 1, busy: 5 })).toBe('call')
  expect(mood({ ...idle, busy: 3 })).toBe('crowd')
  expect(mood({ ...idle, busy: 1, longestTurn: 300 })).toBe('hot')
  expect(mood({ ...idle, done: true })).toBe('celebrate')
})

test('a long idle yawns, collapses, sleeps, then wakes on work', () => {
  const d = new Director()
  const long = { ...idle, idleFor: 600 }
  expect(d.next(long, () => 0)).toBe('yawn')
  expect(d.next(long, () => 0)).toBe('collapse')
  expect(d.next(long, () => 0)).toBe('sleeping')
  expect(d.next({ ...idle, busy: 1 }, () => 0)).toBe('wake')
})
