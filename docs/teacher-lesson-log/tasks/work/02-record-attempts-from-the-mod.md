# WORK-02: record-attempts-from-the-mod

> **Required reading** (read before starting; do not need to open other files):
>
> - `../_context/shared.md`
> - `../_context/schema.md`
> - `../_context/rubric.md`
>
> **Depends on**: work/01
> **Blocks**: review/01
> **Status**: todo

## Goal

Every prompt the teacher asks Jev about leaves exactly one attempt record, spawned fire-and-forget into the lesson database, while what the teacher shows stays exactly as it is today.

## Files to create / modify

- `packages/runes/hooks/teacher/teacher.ts` (modify) — import the thresholds from `./attempt`, add `Transport.record`, record one `Attempt` per `coach()` call, thread the session promise through `submit()`.
- `packages/runes/hooks/register.tsx` (modify) — `MODEL` / `EFFORT` constants and the `record` spawn.
- `packages/runes/hooks/teacher/teacher.test.ts` (modify) — kit tests for all 7 outcomes, the session hand-through, and scrubbing.
- `packages/runes/hooks/config.ts` (modify) — one disclosure line in `TEMPLATE`'s `teacher` comment.
- `CLAUDE.md` (modify) — one disclosure sentence in the runes summary.

## Implementation notes

`packages/runes/hooks/teacher/attempt.ts` already exists. It exports `ENGLISH = 0.7`, `IMPROVE = 0.6`, `OUTCOMES`, `type Outcome`, `type Attempt`, `type AttemptRow`, `VERDICTS`, `type Verdict`, exactly as `schema.md` gives them. Mod code imports `./attempt` only. It never imports `lessons-db.ts` or `bun:sqlite`.

### `teacher.ts`

- Delete the two lines `const ENGLISH = 0.7;` and `const IMPROVE = 0.6;` (today at lines 12–13), together with the comment above them. Replace them with `import { type Attempt, ENGLISH, IMPROVE } from "./attempt";`. `needsLesson` keeps its `>=` comparisons unchanged.
- Export `SYSTEM` only if a test needs it. Otherwise keep it module-local. `Attempt.system` is the `SYSTEM` string itself.
- Extend `Transport` (today at lines 139–144):

  ```ts
  type Transport = {
    post: Post;
    apiKey: string;
    complete: Complete;
    redraw: () => void;
    record: (a: Attempt, session: Promise<string | undefined>) => void;
  };
  ```

  `work(next)` keeps its `Omit<Transport, "apiKey"> & { apiKey: string | undefined }` shape, so `record` becomes required there too.

- Change `coach` to `coach(t, text, session)`. It calls `t.record(attempt, session)` **exactly once**, at the first exit it reaches, in this order (the schema.md Outcomes table):

  | Outcome       | When                                        | `english` / `improve`                            | `better`        | `quip`                  |
  | ------------- | ------------------------------------------- | ------------------------------------------------ | --------------- | ----------------------- |
  | `jev-failed`  | `systemOne` throws                          | `null`                                           | `null`          | `null`                  |
  | `gated`       | `needsLesson` is false                      | `answers.<q>?.noul ?? null` (gating uses `?? 0`) | `null`          | `null`                  |
  | `no-reply`    | `t.complete` resolves `undefined` or throws | scores                                           | `null`          | `null`                  |
  | `empty`       | `parseReply(reply).better === ""`           | scores                                           | `""`            | `scrub(quip)` or `null` |
  | `same`        | `same(better, text)`                        | scores                                           | `scrub(better)` | `scrub(quip)` or `null` |
  | `not-rewrite` | `!isRewrite(better, text)`                  | scores                                           | `scrub(better)` | `scrub(quip)` or `null` |
  | `shown`       | the lesson is returned                      | scores                                           | `scrub(better)` | `scrub(quip)` or `null` |
  - `prompt` is `scrub(text)`. `text` is already `keyOf(...)` when `coach` gets it. `quip` is `null` whenever `parseReply` returns `undefined`.
  - `englishMin` is `ENGLISH` and `improveMin` is `IMPROVE`.
  - `scrub` already comes from `../transcript/jev`.
  - Catch the `systemOne` throw inside `coach` so it can record `jev-failed`. Catch a `t.complete` throw inside `coach` so it can record `no-reply`. Both still resolve `undefined`, as today.
  - A throw from `record` itself must not change the lesson. The register implementation swallows its own errors, so no extra guard is needed.
  - The return value of `coach` is unchanged in every branch.

- Change `submit(text: string, session: Promise<string | undefined>)` to pass `session` to `coach` unchanged. A prompt rejected by `isWorthAsking`, by the cache (`lessons.has` / `asked.has`), by a disabled rune, or by a missing transport records nothing, as today.
- In `teach()` (today at lines 223–230), the `prompt.submit` hook starts the id without awaiting it, then submits:

  ```ts
  on("prompt.submit", { origin: { kind: "composer" } }, async ($, e, next) => {
    const r = await next(e);
    if (!("drop" in r)) teacher.submit(r.text, $.session.id().catch(() => undefined));
    return r;
  });
  ```

  Rename `_$` to `$`. The hook must not `await` the id, because its return must not wait on it. The id is captured per prompt because a `/clear` moves the process to a new session id and fires no `session.start` (`packages/runes/.claude-plugin/types/claude-code/index.d.ts`, `SessionEndInput.reason`).

