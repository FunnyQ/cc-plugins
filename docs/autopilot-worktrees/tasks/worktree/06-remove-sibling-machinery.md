# WORKTREE-06: Delete the sibling-interference machinery

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/worktree.md`
> - `../_context/rubric.md`
>
> **Depends on**: worktree/05
> **Blocks**: docs/02
> **Status**: done

## Goal

The orchestrator stops carrying code and tests that exist only to cope with sibling tasks sharing one working tree. Each non-final task now runs in its own worktree (see `../_context/worktree.md`), so that code is dead.

## Files to create / modify

- `packages/dispatch/skills/autopilot/references/orchestrator.md` (modify) — delete the dead symbols and paths listed below, both in the script block and in the design-notes prose under it.
- `packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts` (modify) — delete the tests and stub routes that exercise the deleted paths.

## Implementation notes

This is a **structural change only**. Remove dead paths and change no surviving behaviour. Earlier changes shift line numbers, so find everything by symbol name, never by line.

### Script block in `orchestrator.md`: delete

- **`GATE_SCHEMA.deferred`**: the `deferred` boolean property and its comment. Also drop it from `required` if it is listed there.
- **`verifyPrompt`'s `requalify` parameter**: remove the `requalify = false` parameter, the `role` switch it drives (the role is always `verify`), and the `closing` branch.
  - Keep the non-requalify closing text, minus its shared-tree sentences. Those are the paragraph that starts "Tasks in this wave run in PARALLEL in one shared working tree" and the sentence that tells the verifier to return `deferred=true` and prefix `SUSPECTED SIBLING INTERFERENCE`.
  - The rule that every Verification command must exit 0 stays.
- **`makeTreeWatch`** and **`withWriter`**: delete both definitions and their comments.
- **`SIBLING_MARKER`** and **`deferralAccepted`**: delete both definitions and their comments.
- **In `executeTask`**:
  - Unwrap the `await withWriter(watch, async () => { … })` around the dev step, and keep its body as-is.
  - Delete the whole `if (deferralAccepted(gate, watch)) { … }` block: `watch.quiet()`, the `requalify:` agent call, and its null-result infrastructure failure.
  - Unwrap `withWriter` around the mark-done call.
  - Delete the comments that explain writer counting, for example "The verifier is deliberately not a writer" and "The rubric judge … is not a tree writer. Counting it would make the quiet signal fire later".
- **The `watch` parameter**: remove it from `executeTask(item, watch)`, `runTaskGuarded(item, watch)`, and `parkBlocked(ref, path, reason, watch)`, and from every call site. `parkBlocked` loses its `withWriter` wrapper and returns the inner result directly.
- **Wave loop**: delete `const watch = makeTreeWatch(slots)` and the comment block above it that explains why the watch is per-wave. `inSlot(() => runTaskGuarded(item))` stays.
- **Resume path**: replace `runTaskGuarded(item, makeTreeWatch(1))` with `runTaskGuarded(item)`, and delete the "Sized 1: a resume has no sibling …" comment.
- **`heldBack`**:
  - Delete the module-level `const heldBack = new Set()` and both `heldBack.add(item.path)` calls in wave reconciliation and resume.
  - Delete the `heldBack` parameter of `commitInstructions`, its "leave these paths uncommitted" list, and the `heldBack` explanatory comments.
  - Every `commitInstructions(label, [...heldBack])` call becomes `commitInstructions(label)`.
  - A parked task's edits never reach the main tree, because they stay in its worktree, so there is nothing to hold back.
- **`NO_RESTORE_RULE`**: keep the ban on `git checkout`, `git restore`, `git reset`, and `git clean`. Delete only the sentence or clause that justifies it with parallel siblings sharing one working tree. If the remaining text needs a reason, give one line: those commands discard work the run has not committed yet.
- Fix every comment that names a deleted symbol, for example the `resilient` comment that lists "`verify` and `requalify`" as idempotent calls. It should list only the calls that still exist.
- **Keep `makeSlots` untouched.** `Max parallel` still uses it to cap external live resources.

### Design notes under the script: update

- Delete the notes that exist only for sibling deferral. That includes the "A verifier may delay a judgement; it may never avoid one" note about sibling-attribution waivers, and any other note that describes the defer, requalify, quiet signal, or tree watch.
- In the "A plan caps its own concurrency with `> **Max parallel**: N`" note, delete the sentences about the watch being sized by slots and the serial deferral being refused. Also delete the **Residual** about an external live delegate that holds no slot and counts as an uncounted writer. Keep the slot, scout, and serial-prose advisory content.
- Delete or rewrite any note that describes `heldBack` or a parked task's paths being kept out of commits. A parked task's work now stays in its worktree.
- Do **not** rewrite the "Do NOT give the dev agent `isolation: 'worktree'`" note here. The isolation change already rewrote it. Only touch it if it still names a deleted symbol.

### Tests in `orchestrator-script.test.ts`: delete

- The whole `describe("defer and requalify gate", …)` block.
- The watch tests: "the watch does not disturb a normal wave", "every dev step held, then released", and "a held catch-path park still reconciles".
  - Keep the "held catch-path park reconciles" coverage if it still asserts reconciliation without a watch. Drop only its watch-specific assertions.
  - Check each of these three tests against the surviving code before you delete it.
- In `describe("plan concurrency cap", …)`, the test that asserts a serial wave rejects a sibling deferral.
- Every `requalify:` entry in prompt-position checks, for example the label list that includes `"requalify:ui/main#1"` in the test that asserts each prompt ends with its contract. Also remove the `deferred` and `siblingMarker` fixtures those tests use.
- The `requalify:` stub route and its scenario queue in the stub `agent()`. Also remove any scenario key such as `requalify: { … }` that no surviving test sets, and the `deferred?: boolean` fields in the stub's scenario types.
- Prompt tests that assert on the defer text, such as `toContain("deferred is ignored")` and the matching `not.toContain` on the normal verify prompt.
- Every other test passes **unchanged**. If a surviving test fails, you removed a live path; restore it rather than editing the test.

## Acceptance criteria

- [x] `rg -n "SIBLING_MARKER|makeTreeWatch|deferralAccepted|withWriter|heldBack|requalify|SUSPECTED SIBLING|deferred" packages/dispatch/skills/autopilot/references/orchestrator.md packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts` prints nothing.
- [x] `makeSlots` is still defined in `orchestrator.md` and still wraps each task pipeline in the wave loop.
- [x] `NO_RESTORE_RULE` still bans `git checkout`, `git restore`, `git reset`, and `git clean`.
- [x] No function in the script block takes a parameter it no longer reads, and `commitInstructions` takes only the agent label.
- [x] Every test left in `orchestrator-script.test.ts` passes, and no surviving test's assertions were edited.

## Verification

- [x] `bun test packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts` exits 0.
- [x] `rg -n "SIBLING_MARKER|makeTreeWatch|deferralAccepted|withWriter|heldBack|requalify|SUSPECTED SIBLING|deferred" packages/dispatch/skills/autopilot/references/orchestrator.md packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts` prints nothing.
- [x] `rg -n "makeSlots" packages/dispatch/skills/autopilot/references/orchestrator.md` prints at least the definition and one call site.
- [x] `bunx --bun tsc --noEmit 2>&1 | grep packages/dispatch/skills/autopilot/scripts/orchestrator-script.test.ts` prints nothing.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | A live path removed (slots, the restore ban, park or resume behaviour changed), or a surviving test edited to pass | Dead code gone, but a deleted symbol still referenced somewhere in the script or notes | Every listed symbol and path gone, surviving behaviour byte-identical, all remaining tests pass unedited |
| Test coverage | ×2 | Dead tests left failing, or live tests deleted | Dead tests removed but stub routes or fixtures for them linger | Exactly the dead tests, stub routes, and fixtures removed; surviving coverage intact |
| Interface & readability | ×1 | Leftover `watch` or `heldBack` parameters, or wrappers left as no-ops | Signatures clean but orphan comments still explain removed mechanics | No leftover params, no no-op wrappers, no comment naming a deleted concept |
| Assumptions & docs | ×1 | Design notes still describe the defer, requalify, or tree watch | Notes mostly updated, one stale sentence left | Design notes match the code; the `Max parallel` note keeps only slot content |

## Out of scope

- Docs outside `orchestrator.md`, such as autopilot `SKILL.md`, `task-template.md`, and `deckplan/references/authoring.md`. Reason: a separate docs change owns them.
- `autopilot/scripts/fleet.ts` and `flightplan/scripts/lib/resume-point.ts`, which still recognize the `requalify` role. Deferred. Reason: they parse flightlogs from past runs, which still contain `requalify` rows.
- Any behaviour change to worktree isolation, land, or drift re-verify. Reason: this task only deletes dead code.
- The `reverify:<ref>#<attempt>` drift re-verify, its prompt, and its stub route. Reason: it is not sibling machinery. It re-checks a land onto a moved main tree, and it stays. If it reuses the `requalify` parameter of `verifyPrompt`, rename that parameter to `reverify` instead of deleting it.
