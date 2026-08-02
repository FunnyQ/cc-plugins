# CLI-01: Diagram format contract and @path input

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/diagram-pipeline.md`
> - `../_context/rubric.md`
>
> **Depends on**: none — foundation task
> **Blocks**: cli/02, cli/03, ui/01, docs/01
> **Status**: todo

## Goal

`--diagram` accepts raw SVG as well as Mermaid, detected from the content, and `--diagram @path` reads the argument from a file — with every existing Mermaid call site and stored entry unchanged.

## Files to create / modify

- `packages/monitor/skills/cockpit/scripts/diagram-format.ts` (new) — `detectDiagramFormat` (pure) plus `readDiagramArg` (the one file-I/O function).
- `packages/monitor/skills/cockpit/scripts/diagram-format.test.ts` (new) — unit tests for both.
- `packages/monitor/skills/cockpit/scripts/cockpit.ts` (modify) — resolve `@path`, detect the format, route the write-time gate, and add the record field.

## Implementation notes

### The new module

Create `packages/monitor/skills/cockpit/scripts/diagram-format.ts` with exactly this surface:

```ts
export type DiagramFormat = "mermaid" | "svg";

// Pure. "svg" when the first non-whitespace character is "<", else "mermaid".
export function detectDiagramFormat(src: string): DiagramFormat;

// "@some/file" → that file's contents. Anything else → returned unchanged.
export function readDiagramArg(value: string): string;
```

Keep the two separate. `detectDiagramFormat` must stay pure so it is trivially testable; `readDiagramArg` is the only function in the module that touches the filesystem.

### Why one character is enough

The detection rule is a single test: trim leading whitespace, look at the first character, and answer `"svg"` if it is `<`. There is no second heuristic, and none is to be added.

It is reliable in both directions:

- **No Mermaid source starts with `<`.** The accepted first-line keywords live in a `Set` named `DIAGRAM_TYPES`, exported from `packages/monitor/skills/cockpit/scripts/diagram-lint.ts` — 35 entries such as `flowchart`, `graph`, `stateDiagram-v2`, `sequenceDiagram`, `classDiagram`, `mindmap`, `pie`, `gitGraph`, `timeline`, `C4Context`, `xychart-beta`. Every one begins with a letter. A Mermaid source may legitimately open with a `---` YAML frontmatter block, a blank line, or a `%%` comment — none of those begins with `<` either.
- **Every well-formed SVG document starts with `<`.** The first non-whitespace character is either the XML prolog `<?xml`, a comment `<!--`, a doctype `<!DOCTYPE`, or the root element `<svg`.

Record that reasoning as a comment in the module. It is the justification for refusing a `--diagram-format` flag, and the next reader will otherwise assume the check is naive.

### `@path` resolution

`readDiagramArg("@docs/flow.svg")` returns that file's contents. Any value not starting with `@` is returned unchanged.

Resolution happens **before** detection. That ordering is the whole point of the design: `@` decides *where the argument comes from*, the content decides *what format it is*. So `@flow.mmd` and `@flow.svg` both work and there is no extension rule to write, maintain, or document.

`@` collides with nothing. No Mermaid source and no SVG document begins with `@`, so the prefix needs no escape hatch.

On a missing or unreadable path, fail loudly and name the path. Match the voice `gateDiagram` already uses for its lint failures — the `cockpit <cmd>: …` prefix on stderr, then `process.exit(1)`. Example wording:

```
cockpit log: --diagram @docs/flow.svg — cannot read that file
```

Decide where the exit happens and say so in code: either `readDiagramArg` throws and the caller in `cockpit.ts` prints and exits (keeps the module free of `process.exit`), or the module exits directly. The first is preferable because it keeps the module testable without spawning a subprocess.

### Wiring into `cockpit.ts`

The record type gains one optional field:

```ts
type DecisionRecord = {
  // … unchanged fields …
  diagram?: string;
  diagram_format?: "mermaid" | "svg"; // NEW — absent means "mermaid"
  timestamp: string;
};
```

**Write `diagram_format` only when the value is `"svg"`.** A Mermaid entry must serialize byte-identically to one written before this change. Follow the conditional-spread discipline the file already uses — an entry with no diagram carries no key at all:

```ts
// today
...(args.single["diagram"] ? { diagram: args.single["diagram"] } : {}),

// after this task, using the resolved value
...(diagram ? { diagram: diagram.source } : {}),
...(diagram?.format === "svg" ? { diagram_format: "svg" as const } : {}),
```

**Store the resolved content, never the `@path` string.** The dashboard renders the record in a browser that has no access to the author's filesystem, so the record must be self-contained. A stored `@docs/flow.svg` would render as literal text on the card.

### The gate becomes format-aware

`gateDiagram(cmd, src)` today returns `Promise<void>`, and both subcommands independently re-read `args.single["diagram"]` when building the record. That no longer works once `@path` resolution can change the value: the resolved content has to reach the record construction.

Change the gate to return what it resolved. A shape that works:

```ts
type ResolvedDiagram = { source: string; format: DiagramFormat };

