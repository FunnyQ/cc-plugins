# `.chronicle/pr.json` — PR base configuration

Chronicle writes this repository config after the first `/chronicle:pr` workflow
interview, then commits it through a visible config-only `git commit` command. This
lets the protected-branch hook inspect the operation, while the pathspec keeps
unrelated staged changes out of the commit. Later runs resolve the PR base from the
config without asking again.

## GitHub Flow

```json
{
  "workflow": "github-flow",
  "base": "main"
}
```

Every branch targets `base`.

## Git Flow

```json
{
  "workflow": "git-flow",
  "production": "main",
  "development": "develop"
}
```

`hotfix/*`, `hotfix-*`, `release/*`, and `release-*` target `production`. Every
other branch targets `development`. Branch names are explicit so repositories using
`master` or a custom development branch do not rely on guesses.

## Precedence

1. A base explicitly named for the current invocation.
2. `.chronicle/pr.json`.
3. A first-run interview when the file does not exist.

An invalid committed config is an error. Chronicle never silently falls back to the
remote default after repository intent has been recorded.

## Analysis ref

Branch analysis uses `origin/<base>` when that remote-tracking ref exists, because a
PR host compares against its remote base. A local base is the offline fallback.
Chronicle does not fetch automatically during analysis.
