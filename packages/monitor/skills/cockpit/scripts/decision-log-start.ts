#!/usr/bin/env bun

import {
  shouldSkipDecisionLogReminder,
  type DecisionLogHookInput,
} from "./decision-log-reminder";

const GUIDANCE =
  'DECISION LOG ACTIVE — /cockpit scribe is this session decision log. When you finish a chunk of work genuinely worth recording — a non-obvious decision between real alternatives, deliberate-but-odd code, a tricky learning, or a sharp caveat/ordering trap — spawn a background fork to distill it: Agent(subagent_type: "fork", prompt: "Run /cockpit scribe to distill the work we just completed into cockpit decision-trail entries."). The fork writes entries in the configured decision-log language (it resolves this itself), which may differ from this chat. One fork per logical chunk. Skip trivial edits — the bar is high, and missing some is fine. Use "fork" exactly (omitting it starts a fresh, context-less agent).';

async function main() {
  let input: DecisionLogHookInput = {};
  try {
    input = JSON.parse(await Bun.stdin.text());
  } catch {
    // Missing hook input degrades to the environment-only checks.
  }

  if (shouldSkipDecisionLogReminder(process.env, input)) return;
  process.stdout.write(`${GUIDANCE}\n`);
}

if (import.meta.main) {
  main().catch(() => {});
}
