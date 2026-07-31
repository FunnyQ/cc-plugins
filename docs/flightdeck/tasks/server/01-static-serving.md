# SERVER-01: static file serving

> **Required reading** (read before starting; do not need to open other files):
> - `../_context/shared.md`
> - `../_context/rubric.md`
>
> **Depends on**: none — foundation task
> **Blocks**: server/02
> **Status**: todo

## Goal

A small, self-contained module that turns a request path into a safe file response from the committed
SPA directory — with the traversal check isolated as a pure function so it can be tested directly.

## Files to create / modify

- `packages/dispatch/skills/autopilot/scripts/static-serve.ts` (new) — the module.
- `packages/dispatch/skills/autopilot/scripts/static-serve.test.ts` (new) — containment, decoding, and
  MIME tests.

**Do not create anything under `dashboard/dist/`.** The design-system task owns that directory and
writes the real page there. A placeholder written here would be overwritten or conflict, since both
tasks can run in the same wave. The tests build their own fixture tree in a temporary directory instead,
which they need anyway to exercise the escape cases.

## Implementation notes

Do not import a serving helper from another plugin. A near-identical one exists under the monitor
plugin; read it if useful, but copying about forty lines is correct here and a cross-plugin import is not.

### Split the decision from the I/O

The security-relevant part must be pure, so a test can assert it without a filesystem:

```ts
/**
 * Map a request pathname to an absolute path inside `root`.
 * Returns null when the path cannot be decoded or escapes the root.
 * Performs NO filesystem access — existence and file-type are the caller's job.
 */
export function resolveStaticPath(root: string, pathname: string): string | null;

export function mimeFor(path: string): string;

/** Impure: stats the resolved path and returns the response. */
export async function serveStatic(root: string, pathname: string): Promise<Response>;
```

`resolveStaticPath` runs these steps in order:

1. map `/` to `/index.html`
2. percent-decode the pathname, returning null if decoding throws on a malformed sequence
3. **strip the single leading slash** to make the path root-relative
4. resolve the remainder against the root
5. confirm the result is still inside the root, returning null otherwise

Step 3 is easy to omit and breaks everything. Every URL pathname begins with `/`, and
`resolve(root, "/app.js")` returns `/app.js` — the root is discarded entirely, because an absolute
second argument wins. Without the strip, either every ordinary asset resolves outside the root and
404s, or an executor invents an undocumented rule. Strip exactly one leading slash, then resolve.

Stripping one slash does **not** weaken the containment check, which still has to catch:

- `/../../../etc/passwd` — traversal after the strip
- `/%2e%2e%2f%2e%2e%2fetc/passwd` — the same, encoded, caught because decoding happens first
- `//etc/passwd` — stripping one slash leaves `/etc/passwd`, which is still absolute, so `resolve`
  escapes the root and the containment check rejects it. Strip exactly one; do not loop.
- `/....//etc/passwd` and similar dot-padding tricks
- a sibling directory whose name merely extends the root's

`/index.html` and `/app.js` must both resolve successfully. Test the success cases alongside the escape
cases; a containment check that rejects everything passes a security test and ships a broken page.

It must not stat anything. Existence and file-type live in `serveStatic`, which returns `404` when the
resolve returns null, when the path does not exist, or when it exists but is not a regular file.

Compare resolved paths with a separator-aware check, not a bare string prefix — a sibling directory
named like the root plus a suffix would otherwise pass.

### Content types and headers

Cover `.html`, `.js`, `.mjs`, `.css`, `.json`, `.svg`, `.png`, `.ico`, and `.woff2`. Anything else gets
`application/octet-stream`. Text types carry `charset=utf-8`.

Send `Cache-Control: no-cache` on every response. The dist directory is hand-edited during development,
and a cached stale bundle is a confusing failure to debug.

## Acceptance criteria

- [ ] `resolveStaticPath` performs no filesystem access.
- [ ] `resolveStaticPath` maps `/` to the index page.
- [ ] `resolveStaticPath` resolves `/index.html` and `/app.js` successfully to files inside the root.
- [ ] `resolveStaticPath` returns null for a plain traversal, an encoded traversal, a double-slash
      prefix, a dot-padding trick, and a malformed percent-encoding.
- [ ] Containment is separator-aware: a sibling directory whose name extends the root's is rejected.
- [ ] `mimeFor` returns the right type for each listed extension and falls back to octet-stream.
- [ ] Text responses carry `charset=utf-8`.
- [ ] `serveStatic` returns `404` for a null resolve, a missing path, and a path that is not a regular file.
- [ ] Every response carries `Cache-Control: no-cache`.

## Verification

- [ ] `bun test packages/dispatch/skills/autopilot/scripts/static-serve.test.ts` — all green.
- [ ] Confirm this task wrote nothing into the SPA directory:
      `git status --porcelain packages/dispatch/skills/autopilot/dashboard/` returns nothing.
- [ ] Confirm the pure function is genuinely pure:
      `rg -n "statSync|existsSync|readFile|Bun\.file" packages/dispatch/skills/autopilot/scripts/static-serve.ts`
      shows hits only inside `serveStatic`.
- [ ] Confirm no cross-plugin import:
      `rg -n "packages/monitor" packages/dispatch/skills/autopilot/scripts/static-serve.ts` returns nothing.
- [ ] Exercise both directions directly in the test file. Must resolve: `/`, `/index.html`, `/app.js`,
      `/modules/lanes.js`. Must return null: `/../../../etc/passwd`, `/%2e%2e%2f%2e%2e%2fetc/passwd`,
      `//etc/passwd`, `/....//etc/passwd`, and a root-prefix sibling such as a directory named like the
      root with `-evil` appended.

## Eval rubric

> Scale and shared dimensions: see `../_context/rubric.md`. Each dimension 0–5; weighted average > 4.0 to pass; Correctness < 4 is an automatic veto.

| Dimension | Weight | 0–1 (fail) | 2–3 (below bar) | 4–5 (pass) |
|---|---|---|---|---|
| Correctness | ×3 | A traversal escapes the root, or ordinary assets fail to resolve | Blocks plain traversal but not the encoded, double-slash, or prefix-sibling case | Leading slash stripped once, every listed asset resolves, every listed escape rejected, decoding failures handled |
| Test coverage | ×2 | No tests | Escape cases only, with no success cases | Both directions covered, each MIME mapping, the octet-stream fallback, and all three 404 paths |
| Interface & readability | ×1 | Resolve and I/O in one function | Split but the pure function still stats | `resolveStaticPath` provably pure, `serveStatic` thin around it |
| Assumptions & docs | ×1 | The leading-slash strip is unexplained | Noted without the reason | Comments explain that an absolute second argument discards the root, and why a bare prefix comparison is unsafe |

## Out of scope

- The daemon, its CLI, and its lifecycle. A separate task in this bucket owns those and wires this module in.
- Any API route.
- Compression, range requests, or ETags. A local single-user page over loopback needs none of them.
- Anything under `dashboard/dist/`. The design-system task owns that directory exclusively; tests here
  use a temporary fixture tree.
