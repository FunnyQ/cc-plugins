import { describe, expect, test } from "bun:test";
import {
  FLIGHT_REPAIR_CAP,
  TASK_REPAIR_CAP,
  admitRepair,
  currentFlight,
  flightStatus,
  goalHash,
  goalSection,
  guardRepair,
  renderFlightReport,
  repairCounts,
  type GuardInput,
} from "./goal-mode";
import type { FlightlogEntry, RepairVerdict } from "./flightlog";
import { parseTask, type ParsedTask } from "./parse-task";

let clock = 0;
const ts = () => new Date(1_700_000_000_000 + clock++ * 1000).toISOString();

const flight = (goal = "g"): FlightlogEntry => ({
  kind: "flight",
  ts: ts(),
  task: "(flight)",
  goalHash: goal,
  planPath: "docs/x/PLAN.md",
});

const repair = (
  task: string,
  verdict: RepairVerdict,
  extra: Partial<Extract<FlightlogEntry, { kind: "repair" }>> = {},
): FlightlogEntry => ({
  kind: "repair",
  ts: ts(),
  task,
  verdict,
  reason: `${verdict} reason`,
  ...extra,
});

const escalation = (
  task: string,
  reason = "capped at 3",
  cls: Extract<FlightlogEntry, { kind: "escalation" }>["class"] = "capped",
): FlightlogEntry => ({
  kind: "escalation",
  ts: ts(),
  task,
  attempt: 3,
  class: cls,
  infrastructure: false,
  parked: true,
  reason,
});

const runEnd = (
  extra: Partial<Extract<FlightlogEntry, { kind: "run-end" }>> = {},
): FlightlogEntry => ({
  kind: "run-end",
  ts: ts(),
  task: "(flight)",
  aborted: false,
  completed: [],
  drained: [],
  needsHuman: [],
  ...extra,
});

const score = (task: string, passed: boolean): FlightlogEntry => ({
  kind: "score",
  ts: ts(),
  task,
  attempt: 1,
  weighted: passed ? 4.5 : 2.25,
  passed,
  hardFailed: false,
  missing: [],
  threshold: 4,
  passOp: ">",
  breakdown: [],
});

type FileOpts = {
  status?: string;
  dependsOn?: string;
  scope?: string;
  acceptance?: string[];
  verification?: string[];
  rubric?: string;
};

const taskFile = (ref: string, opts: FileOpts = {}): string => {
  const [bucket, nn] = ref.split("/");
  return [
    `# ${bucket.toUpperCase()}-${nn}: Task ${ref}`,
    "",
    `> **Status**: ${opts.status ?? "todo"}`,
    `> **Depends on**: ${opts.dependsOn ?? "none"}`,
    "",
    "## Scope",
    "",
    opts.scope ?? "Build the thing.",
    "",
    "## Acceptance criteria",
    "",
    ...(opts.acceptance ?? ["- [ ] it works", "- [ ] it is fast"]),
    "",
    "## Verification",
    "",
    ...(opts.verification ?? ["- [ ] `bun test` passes"]),
    "",
    "## Eval rubric",
    "",
    opts.rubric ?? "> Pass when weighted score > 4.",
    "",
  ].join("\n");
};

const tree = (specs: Record<string, FileOpts>): Record<string, ParsedTask> => {
  const out: Record<string, ParsedTask> = {};
  for (const [ref, opts] of Object.entries(specs)) {
    const parsed = parseTask(taskFile(ref, opts));
    if (!parsed.ok) throw new Error(parsed.reason);
    out[ref] = parsed.task;
  }
  return out;
};

const PLAN = [
  "# Plan",
  "",
  "## Goals",
  "",
  "- Ship goal mode.",
  "",
  "## Requirements",
  "",
  "- Be pure.",
  "",
].join("\n");

describe("goalSection", () => {
  test("returns the body of ## Goals", () => {
    expect(goalSection(PLAN)).toBe("\n- Ship goal mode.\n");
  });

  test("accepts a singular ## Goal heading", () => {
    expect(goalSection("# P\n\n## Goal\n\nOne.\n")).toBe("\nOne.\n");
  });

  test("returns an empty string without a goal section", () => {
    expect(goalSection("# P\n\n## Requirements\n\nx\n")).toBe("");
  });
});

