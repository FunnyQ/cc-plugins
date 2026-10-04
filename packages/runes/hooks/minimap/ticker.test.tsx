import { expect, mock, test } from 'claude-code/testing'

import { CONFIG, fakeHost } from '../transcript/test-session'

test('an idle transcript is read once, and read again only when it changes', async ($, on) => {
  const clock = mock.clock(on)
  let spawns = 0
  let mtimeMs = 1
  let isFailing = false
  const out = JSON.stringify({ path: '/t.jsonl', rows: [{ id: 'u1', kind: 'prompt', size: 20 }] })
  fakeHost(on, {
    files: new Map([[CONFIG, 'minimap:\n  enabled: true\n']]),
    run: ({ argv }) => {
      if (argv[0] !== 'bun' || !argv[1]?.endsWith('minimap/index.ts')) return undefined
      spawns += 1
      if (isFailing) return { value: { exitCode: 1, stdout: '', stderr: 'boom', isStdoutTruncated: false, isStderrTruncated: false } }
      return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    },
  } as never)
  on('session.id', () => ({ value: 's1' }) as never)
  on('fs.stat', () => ({ value: { kind: 'file', size: 10, mtimeMs, isLink: false } }) as never)
  on('session.start', (_$, e) => e as never)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(30_000)
  // the first read learns the path; the next tick sees a stat it has not matched once, then none changes
  expect(spawns).toBeLessThanOrEqual(2)
  const idle = spawns
  mtimeMs = 2
  await clock.advance(5_000)
  expect(spawns).toBe(idle + 1)

  // a read that fails leaves the transcript unread, so the next tick tries again though nothing changed
  isFailing = true
  mtimeMs = 3
  await clock.advance(3_000)
  const failed = spawns
  await clock.advance(9_000)
  expect(spawns).toBeGreaterThanOrEqual(failed + 3)
})