### `register.tsx`

- Add module constants `const MODEL = "haiku";` and `const EFFORT = "low";`. In the `session.start` hook (today at lines 116–163), `$.model.complete` uses `model: MODEL, effort: EFFORT`.
- Pass `record` to `teacher.work({...})`, exactly as `schema.md` "The mod's spawn" gives it:

  ```ts
  record: (a, session) => {
    if (!home) return;
    void session
      .then((id) =>
        $.process.run(["bun", `${$.plugin.root}/hooks/teacher/lessons-cli.ts`, "record"], {
          stdin: JSON.stringify({ ...a, at: new Date().toISOString(), project, session: id ?? "", model: MODEL, effort: EFFORT }),
          env: { HOME: home },
        }),
      )
      .catch(() => {});
  },
  ```

  - `home` is `where.home`, which `loadConfig` sets from `$.env.get("HOME")`. `loadConfig` has already run by the time `teacher.work` is called. Read `where.home` inside the hook after `await Promise.all([...loadConfig...])`, or inline `where.home` in the closure.
  - `project` is `e.cwd.split("/").filter(Boolean).at(-1) ?? ""`, computed once in the hook.
  - A mod's child gets no `HOME`, so `env: { HOME: home }` is required.

- `lessons-cli.ts` exists by now. Its `record` subcommand reads one `AttemptRow` JSON on stdin and inserts it. The task does not touch it.

### `teacher.test.ts` (kit runner)

- Every existing `teacher.work({...})` call gains a `record` fake. Every existing `teacher.submit(x)` call gains a session argument, for example `Promise.resolve("s1")`. Their assertions stay unchanged and must stay green. The `teach()` handler test (around line 262) calls `handler(undefined, …)`; pass a stub `$` instead, `{ session: { id: () => Promise.resolve("s1") } }`. That is a call-argument change, not an assertion change.
- Add a recording fake: `const seen: Array<{ a: Attempt; session: Promise<string | undefined> }> = []` with `record: (a, session) => seen.push({ a, session })`.
- Wait for the asynchronous `coach` the way the existing lesson test does: poll a short loop until `seen.length` is non-zero, with a bound, then wait one more short timer tick (for example `await new Promise((r) => setTimeout(r, 20))`) before asserting `seen.length === 1`, so a late second `record` is caught.
- Use a fresh prompt text per test. The teacher's `lessons` / `asked` caches are module state and would otherwise skip a repeat.
- Add one test per outcome. Each asserts `seen.length === 1`, the `outcome`, and the null / score / better / quip shape from the table above:
  - `jev-failed`: `post` resolves `{ ok: false, text: "" }` (`systemOne` throws on `!r.ok`).
  - `gated`, with scores stored: `english: 0.9, improve: 0.1`.
  - `gated`, with a missing answer: `answers: { english: { noul: 0.9 } }` stores `improve: null`.
  - `no-reply`: `complete` resolves `undefined`. Add a second case where `complete` throws.
  - `empty`: reply `"<quip>x</quip>\n"`.
  - `same`: reply equal to the prompt up to case and punctuation.
  - `not-rewrite`: reply containing a fenced code block.
  - `shown`: the existing quip-plus-rewrite reply. Also assert `englishMin === 0.7`, `improveMin === 0.6`, and that `system` starts with `"You are Clawd"`.
- Add one test that the exact promise object passed to `submit` is the one `record` receives (`expect(seen[0].session).toBe(p)`).
- Add one scrub test on a `shown` row. Submit a prompt containing a token that `scrub()` masks, with a fake `complete` reply whose `<quip>` and rewrite both contain the same token, and assert that `a.prompt`, `a.better` and `a.quip` each lack the raw token and contain the masked form. To pick the token, read `scrub` in `packages/runes/hooks/transcript/jev.ts` first, and use a pattern it actually covers, for example an `sk-…` style key.
- Add one `teach()` handler test for per-submit capture: the stub `$.session.id` returns a fresh pending promise per call and counts calls. Two submits of two different prompts must each call `id` once, the handler must resolve before either promise settles; then resolve the two raw promises with `"s1"` and `"s2"` and assert `await seen[0].session` is `"s1"` and `await seen[1].session` is `"s2"`. (The hook passes `p.catch(...)`, a new promise, so assert the resolved value here, not identity; the identity test calls `submit` directly.)
- Add one test that a prompt `isWorthAsking` rejects (`"fix it"`) records nothing.
- Add one test that submitting the same prompt twice, after the first attempt settles, records exactly once (the lesson cache skips the repeat).

### Disclosure

