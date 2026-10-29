# Leg 3 owed checks

The persistent ledger for browser, runes and Herdr checks that no automated run has performed. A row changes to `passed` only when an actual run in the named environment records its result here. Task gate checkboxes are not evidence: completion automation ticks human items too.

Leg-2 debts stay in [../02-core-workflow/WINDOWS-FAILURES.md](../02-core-workflow/WINDOWS-FAILURES.md) and [../02-core-workflow/review-notes.md](../02-core-workflow/review-notes.md); this ledger does not replace them.

| Check                                                                                                                                                    | Environment                      | Status | Evidence                               | Last attempted |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------ | -------------------------------------- | -------------- |
| Chrome: open, reuse by `--id`, interaction, `file://` URL, screenshot under a spaced/CJK path, close and cleanup                                         | Native Windows                   | owed   | not recorded                           | not recorded   |
| Firefox and Zen CLI refuse with `not supported on Windows` before any side effect                                                                        | Native Windows                   | owed   | not recorded                           | not recorded   |
| Linux browser discovery, separate instances, screenshot and close                                                                                        | WSL with Linux browsers          | owed   | not recorded                           | not recorded   |
| Install hint (`Install a Linux build of <browser> inside WSL.`) with no Linux browser installed                                                          | WSL without Linux browsers       | owed   | not recorded                           | not recorded   |
| runes: USERPROFILE initialization, config persistence, explain after checker pass/skip/failure, history reopen, raw/image previews, recoverable deletion | Native Windows                   | owed   | not recorded                           | not recorded   |
| runes: the same set, with the checker using Linux Chrome only or skipping                                                                                | WSL                              | owed   | not recorded                           | not recorded   |
| Herdr pane "Pane check" pass conditions (`--new`, `--view`, snapshot, click, text/eval, screenshot, close only the new view)                             | Native Windows                   | owed   | not recorded                           | not recorded   |
| Herdr pane "Pane check" pass conditions                                                                                                                  | WSL                              | owed   | not recorded                           | not recorded   |
| Zen live behavior (no repeatable CI installation)                                                                                                        | macOS / Linux with Zen installed | owed   | not recorded                           | not recorded   |
| Snap-only Linux host: Chrome/Firefox CLI skips the Snap build and names it in the error                                                                  | Linux with Snap browsers         | owed   | not recorded                           | not recorded   |
| Remote implementation PR: three-OS `required` and `smoke` job results, run URL and outcome                                                               | GitHub Actions                   | owed   | not recorded; no authorized PR has run | not recorded   |

## Herdr pane pass conditions

Use a controlled data/local HTML page with title "Pane check", a button `#increment` labelled "Increment" and a visible `#count` initialized to 0. Clicking Increment must set `#count` to 1. Record the initiating pane id, open a fresh browser view with `--new`, select it explicitly with `--view`, and verify snapshot identifies Increment and count 0. Click Increment, require text/eval and screenshot to show count 1, then close only the new view and confirm the initiating pane and an unrelated view remain open. Record command outputs, view/pane ids and screenshot evidence; an exit code alone is insufficient.