describe("goalHash", () => {
  test("is the sha256 hex of the goal section", () => {
    const expected = new Bun.CryptoHasher("sha256")
      .update(goalSection(PLAN))
      .digest("hex");
    expect(goalHash(PLAN)).toBe(expected);
  });

  test("goalHash ignores edits outside the Goals section", () => {
    const edited = PLAN.replace("- Be pure.", "- Be very pure.");
    expect(goalHash(edited)).toBe(goalHash(PLAN));
    expect(goalHash(PLAN.replace("Ship", "Drop"))).not.toBe(goalHash(PLAN));
  });
});

describe("currentFlight", () => {
  test("returns null without a flight entry", () => {
    expect(currentFlight([escalation("ui/01")])).toBeNull();
  });

  test("returns the last flight and only the entries after it", () => {
    const first = flight("a");
    const old = repair("ui/01", "fix");
    const last = flight("b");
    const fresh = repair("ui/02", "fix");
    expect(currentFlight([first, old, last, fresh])).toEqual({
      flight: last as Extract<FlightlogEntry, { kind: "flight" }>,
      entries: [fresh],
    });
  });
});

describe("repairCounts", () => {
  test("counts fix, defer, not-plan and infra-retry, never refuse or halt", () => {
    const entries = [
      repair("ui/01", "fix"),
      repair("ui/01", "not-plan"),
      repair("ui/02", "infra-retry"),
      repair("ui/02", "defer"),
      repair("ui/03", "refuse"),
      repair("ui/03", "halt"),
      repair("(flight)", "halt"),
      escalation("ui/04"),
    ];
    expect(repairCounts(entries)).toEqual({
      flight: 4,
      byTask: { "ui/01": 2, "ui/02": 2 },
    });
  });
});

describe("flightStatus", () => {
  test("returns complete when every task is done", () => {
    const tasks = tree({
      "ui/01": { status: "done", acceptance: ["- [x] it works"] },
    });
    expect(flightStatus([], tasks)).toBe("complete");
  });

  test("returns continue for a ready todo task", () => {
    expect(flightStatus([], tree({ "ui/01": {} }))).toBe("continue");
  });

  test("returns continue for an in-progress task", () => {
    expect(flightStatus([], tree({ "ui/01": { status: "in-progress" } }))).toBe(
      "continue",
    );
  });

  test("flightStatus returns continue for a blocked task with 2 repairs and exhausted with 3", () => {
    const tasks = tree({ "ui/01": { status: "blocked" } });
    const two = [repair("ui/01", "fix"), repair("ui/01", "not-plan")];
    expect(flightStatus(two, tasks)).toBe("continue");
    const three = [...two, repair("ui/01", "fix")];
    expect(three.length).toBe(TASK_REPAIR_CAP);
    expect(flightStatus(three, tasks)).toBe("exhausted");
  });

  test("a blocked task with a refuse or halt repair is not repairable", () => {
    const tasks = tree({ "ui/01": { status: "blocked" } });
    expect(flightStatus([repair("ui/01", "refuse")], tasks)).toBe("exhausted");
    expect(flightStatus([repair("ui/01", "halt")], tasks)).toBe("exhausted");
  });

  test("flightStatus ignores a todo task whose dependency was refused", () => {
    const tasks = tree({
      "ui/01": { status: "blocked" },
      "ui/02": { dependsOn: "ui/01" },
    });
    expect(flightStatus([repair("ui/01", "refuse")], tasks)).toBe("exhausted");
  });

  test("a flight halt exhausts the flight even with ready work", () => {
    expect(
      flightStatus([repair("(flight)", "halt")], tree({ "ui/01": {} })),
    ).toBe("exhausted");
  });

  test("reaching the flight cap exhausts the flight even with ready work", () => {
    const entries = Array.from({ length: FLIGHT_REPAIR_CAP }, (_, i) =>
      repair(`ui/${String(i + 10)}`, "fix"),
    );
    expect(flightStatus(entries, tree({ "ui/01": {} }))).toBe("exhausted");
  });
});

