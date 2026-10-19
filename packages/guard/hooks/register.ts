/**
 * comment-guard on Claude Code: one review per turn, by a reviewer that did
 * not write the comments. Each main turn's start snapshots the worktree
 * through comment-sweep.ts; its end diffs against it, so Edit, Write and a
 * Bash `sed -i` alike reach the same report. A non-empty report goes to the
 * `guard:comment-reviewer` subagent in the background, and its verdicts come
 * back as a prompt the main agent audits and acts on.
 *
 * The author is no longer asked mid-edit: it defends what it just wrote, and
 * a reviewer asked after it would re-judge the same lines. Codex and OpenCode
 * have no function hooks, so they keep the command hooks and that question.
 */

import type { EngineInterface, Register } from "claude-code";
import {
  CLEAN,
  deliverPrompt,
  MARK,
  REVIEWER_PROMPT,
  reviewTask,
} from "./reviewer.ts";

const REVIEW = { plugin: "guard", key: "review" } as const;
const CARRY = { plugin: "guard", key: "carry" } as const;
const OWN_TURN = { plugin: "guard", key: "ownTurn" } as const;
const NAME = "comment-reviewer";
const AGENT = `guard:${NAME}`;
// A reviewer that never reports back must not hold off every later review.
const STALE_MS = 10 * 60_000;

type Found = { report: string; blocks: number; note: string | null };

let warned = false;

async function runSweep(
  $: EngineInterface,
  args: string[],
): Promise<string | null> {
  const stdin = JSON.stringify({
    session_id: await $.session.id(),
    cwd: await $.session.cwd(),
  });
  try {
    const ran = await $.process.run(
      ["bun", `${$.plugin.root}/hooks/comment-sweep.ts`, ...args],
      { stdin },
    );
    if (ran.exitCode === 0) return ran.stdout;
    throw new Error(ran.stderr.trim() || `exit ${ran.exitCode}`);
  } catch (err) {
    // A mod has no Bun global, so the sweep needs `bun` on PATH; without it nothing is guarded.
    if (!warned) {
      warned = true;
      $.ui.toast(`${MARK}: comment-sweep did not run (needs bun): ${err}`);
    }
    return null;
  }
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    const ran = await next(e);
    await $.agent.register({
      name: NAME,
      description:
        "Reviews the comment lines a turn added, with no stake in them. Spawned by guard alone.",
      prompt: REVIEWER_PROMPT,
      tools: ["Read", "Grep", "Glob"],
      model: "sonnet",
      effort: "medium",
    });
    return ran;
  });

  on("agent.offer", { agent: AGENT }, () => ({ isOffered: false })).catch(
    () => ({ isOffered: false }),
  );

  // Its own spawn only: auto mode's classifier otherwise judges a read-only reviewer the person never asked for, and denies it when unavailable.
  on("tool.check", { tool: "Agent" }, async ($, e, next) => {
    const own =
      next.origin.plugin === $.plugin.name &&
      (e.input as { subagent_type?: string }).subagent_type === AGENT;
    return own ? { decision: "allow" } : next(e);
  });

  // A hand-back drew the report as an agent card and handed it to the main agent a turn before the delivery prompt, which then answered it twice (seen live).
  // `as never`: the harness adds this tool to subagents, so the 2.1.303 types list no such name.
  on("tool.call", { tool: "SubagentHandback" as never }, async ($, e, next) => {
    const { agentId } = e as { agentId?: string };
    if (!agentId) return next(e);
    const agents = await $.agent.list();
    if (agents.find((a) => a.id === agentId)?.type !== AGENT) return next(e);
    return {
      deny: "Do not hand back. Reply with your verdict lines as your final message instead.",
    };
  });

  on("turn.start", async ($, e, next) => {
    if (e.agentId) return next(e);
    await $.state.set(OWN_TURN, e.text.includes(MARK));
    const { value: carry } = await $.state.get(CARRY);
    if (!carry) await runSweep($, ["snapshot"]);
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    const ran = await next(e);

    if (e.agentId) {
      // By type, not by the id spawn answered: any reviewer's answer is guard's to deliver.
      const agents = await $.agent.list();
      if (agents.find((a) => a.id === e.agentId)?.type !== AGENT) return ran;
      await $.state.set(REVIEW, null);
      $.ui.status(undefined);
      const verdicts = e.answer.trim();
      if (e.reason !== "answer" || !verdicts || verdicts === CLEAN) return ran;
      // Not awaited: it resolves only once the queued turn starts.
      void $.prompt.submit({ text: deliverPrompt(verdicts) });
      return ran;
    }

    const { value: review } = await $.state.get(REVIEW);
    const busy = review && (await $.clock.now()) - review.since < STALE_MS;
    if (e.reason !== "answer" || busy) {
      await $.state.set(CARRY, true);
      return ran;
    }
    if (review) $.ui.status(undefined);

    const { value: carry } = await $.state.get(CARRY);
    const { value: own } = await $.state.get(OWN_TURN);
    const out = await runSweep($, ["sweep", "--json"]);
    await $.state.set(CARRY, false);
    if (own && !carry) return ran;
    if (!out) return ran;

    const found = JSON.parse(out) as Found;
    if (found.note) $.ui.toast(found.note);
    if (!found.report) return ran;

    const spawned = await $.agent.spawn({
      subagentType: AGENT,
      prompt: reviewTask(found.report),
      description: "review added comments",
    });
    if (spawned.deny !== undefined) {
      $.ui.toast(`${MARK}: could not start: ${spawned.deny}`);
      return ran;
    }
    await $.state.set(REVIEW, { since: await $.clock.now() });
    $.ui.toast(`${MARK}: reviewing ${found.blocks} comment block(s)`);
    $.ui.status(`${MARK}: reviewing ${found.blocks} comment block(s)…`);
    return ran;
  });
};
