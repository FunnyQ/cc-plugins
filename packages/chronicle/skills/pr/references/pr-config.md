# `.chronicle/pr.json` — PR base configuration

Chronicle writes and commits this repository config after the first `/chronicle:pr`
workflow interview. The setup commit uses a config-only pathspec, so unrelated staged
changes remain staged but are not included. Later runs resolve the PR base from it
without asking again.

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