// undefined when no --diagram was passed. Exits non-zero on an unreadable
// @path or on a lint failure, so a returned value is always a written value.
async function gateDiagram(
  cmd: string,
  raw: string | undefined,
): Promise<ResolvedDiagram | undefined>;
```

Order inside it:

1. Early-return `undefined` when `raw` is absent. That guard already exists and must survive — it keeps the lint's cost off every call that carries no diagram.
2. `readDiagramArg(raw)` — resolve `@path`.
3. `detectDiagramFormat(resolved)` — decide the format.
4. Route: `"mermaid"` goes to the existing `await lintDiagram(resolved)`, and on problems prints the existing header line plus one `  - <problem>` line per problem, then exits 1.
5. Return `{ source: resolved, format }`.

**The `"svg"` branch runs no lint in this task.** This is deliberate and temporary: the SVG lint is a separate unit of work that arrives later and wires itself into this same routing point. Do not write a stub linter, do not invent placeholder checks, and do not import a module that does not exist yet — an unresolvable import breaks the whole CLI. Leave a one-line comment at the branch saying the SVG lint lands here, and let SVG through unvalidated for now.

### Both subcommands

`cmdLog` and `cmdScribe` each call `await gateDiagram(...)` and each build their own `DecisionRecord`. Both must be updated to consume the returned value. Neither may be left reading `args.single["diagram"]` directly for the record — that is exactly how a `@path` string leaks into storage.

## Acceptance criteria

- [ ] `detectDiagramFormat` returns `"svg"` for a source starting with `<?xml`, with `<!--`, with `<!DOCTYPE`, with `<svg`, and for any of those preceded by blank lines or indentation.
- [ ] `detectDiagramFormat` returns `"mermaid"` for every keyword in the `DIAGRAM_TYPES` set exported by `packages/monitor/skills/cockpit/scripts/diagram-lint.ts`, iterated in the test rather than hand-listed, and for a source opening with a `---` YAML frontmatter block, a `%%` comment, or leading blank lines.
- [ ] `readDiagramArg` returns the file's contents for a value starting with `@`, and returns any other value unchanged, including one that merely contains `@`.
- [ ] A `--diagram @path` naming a missing or unreadable file exits non-zero and prints a message on stderr that contains that path.
- [ ] A record written with a Mermaid `--diagram` carries a `diagram` key and **no** `diagram_format` key; its `JSON.stringify` output has the same key set and key order as a record written before this change.
- [ ] A record written with an SVG `--diagram` carries `diagram_format: "svg"`.
- [ ] A record written with `--diagram @path` stores the file's contents in `diagram`, not the `@path` string.
- [ ] `cockpit log` and `cockpit scribe` both go through the resolve-detect-route path; neither reads the raw flag value when building its record.
- [ ] An SVG `--diagram` is accepted and written without any lint running, and `cockpit.ts` imports no SVG-lint module.

## Verification

- [ ] Run `bun test packages/monitor/skills/cockpit/scripts/diagram-format.test.ts` — all tests pass.
- [ ] Run `bun test packages/monitor/skills/cockpit/scripts/` — the whole suite is green, including the untouched `diagram-lint.test.ts` and `cockpit.test.ts`.
- [ ] Round-trip against an isolated home, then quote the resulting JSONL lines:
      `COCKPIT_HOME=/tmp/cockpit-dev bun packages/monitor/skills/cockpit/scripts/cockpit.ts log --session smoke-1 --decision "mermaid case" --reason r --diagram "$(printf 'flowchart TD\n  A[start] --> B[end]')"`
      then the same with `--diagram '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'`.
      Confirm the first line has no `diagram_format` key and the second has `"diagram_format":"svg"`.
- [ ] Round-trip the file channel: write that same SVG to a temp file, log with `--diagram @<that path>`, and confirm the stored `diagram` value is the file's contents rather than the `@` string.
- [ ] Run `git status --short` and quote it. Expect `packages/monitor/skills/cockpit/scripts/diagram-format.ts`, `packages/monitor/skills/cockpit/scripts/diagram-format.test.ts`, `packages/monitor/skills/cockpit/scripts/cockpit.ts`, plus at most this task file. Any OTHER path is a real scope violation — investigate it before finishing.

## Eval rubric

> Each dimension is scored 0–5. Weighted average >= 4.0 to pass. `Correctness < 4` is an automatic veto. Scale and dimension definitions: `../_context/rubric.md`.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | detection uses a rule other than the first non-whitespace character, or `@path` resolves after detection | the happy path works but a leading prolog, comment, indentation, or frontmatter case misfires | every listed opening form routes correctly, `@path` resolves first, and an unreadable path exits non-zero naming the path |
| Backward compatibility | ×2 | a Mermaid record's JSON key set or key order changed, or a diagram-free call now pays a resolution cost | a Mermaid record survives but the early-return guard or the existing lint messages were reworded | a Mermaid record is byte-identical, the absent-value early return is intact, and `lintDiagram`'s output is untouched |
| Test coverage | ×2 | no tests, or tests only assert the two obvious cases | happy paths covered, but the missing-file exit and the `DIAGRAM_TYPES` sweep are absent | both functions covered including the unreadable-path failure, and the Mermaid sweep iterates `DIAGRAM_TYPES` rather than hand-listing keywords |
| Interface & readability | ×1 | detection and file reading are fused, or `process.exit` is buried in the pure function | usable but the resolved value is threaded back through a mutable or implicit channel | `detectDiagramFormat` is pure, I/O is confined to `readDiagramArg`, the gate returns its resolved value explicitly, and `type` is used over `interface` |

## Out of scope

- **The SVG lint.** A separate unit of work owns it and wires itself into the routing point this task creates. Writing a stub here would be thrown away and could shadow the real one.
- **Any frontend change.** The dashboard reads `diagram_format` in separate work; nothing under `dashboard/dist/` is touched here.
- **A `--diagram-format` flag.** Explicitly rejected during design. Detection is content-sniffing in exactly one place.
- **A size cap on `--diagram`.** Deferred by decision until a real case hurts.
- **Version bumps and `CHANGELOG.md`.** The release skill owns those.
