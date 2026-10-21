import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Call = { prompt: string; opts: Record<string, unknown> };

const body = readFileSync(
  join(import.meta.dir, "reap.workflow.js"),
  "utf8",
).replace(/^export const meta = \{[\s\S]*?\n\}\n/, "");
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

async function run(
  args: Record<string, unknown>,
  answer: (c: Call) => unknown,
): Promise<{ calls: Call[]; result: Record<string, unknown> }> {
  const calls: Call[] = [];
  const agent = async (prompt: string, opts: Record<string, unknown>) => {
    const call = { prompt, opts };
    calls.push(call);
    return answer(call);
  };
  const pipeline = (
    items: unknown[],
    ...stages: ((prev: unknown, item: unknown, i: number) => unknown)[]
  ) =>
    Promise.all(
      items.map(async (item, i) => {
        let prev: unknown = item;
        for (const stage of stages) prev = await stage(prev, item, i);
        return prev;
      }),
    );
  const result = await new AsyncFunction("args", "agent", "pipeline", body)(
    args,
    agent,
    pipeline,
  );
  return { calls, result };
}

const ARGS = {
  root: "/repo",
  dir: "/tmp/q-lab/guard/comments-reaper/scan-Ab12",
  shards: 2,
  skillDir: "/skill",
  flightlog: "/dispatch/flightlog.ts",
  deck: "/data/q-lab/flightdeck/comments-reaper-scan-Ab12",
};

test("each prompt carries the flightdeck join key and the run id at a boundary", async () => {
  const { calls } = await run(ARGS, (c) =>
    c.opts.schema &&
    "mustKill" in (c.opts.schema as { properties: object }).properties
      ? { delete: 1, mustKill: 0 }
      : { deleted: 1, fixed: 0, rejected: 0, open: [] },
  );
  const review = calls.find((c) => c.opts.label === "verify:shard/02#1")!;
  expect(review.prompt).toContain("--task shard/02 --role verify --attempt 1");
  expect(review.prompt).toMatch(/identifier is scan-Ab12 /);
  expect(review.prompt).toContain(`${ARGS.deck}/.flightlog/run.jsonl`);
  expect(review.opts.agentType).toBe("guard:comments-reaper");
  const fix = calls.find((c) => c.opts.label === "fix:shard/02#1")!;
  expect(fix.prompt).toContain("--task shard/02 --role fix --attempt 1");
  expect(fix.opts).toMatchObject({ model: "opus", effort: "low" });
});

test("an applier marks its shard done even with open MUST KILLs, since the result lists them", async () => {
  const { calls } = await run(ARGS, (c) =>
    String(c.opts.label).startsWith("verify")
      ? { delete: 0, mustKill: 1 }
      : { deleted: 0, fixed: 0, rejected: 0, open: ["x"] },
  );
  const fix = calls.find((c) => c.opts.label === "fix:shard/01#1")!;
  expect(fix.prompt).toContain("--state done");
  expect(fix.prompt).not.toContain("--state blocked");
});

test("a shard with nothing to delete or kill spawns no applier", async () => {
  const { calls, result } = await run(ARGS, () => ({ delete: 0, mustKill: 0 }));
  expect(calls.map((c) => c.opts.label)).toEqual([
    "verify:shard/01#1",
    "verify:shard/02#1",
  ]);
  expect(result).toEqual({
    failed: 0,
    deleted: 0,
    fixed: 0,
    rejected: 0,
    open: [],
  });
});

test("a reviewer that dies gets one respawn, then its shard counts as failed", async () => {
  const { calls, result } = await run({ ...ARGS, shards: 1 }, () => null);
  expect(calls).toHaveLength(2);
  expect(result.failed).toBe(1);
});

test("without dispatch the prompts carry no Bash at all", async () => {
  const { calls } = await run({ ...ARGS, flightlog: null, deck: null }, () => ({
    delete: 0,
    mustKill: 0,
  }));
  expect(calls[0].prompt).not.toContain("Bash");
});

test("open MUST KILLs from every shard reach the result", async () => {
  const { result } = await run(ARGS, (c) =>
    String(c.opts.label).startsWith("verify")
      ? { delete: 0, mustKill: 1 }
      : { deleted: 0, fixed: 0, rejected: 0, open: [`${c.opts.label} open`] },
  );
  expect(result.open).toEqual(["fix:shard/01#1 open", "fix:shard/02#1 open"]);
});
