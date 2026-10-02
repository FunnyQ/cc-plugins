import { expect, test } from "claude-code/testing";

const context = { window: 200_000 } as const;

const runs = (on: Parameters<Parameters<typeof test>[1]>[1]) => {
  const calls: { argv: readonly string[]; stdin?: string }[] = [];
  on("session.measure", (_$, e) => ({ changed: e.changed }));
  on("process.run", (_$, e) => {
    calls.push({ argv: e.argv, stdin: e.init?.stdin });
    return {
      exitCode: 0,
      stdout: "",
      stderr: "",
      isStdoutTruncated: false,
    } as never;
  });
  return calls;
};

test("a measurement reaches `cockpit atlas measure` in the statusline rate_limits shape", async ($, on) => {
  const calls = runs(on);
  await $.session.measure({
    context,
    changed: ["rateLimits"],
    rateLimits: [
      {
        kind: "five_hour",
        percentUsed: 42.5,
        resetsAt: "2026-09-21T14:13:20.000Z",
      },
      { kind: "seven_day", percentUsed: 7 },
    ],
  });
  expect(calls).toHaveLength(1);
  const [bin, ...args] = calls[0].argv;
  expect(bin.endsWith("/skills/cockpit/bin/cockpit")).toBe(true);
  expect(args).toEqual(["atlas", "measure"]);
  expect(JSON.parse(calls[0].stdin!)).toEqual({
    rate_limits: {
      five_hour: { used_percentage: 42.5, resets_at: 1790000000 },
      seven_day: { used_percentage: 7 },
    },
  });
});

test("a measurement with no rate-limit windows still nudges, with no rate_limits key", async ($, on) => {
  const calls = runs(on);
  await $.session.measure({ context, changed: ["context"], rateLimits: [] });
  expect(calls).toHaveLength(1);
  expect(JSON.parse(calls[0].stdin!)).toEqual({});
});
