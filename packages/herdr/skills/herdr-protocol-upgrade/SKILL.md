---
name: herdr-protocol-upgrade
description: >-
  Check whether a Herdr protocol upgrade broke a Herdr plugin, then raise the
  plugin's minimum-protocol constant.
when_to_use: >-
  Use whenever a Herdr plugin reports a protocol mismatch — "needs rebuilding",
  "Herdr was upgraded from protocol N to protocol M", "protocol mismatch",
  "expected N, received M" — or when Herdr updated and a plugin stopped working,
  or when someone is about to change a MINIMUM_PROTOCOL / EXPECTED_PROTOCOL
  constant. Do not read the API schema by hand to answer this; run the script.
version: 1
---

# Herdr protocol upgrade

Herdr bumps its socket protocol often, and almost every bump only *adds* methods and fields. A plugin that pins an exact protocol number therefore breaks on upgrades that did not actually break it. The job here is to find out which kind of bump this was, cheaply.

## Check

```bash
bun "$SKILL_DIR/scripts/protocol-check.ts" --repo /path/to/plugin
```

Resolve `$SKILL_DIR` from the load-time **"Base directory for this skill"** banner. `${CLAUDE_PLUGIN_ROOT}` is not reliable inside a Bash call.

The script queries the running server with `herdr api schema --json`, greps the plugin's tracked source for the methods and tagged response variants it uses, and diffs their dereferenced JSON schemas against `.herdr-protocol.json` in the plugin repo. First run writes that baseline — commit it. Later runs ignore new top-level fields and print removed fields, new request requirements, and changed field schemas.

Do not dump the schema into context yourself. It is a quarter-megabyte of JSON, and reading it costs tens of thousands of tokens to answer a question the diff answers in one line.

The schema-shaping and diff logic is pure and exported; only the CLI entry point shells out. Run `bun test scripts/protocol-check.test.ts` after changing it.

## Act on the result

**No breaking change** (exit 0) — raise the plugin's minimum-protocol constant only if you have a reason to; an upgrade that changed nothing relevant needs no code change at all. Then rebuild, rerun with `--update`, and commit the refreshed baseline alongside.

**Breaking changes** (exit 1) — the report names each dropped field, removed method, and newly required request param. Fix those call sites, then re-check. Never raise the constant past a break; the guard is the only thing that turns it into a clear message instead of a mid-run deserialization error.

## Prefer a floor over an equality check

If the plugin compares protocols with `!=`, that is usually the real bug. An exact match rejects every future Herdr even when nothing broke, and the failure text ("Herdr was upgraded, rebuild this plugin") points the user at the wrong fix. A floor — `if actual < MINIMUM_PROTOCOL` — accepts the additive bumps that make up almost all upgrades, and only fires when Herdr is genuinely too old to talk to.

The trade-off is real and worth stating to the user rather than deciding for them: with no upper bound, a future removal surfaces as a runtime error instead of a clean startup notification. This script is what makes that acceptable — run it on each upgrade and the removal shows up before it ships.

Two things tend to be missed when switching to a floor. The error message and notification usually read backwards afterwards, since only a *too-old* Herdr can trigger them now. And tests that hardcode the old protocol number fail one at a time across several runs; derive them from the constant instead.
