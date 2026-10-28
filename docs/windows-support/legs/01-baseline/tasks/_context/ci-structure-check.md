# CI structure check

> Used by the CI workflow task and the final review. Run from the repo root.

The script prints `ok` and exits 0 only when `.github/workflows/ci.yml` has the agreed shape. Save nothing to the repo for it. Ruby's YAML parser reads the bare key `on` as `true`, so the script looks up both.

What it asserts:

- Triggers: `push` to `main`, `pull_request`, `workflow_dispatch`.
- `defaults.run.shell: bash`.
- Jobs `required` and `report` both use `fail-fast: false` and the matrix `os: [macos-latest, ubuntu-latest, windows-latest]`, with `runs-on: ${{ matrix.os }}`.
- `required` has no `continue-on-error` at job level or on any step. `report` has `continue-on-error: true` at job level.
- `required` runs `tsc --noEmit` and `hook.test.ts` on every OS, `cockpit.test.ts` only when `runner.os != 'Windows'`, and the no-CR `grep -q` only when `runner.os == 'Windows'`.
- `report`'s suite step ends with `exit 0`; `cargo build --release` runs only on Linux and `cargo check` only on Windows, each with step-level `continue-on-error: true` so a Rust failure never skips the suite; the summary step and the `actions/upload-artifact@v4` step run with `if: always()`.

```bash
ruby -ryaml <<'RUBY'
y = YAML.load_file(".github/workflows/ci.yml")
on = y["on"] || y[true]
os = %w[macos-latest ubuntu-latest windows-latest]
abort "triggers" unless on["push"]["branches"] == ["main"] && on.key?("pull_request") && on.key?("workflow_dispatch")
abort "shell" unless y.dig("defaults", "run", "shell") == "bash"
%w[required report].each do |j|
  st = y["jobs"][j]["strategy"]
  abort "#{j} matrix" unless st["fail-fast"] == false && st["matrix"]["os"] == os
  abort "#{j} runs-on" unless y["jobs"][j]["runs-on"] == "${{ matrix.os }}"
end
abort "required continue-on-error" if y["jobs"]["required"].key?("continue-on-error")
abort "required step continue-on-error" if y["jobs"]["required"]["steps"].any? { |s| s.key?("continue-on-error") }
abort "report continue-on-error" unless y["jobs"]["report"]["continue-on-error"] == true
req = y["jobs"]["required"]["steps"]
step = ->(steps, text) { steps.find { |s| s["run"].to_s.include?(text) } or abort "missing #{text}" }
abort "tsc" unless step.(req, "tsc --noEmit")["if"].nil?
abort "hook.test" unless step.(req, "hook.test.ts")["if"].nil?
abort "cockpit.test if" unless step.(req, "cockpit.test.ts")["if"].to_s.include?("!= 'Windows'")
abort "no-CR if" unless step.(req, "grep -q")["if"].to_s.include?("== 'Windows'")
rep = y["jobs"]["report"]["steps"]
abort "suite" unless step.(rep, "bun test --parallel")["run"].include?("exit 0")
build = step.(rep, "cargo build --release")
abort "build" unless build["if"].to_s.include?("== 'Linux'") && build["continue-on-error"] == true
check = step.(rep, "cargo check")
abort "check" unless check["if"].to_s.include?("== 'Windows'") && check["continue-on-error"] == true
abort "summary if" unless step.(rep, "GITHUB_STEP_SUMMARY")["if"] == "always()"
up = rep.find { |s| s["uses"].to_s.start_with?("actions/upload-artifact@v4") } or abort "upload"
abort "upload if" unless up["if"] == "always()"
puts "ok"
RUBY
```