describe("admitRepair", () => {
  test("admits a first fix", () => {
    expect(admitRepair([], "ui/01", "fix")).toEqual({ ok: true });
  });

  test("refuses a counted verdict once the task cap is reached", () => {
    const entries = Array.from({ length: TASK_REPAIR_CAP }, () =>
      repair("ui/01", "fix"),
    );
    const result = admitRepair(entries, "ui/01", "fix");
    expect(result.ok).toBe(false);
    expect(admitRepair(entries, "ui/01", "refuse")).toEqual({ ok: true });
  });

  test("refuses a counted verdict once the flight cap is reached", () => {
    const entries = Array.from({ length: FLIGHT_REPAIR_CAP }, (_, i) =>
      repair(`ui/${String(i + 10)}`, "fix"),
    );
    expect(admitRepair(entries, "ui/01", "infra-retry").ok).toBe(false);
    expect(admitRepair(entries, "ui/01", "halt")).toEqual({ ok: true });
  });

  test("refuses a second not-plan for the same task", () => {
    const result = admitRepair(
      [repair("ui/01", "not-plan")],
      "ui/01",
      "not-plan",
    );
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("record refuse instead"),
    });
    expect(
      admitRepair([repair("ui/02", "not-plan")], "ui/01", "not-plan"),
    ).toEqual({ ok: true });
  });

  test("refuses a second infra-retry for the same task", () => {
    const result = admitRepair(
      [repair("ui/01", "infra-retry")],
      "ui/01",
      "infra-retry",
    );
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("record halt instead"),
    });
  });
});

const guardInput = (over: Partial<GuardInput> = {}): GuardInput => ({
  verdict: "fix",
  isLeg: false,
  flightGoalHash: goalHash(PLAN),
  planMd: PLAN,
  before: {},
  after: {},
  doneRefs: [],
  justified: [],
  kept: ["ui/01"],
  devReportedDefect: [],
  workedRefs: ["ui/01"],
  ...over,
});

