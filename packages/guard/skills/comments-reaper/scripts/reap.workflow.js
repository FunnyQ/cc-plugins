export const meta = {
  name: 'comments-reaper',
  description: 'Review each comments-reaper shard, then apply its verdicts',
  phases: [{ title: 'Reap' }],
}

const { root, dir, shards, skillDir, flightlog, deck } = args
const runId = dir.split('/').pop()

function trail(n, role) {
  const ref = `shard/${String(n).padStart(2, '0')}`
  const label = `${role}:${ref}#1`
  if (!flightlog || !deck) return { label, open: '', close: () => '' }
  const file = `${deck}/.flightlog/run.jsonl`
  const log = `bun ${flightlog} log ${file} --task ${ref} --role ${role} --attempt 1 --agent "${label}"`
  const state = (s) => `bun ${flightlog} state ${file} --task ${ref} --state ${s} --agent "${label}"`
  return {
    label,
    open: `This run's identifier is ${runId} .\nBefore anything else, run with Bash:\n${log} --phase start\n\n`,
    close: (when) =>
      `\n\nLast, run with Bash:\n${log} --phase end --message "<one-line outcome>"\n` + when(state),
  }
}

const COUNTS = {
  type: 'object',
  properties: { delete: { type: 'integer' }, mustKill: { type: 'integer' } },
  required: ['delete', 'mustKill'],
}
const RESULT = {
  type: 'object',
  properties: {
    deleted: { type: 'integer' },
    fixed: { type: 'integer' },
    rejected: { type: 'integer' },
    open: { type: 'array', items: { type: 'string' } },
  },
  required: ['deleted', 'fixed', 'rejected', 'open'],
}

const review = async (n) => {
  const t = trail(n, 'verify')
  const prompt =
    `${t.open}Read the report at ${dir}/report-${n}.txt and judge every line marked +. ` +
    `Write your verdicts to ${dir}/verdicts-${n}.txt. ` +
    `Paths in the report are relative to the repository root, ${root}.` +
    t.close((state) => `Then, only when every verdict is KEEP or CLEAN, run:\n${state('done')}\nRun no other Bash command.`)
  const opts = { label: t.label, phase: 'Reap', agentType: 'guard:comments-reaper', schema: COUNTS }
  return (await agent(prompt, opts)) ?? (await agent(prompt, opts))
}

const apply = (counts, n) => {
  if (!counts) return null
  if (counts.delete + counts.mustKill === 0) return { deleted: 0, fixed: 0, rejected: 0, open: [] }
  const t = trail(n, 'fix')
  return agent(
    `${t.open}Work in ${root}. Read ${skillDir}/SKILL.md and follow its steps 3 and 4 for one report: ` +
      `report ${dir}/report-${n}.txt, verdicts ${dir}/verdicts-${n}.txt. ` +
      `Edit only the files the report names and their tests. Never stash or commit. ` +
      `Return each open MUST KILL as its verdict line.` +
      t.close((state) => `Then run ${state('done')} when nothing is open, or ${state('blocked')} --message "<n> open MUST KILL" when something is.`),
    { label: t.label, phase: 'Reap', model: 'opus', effort: 'low', schema: RESULT },
  )
}

const results = await pipeline(Array.from({ length: shards }, (_, i) => i + 1), review, apply)
const done = results.filter(Boolean)
return {
  failed: shards - done.length,
  deleted: done.reduce((s, r) => s + r.deleted, 0),
  fixed: done.reduce((s, r) => s + r.fixed, 0),
  rejected: done.reduce((s, r) => s + r.rejected, 0),
  open: done.flatMap((r) => r.open),
}