- `packages/runes/hooks/config.ts`: add one comment line to the `teacher` entry in `TEMPLATE`. The line says that, with the teacher on and `TYPESAFE_API_KEY` set, every asked prompt is logged after secret scrubbing to `~/.local/share/q-lab/runes/teacher/lessons.db`, kept until you trash the file. Keep the template's existing comment style.
- `CLAUDE.md`: add one sentence to the runes plugin summary. It says the teacher rune logs every prompt it asks Jev about (scrubbed prompt, scores, outcome, rewrite, quip, model, effort, SYSTEM hash) to `~/.local/share/q-lab/runes/teacher/lessons.db` through a `bun` child (`hooks/teacher/lessons-cli.ts record`), with no opt-in switch and no automatic deletion.

## Acceptance criteria

- [ ] Each of the 7 outcomes has a kit test that sees exactly one `record` call with that outcome and the table's field shape.
- [ ] The session promise passed to `submit` reaches `record` unchanged, and `teach()`'s hook does not `await` `$.session.id()`.
- [ ] Recorded `prompt`, `better` and `quip` are scrubbed; the scrub test proves a masked token never appears raw.
- [ ] A prompt rejected before Jev records nothing.
- [ ] Every pre-existing teacher test still passes with its assertions unchanged.
- [ ] `teacher.ts` holds no threshold literal and imports `ENGLISH` / `IMPROVE` from `./attempt`.
- [ ] `register.tsx` uses `MODEL` / `EFFORT` for both `$.model.complete` and `record`, skips the spawn when `home` is `""`, and passes `env: { HOME: home }`.
- [ ] (human) In a real session, with `TYPESAFE_API_KEY` set and the teacher on, submit `can you checking the logs before we deploying` (expect a lesson), `thanks, that works fine for me` (expect `gated`), and `fix it` (expect no row); exactly two new rows appear. If Jev scores the second above both thresholds, pick another plain-English thanks and note it. Then `sqlite3 ~/.local/share/q-lab/runes/teacher/lessons.db 'select outcome, better, session from attempts order by id desc limit 5'` matches what the UI showed. After `/clear`, submit `please telling me why this test failing` and confirm its row's `session` differs from the earlier rows'.

## Verification

- [ ] `grep -nE '"(haiku|low)"' packages/runes/hooks/register.tsx` prints only the `MODEL` and `EFFORT` constant lines, and `grep -c 'env: { HOME: home }' packages/runes/hooks/register.tsx` prints `2` (the existing `PARSE` spawn plus the new `lessons-cli.ts` spawn).
- [ ] `claude plugin test packages/runes` passes: at least 387 tests (373 + 14 new), 0 fail.
- [ ] `grep -n 'session\.id()' packages/runes/hooks/teacher/teacher.ts` prints exactly one line, inside the `prompt.submit` hook, with no `await`.
- [ ] `claude plugin validate packages/runes` passes.
- [ ] `grep -nE "const (ENGLISH|IMPROVE) =" packages/runes/hooks/teacher/teacher.ts` prints nothing.
- [ ] `grep -n "lessons-db\|bun:sqlite" packages/runes/hooks/teacher/teacher.ts packages/runes/hooks/register.tsx` prints nothing.
- [ ] `grep -n "lessons.db" packages/runes/hooks/config.ts CLAUDE.md` prints at least one line from each file.
- [ ] `git diff --name-only <baseRef> -- packages/runes/hooks/teacher/teacher.ts packages/runes/hooks/register.tsx packages/runes/hooks/teacher/teacher.test.ts packages/runes/hooks/config.ts CLAUDE.md` lists all five paths.

## Eval rubric

> Scale 0–5 per dimension; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto. Shared anchors: `../_context/rubric.md`.

| Dimension               | Weight | 0–1 (fail)                                                                                       | 2–3 (below bar)                                                                       | 4–5 (pass)                                                                                                                    |
| ----------------------- | ------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Correctness             | ×3     | An outcome is recorded twice or not at all, the shown lesson changes, or mod code imports SQLite | Every outcome records once, but a null/score/scrub rule from the outcome table drifts | Exactly one record per ask, every field matches the outcome table, the session id is captured per prompt, the UI is unchanged |
| Test coverage           | ×2     | No new test                                                                                      | Only `shown` and `gated` are tested                                                   | All 7 outcomes plus the missing-answer gate, complete-throws, session hand-through, scrub, and rejected-prompt cases          |
| Interface & readability | ×1     | `record` built from inline literals; `MODEL`/`EFFORT` duplicated                                 | Works, but `coach` grows nested try blocks that hide the exit order                   | `coach` reads top to bottom in outcome order; one `Attempt` builder; constants shared                                         |
| Assumptions & docs      | ×1     | No disclosure, or a new comment explaining the code                                              | Disclosure in only one of the two files                                               | Both disclosure lines present; any deviation from `schema.md` stated in the task report; no new explanatory comment           |

## Out of scope

- The lesson database, `lessons-cli.ts`, and the label and stats commands. Reason: they exist before this task, or they belong to the label/stats work, and this task only spawns `record`.
- Logging prompts that `isWorthAsking` or the 50-entry cache reject. Reason: the plan logs only prompts that reach Jev.
- Changing `SYSTEM`, the model, the effort, or the thresholds. Reason: this plan logs only.