describe("guardRepair", () => {
  const before = { "ui/01": taskFile("ui/01", { status: "blocked" }) };
  const verifyEdit = {
    "ui/01": taskFile("ui/01", {
      status: "todo",
      verification: ["- [ ] `bun test lib` passes"],
    }),
  };
  const verifyJustified = [{ task: "ui/01", before: "`bun test` passes" }];

  test("guardRepair: Status line plus Verification change re-enters at verify", () => {
    expect(
      guardRepair(
        guardInput({ before, after: verifyEdit, justified: verifyJustified }),
      ),
    ).toEqual({ ok: true, reentry: { "ui/01": "verify" } });
  });

  test("guardRepair: Status line plus Verification change re-enters at dev when the worktree is not kept", () => {
    expect(
      guardRepair(
        guardInput({
          before,
          after: verifyEdit,
          justified: verifyJustified,
          kept: [],
        }),
      ),
    ).toEqual({ ok: true, reentry: { "ui/01": "dev" } });
  });

  test("re-enters at dev when no dev step completed", () => {
    expect(
      guardRepair(
        guardInput({
          before,
          after: verifyEdit,
          justified: verifyJustified,
          workedRefs: [],
        }),
      ),
    ).toEqual({ ok: true, reentry: { "ui/01": "dev" } });
  });

  test("re-enters at dev when the dev reported the defect", () => {
    expect(
      guardRepair(
        guardInput({
          before,
          after: verifyEdit,
          justified: verifyJustified,
          devReportedDefect: ["ui/01"],
        }),
      ),
    ).toEqual({ ok: true, reentry: { "ui/01": "dev" } });
  });

  test("an Eval rubric change re-enters at verify", () => {
    const after = {
      "ui/01": taskFile("ui/01", { rubric: "> Pass when weighted score > 3." }),
    };
    expect(guardRepair(guardInput({ before, after }))).toEqual({
      ok: true,
      reentry: { "ui/01": "verify" },
    });
  });

  test("guardRepair: a Depends on change re-enters at dev", () => {
    const after = { "ui/01": taskFile("ui/01", { dependsOn: "ui/02" }) };
    expect(guardRepair(guardInput({ before, after }))).toEqual({
      ok: true,
      reentry: { "ui/01": "dev" },
    });
  });

  test("a Scope change re-enters at dev", () => {
    const after = {
      "ui/01": taskFile("ui/01", { scope: "Build it smaller." }),
    };
    expect(guardRepair(guardInput({ before, after }))).toEqual({
      ok: true,
      reentry: { "ui/01": "dev" },
    });
  });

  test("unchanged refs get no re-entry", () => {
    expect(guardRepair(guardInput({ before, after: { ...before } }))).toEqual({
      ok: true,
      reentry: {},
    });
  });

  test("ticking a gate checkbox is not a reworded item", () => {
    const after = {
      "ui/01": taskFile("ui/01", {
        status: "blocked",
        acceptance: ["- [x] it works", "- [ ] it is fast"],
      }),
    };
    expect(guardRepair(guardInput({ before, after })).ok).toBe(true);
  });

  test("rejects a changed goal section", () => {
    const result = guardRepair(guardInput({ flightGoalHash: "stale" }));
    expect(result.ok).toBe(false);
  });

  test("guardRepair rejects an edit to a done task", () => {
    const done = {
      "ui/01": taskFile("ui/01", {
        status: "done",
        acceptance: ["- [x] it works", "- [x] it is fast"],
        verification: ["- [x] `bun test` passes"],
      }),
    };
    const after = {
      "ui/01": done["ui/01"].replace("Build the thing.", "Build less."),
    };
    const result = guardRepair(
      guardInput({ before: done, after, doneRefs: ["ui/01"] }),
    );
    expect(result).toEqual({
      ok: false,
      violations: [expect.stringContaining("ui/01")],
    });
  });

  test("rejects an added (human) tag in a gate item", () => {
    const after = {
      "ui/01": taskFile("ui/01", {
        verification: ["- [ ] `bun test` passes", "- [ ] (human) eyeball it"],
      }),
    };
    const result = guardRepair(guardInput({ before, after }));
    expect(result).toEqual({
      ok: false,
      violations: [expect.stringContaining("(human)")],
    });
  });

  test("allows a justified rewording of an item already tagged (human)", () => {
    const tagged = {
      "ui/01": taskFile("ui/01", {
        verification: ["- [ ] `bun test` passes", "- [ ] (human) eyeball it"],
      }),
    };
    const after = {
      "ui/01": taskFile("ui/01", {
        verification: [
          "- [ ] `bun test` passes",
          "- [ ] (human) eyeball the page",
        ],
      }),
    };
    expect(
      guardRepair(
        guardInput({
          before: tagged,
          after,
          justified: [{ task: "ui/01", before: "(human) eyeball it" }],
        }),
      ),
    ).toEqual({ ok: true, reentry: { "ui/01": "verify" } });
  });

  test("rejects a deleted task", () => {
    expect(guardRepair(guardInput({ before, after: {} }))).toEqual({
      ok: false,
      violations: ["deleted task ui/01"],
    });
  });

  test("rejects a created task", () => {
    expect(guardRepair(guardInput({ before: {}, after: before }))).toEqual({
      ok: false,
      violations: ["created task ui/01"],
    });
  });

  test("rejects a reworded Verification item missing from justified", () => {
    const result = guardRepair(guardInput({ before, after: verifyEdit }));
    expect(result).toEqual({
      ok: false,
      violations: [expect.stringContaining("`bun test` passes")],
    });
  });

  test("rejects a removed Acceptance criteria item missing from justified", () => {
    const after = {
      "ui/01": taskFile("ui/01", {
        acceptance: ["- [ ] it works", "- [ ] it is quick"],
      }),
    };
    const result = guardRepair(guardInput({ before, after }));
    expect(result).toEqual({
      ok: false,
      violations: [expect.stringContaining("it is fast")],
    });
    expect(
      guardRepair(
        guardInput({
          before,
          after,
          justified: [{ task: "ui/01", before: "- [ ] it is fast" }],
        }),
      ).ok,
    ).toBe(true);
  });

  test("rejects a drop in the Acceptance criteria count unless the verdict is defer", () => {
    const after = {
      "ui/01": taskFile("ui/01", { acceptance: ["- [ ] it works"] }),
    };
    const justified = [{ task: "ui/01", before: "it is fast" }];
    const fix = guardRepair(guardInput({ before, after, justified }));
    expect(fix).toEqual({
      ok: false,
      violations: [expect.stringContaining("Acceptance criteria")],
    });
    const defer = guardRepair(
      guardInput({ before, after, justified, verdict: "defer", isLeg: true }),
    );
    expect(defer).toEqual({ ok: true, reentry: { "ui/01": "verify" } });
  });

  test("guardRepair rejects defer outside a leg", () => {
    const result = guardRepair(guardInput({ verdict: "defer", isLeg: false }));
    expect(result).toEqual({
      ok: false,
      violations: [expect.stringContaining("defer")],
    });
  });
});

describe("renderFlightReport", () => {
  const entries: FlightlogEntry[] = [
    escalation("ui/01", "capped at 3 attempts"),
    score("ui/01", true),
    score("ui/01", false),
    repair("ui/01", "fix", {
      pattern: "Verification greps a sibling path",
      diff: "-old\n+new",
    }),
    runEnd({ aborted: true }),
    escalation("ui/02", "PLAN DEFECT reported by dev", "plan-defect"),
    repair("ui/02", "refuse"),
    runEnd({
      completed: ["ui/01"],
      needsHuman: [{ task: "ui/01", criteria: ["looks right"] }],
    }),
  ];

  const tasks = tree({
    "ui/01": {
      status: "done",
      acceptance: ["- [x] it works", "- [x] it is fast"],
      verification: ["- [x] `bun test` passes"],
    },
    "ui/02": { status: "blocked" },
  });

  const report = renderFlightReport(entries, {
    slug: "demo",
    status: "exhausted",
    deferredMd: "- ui/03: moved",
    tasks,
  });

  test("puts the sections in order", () => {
    const order = [
      "# Flight report — demo",
      "exhausted",
      "The goal guard rejects careless gate edits, not deliberate ones; each gate change below was approved by an independent reviewer.",
      "## Deferred criteria",
      "## Error events",
      "## Repairs",
      "## Still parked",
      "## Needs a person",
    ];
    const positions = order.map((s) => report.indexOf(s));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  test("names the repair budget used", () => {
    expect(report).toContain(`repairs used 1/${FLIGHT_REPAIR_CAP}`);
  });

  test("omits Deferred criteria when deferredMd is null", () => {
    const plain = renderFlightReport(entries, {
      slug: "demo",
      status: "complete",
      deferredMd: null,
      tasks,
    });
    expect(plain).not.toContain("## Deferred criteria");
    expect(plain).toContain("complete");
  });

  test("lists escalations, failed scores and aborted run-ends in time order", () => {
    const section = report.slice(
      report.indexOf("## Error events"),
      report.indexOf("## Repairs"),
    );
    const lines = section.split("\n").filter((l) => l.startsWith("- "));
    expect(lines.length).toBe(4);
    expect(lines[0]).toContain("capped at 3 attempts");
    expect(lines[1]).toContain("2.25");
    expect(lines[2]).toContain("aborted");
    expect(lines[3]).toContain("PLAN DEFECT reported by dev");
  });

  test("shows each repair's verdict, pattern, reason and diff", () => {
    const section = report.slice(
      report.indexOf("## Repairs"),
      report.indexOf("## Still parked"),
    );
    expect(section).toContain("fix");
    expect(section).toContain("Verification greps a sibling path");
    expect(section).toContain("fix reason");
    expect(section).toContain("-old\n+new");
    expect(section).toContain("refuse reason");
  });

  test("still parked lists unresolved tasks with their last reason", () => {
    const section = report.slice(
      report.indexOf("## Still parked"),
      report.indexOf("## Needs a person"),
    );
    expect(section).toContain("ui/02");
    expect(section).toContain("refuse reason");
    expect(section).not.toContain("ui/01");
  });

  test("still parked lists a repaired task that never re-flew before a flight halt", () => {
    const halted = renderFlightReport(
      [
        escalation("ui/03", "capped at 3 attempts"),
        repair("ui/03", "fix", { reason: "Verification fixed" }),
        escalation("ui/04", "PLAN DEFECT reported by dev", "plan-defect"),
        repair("(flight)", "halt", { reason: "leak abort" }),
      ],
      {
        slug: "demo",
        status: "exhausted",
        deferredMd: null,
        tasks: tree({ "ui/03": {}, "ui/04": { status: "blocked" } }),
      },
    );
    const section = halted.slice(
      halted.indexOf("## Still parked"),
      halted.indexOf("## Needs a person"),
    );
    expect(section).toContain("- ui/03: Verification fixed");
    expect(section).toContain("- ui/04: PLAN DEFECT reported by dev");
  });

  test("needs a person comes from the last run-end", () => {
    const section = report.slice(report.indexOf("## Needs a person"));
    expect(section).toContain("ui/01");
    expect(section).toContain("looks right");
  });
});
