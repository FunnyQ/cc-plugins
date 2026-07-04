import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  advanceRoadmap,
  assertSingleActive,
  draftOutcome,
  formatActive,
  parseRoadmap,
  planLegScaffold,
  serializeRoadmap,
  validateBucket,
  validateLegSlug,
} from "./waypoints";

const SCRIPT_PATH = new URL("./waypoints.ts", import.meta.url).pathname;

const SAMPLE = `# MyApp — Waypoints

> Rolling-wave roadmap. One leg planned in detail at a time.
> Status: [x] done · [~] active (exactly one) · [ ] pending

## Legs

- [x] 1. Multi-factor auth — users can sign up / sign in with email
      → legs/01-auth/ · landed 2026-07-01 · outcome: also added rate-limiting
- [~] 2. Session & profile — a logged-in user has a profile page
      → legs/02-profile/
- [ ] 3. Billing — paid plans via Stripe
      → legs/03-billing/
`;

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("parseRoadmap", () => {
  test("parses all status glyphs and leg fields", () => {
    const roadmap = parseRoadmap(SAMPLE);

    expect(roadmap.title).toBe("MyApp — Waypoints");
    expect(roadmap.legs).toHaveLength(3);
    expect(roadmap.legs.map((leg) => leg.status)).toEqual([
      "done",
      "active",
      "pending",
    ]);
    expect(roadmap.legs[0]).toEqual({
      num: 1,
      nn: "01",
      slug: "01-auth",
      status: "done",
      title: "Multi-factor auth",
      doneState: "users can sign up / sign in with email",
      landedDate: "2026-07-01",
      outcome: "also added rate-limiting",
    });
  });

  test("throws when a leg is missing its pointer", () => {
    expect(() =>
      parseRoadmap(`# Demo — Waypoints

## Legs

- [~] 1. Auth — users can sign in
`),
    ).toThrow(/missing.*pointer/i);
  });

  test("splits only on the padded em dash", () => {
    const roadmap = parseRoadmap(SAMPLE);

    expect(roadmap.legs[0].title).toBe("Multi-factor auth");
    expect(roadmap.legs[0].doneState).toBe(
      "users can sign up / sign in with email",
    );
  });

  test("prefers list number when pointer NN disagrees", () => {
    const roadmap = parseRoadmap(`# Demo — Waypoints

## Legs

- [~] 1. Auth — users can sign in
      → legs/99-auth/
`);

    expect(roadmap.legs[0].nn).toBe("01");
    expect(roadmap.legs[0].slug).toBe("01-auth");
  });
});

describe("serializeRoadmap", () => {
  test("round-trips without losing titles or done states", () => {
    const roadmap = parseRoadmap(SAMPLE);
    const serialized = serializeRoadmap(roadmap);
    const reparsed = parseRoadmap(serialized);

    expect(reparsed).toEqual(roadmap);
    expect(serialized).toContain(
      "- [x] 1. Multi-factor auth — users can sign up / sign in with email",
    );
    expect(serialized).toContain(
      "- [~] 2. Session & profile — a logged-in user has a profile page",
    );
  });
});

describe("assertSingleActive", () => {
  test("accepts zero active legs", () => {
    expect(() =>
      assertSingleActive({
        title: "Done",
        legs: [
          {
            num: 1,
            nn: "01",
            slug: "01-auth",
            status: "done",
            title: "Auth",
            doneState: "users can sign in",
          },
        ],
      }),
    ).not.toThrow();
  });

  test("throws on multiple active legs", () => {
    const roadmap = parseRoadmap(SAMPLE);
    roadmap.legs[2].status = "active";

    expect(() => assertSingleActive(roadmap)).toThrow(/multiple active/i);
  });
});

describe("formatActive", () => {
  test("prints active leg and prior landed legs", () => {
    const roadmap = parseRoadmap(SAMPLE);

    expect(
      formatActive(roadmap, {
        "01-auth": "Build auth primitives for users.",
      }),
    ).toBe(`ACTIVE: 02-profile
DONE-STATE: a logged-in user has a profile page
PRIOR LANDED LEGS:
- 01-auth — users can sign up / sign in with email
  outcome: also added rate-limiting
  goal: Build auth primitives for users.`);
  });

  test("distinguishes complete roadmaps from unstarted roadmaps", () => {
    const complete = parseRoadmap(SAMPLE);
    complete.legs[1].status = "done";
    complete.legs[2].status = "done";

    expect(() => formatActive(complete, {})).toThrow(/roadmap complete/i);

    const unstarted = parseRoadmap(SAMPLE);
    unstarted.legs[1].status = "pending";

    expect(() => formatActive(unstarted, {})).toThrow(/mark one pending/i);
  });
});

describe("draftOutcome", () => {
  test("uses first narrative line under final review", () => {
    expect(
      draftOutcome(
        `## Work
Earlier entry.

## Final review

### Verdict
**All tasks passed;** added \`rate-limiting\`.
`,
        "Ignored fallback.",
      ),
    ).toBe("All tasks passed; added rate-limiting.");
  });

  test("falls back to last non-heading runlog line", () => {
    expect(
      draftOutcome(
        `# Runlog

Started implementation.

## Notes
- Finished profile polish with   extra   spaces.
`,
        "Ignored fallback.",
      ),
    ).toBe("Finished profile polish with extra spaces.");
  });

  test("falls back to first plan sentence", () => {
    expect(
      draftOutcome("", "Auth foundation: email sign-up/sign-in. Later."),
    ).toBe("planned: Auth foundation: email sign-up/sign-in.");
  });

  test("falls back to no-summary literal", () => {
    expect(draftOutcome("", "")).toBe("landed (no RUNLOG summary available)");
  });

  test("collapses whitespace, strips markdown, and truncates to 120 chars", () => {
    expect(
      draftOutcome(
        [
          "## Final review",
          "[Result](https://example.com): **" +
            "a".repeat(140) +
            "** completed",
        ].join("\n"),
        "",
      ),
    ).toBe(`Result: ${"a".repeat(112)}`);
  });
});

describe("advanceRoadmap", () => {
  test("lands active leg and promotes next pending leg", () => {
    const roadmap = parseRoadmap(SAMPLE);
    const advanced = advanceRoadmap(
      roadmap,
      "Profile shipped with audit trail.",
      "2026-07-04",
    );

    expect(advanced.legs.map((leg) => leg.status)).toEqual([
      "done",
      "done",
      "active",
    ]);
    expect(advanced.legs[1]).toMatchObject({
      status: "done",
      landedDate: "2026-07-04",
      outcome: "Profile shipped with audit trail.",
    });
    expect(advanced.legs[2].status).toBe("active");
  });

  test("lands active leg without promoting when no pending leg remains", () => {
    const roadmap = parseRoadmap(SAMPLE);
    roadmap.legs[2].status = "done";

    const advanced = advanceRoadmap(roadmap, "Final leg landed.", "2026-07-04");

    expect(advanced.legs.map((leg) => leg.status)).toEqual([
      "done",
      "done",
      "done",
    ]);
    expect(advanced.legs[1]).toMatchObject({
      landedDate: "2026-07-04",
      outcome: "Final leg landed.",
    });
  });

  test("round-trips through serialization without losing titles or metadata", () => {
    const roadmap = parseRoadmap(SAMPLE);
    const advanced = advanceRoadmap(roadmap, "Profile shipped.", "2026-07-04");
    const reparsed = parseRoadmap(serializeRoadmap(advanced));

    expect(reparsed).toEqual(advanced);
    expect(reparsed.legs[0]).toMatchObject({
      title: "Multi-factor auth",
      outcome: "also added rate-limiting",
    });
    expect(reparsed.legs[1]).toMatchObject({
      title: "Session & profile",
      landedDate: "2026-07-04",
      outcome: "Profile shipped.",
    });
  });

  test("does not mutate the input roadmap", () => {
    const roadmap = parseRoadmap(SAMPLE);
    const before = structuredClone(roadmap);

    advanceRoadmap(roadmap, "Profile shipped.", "2026-07-04");

    expect(roadmap).toEqual(before);
  });
});

describe("advance CLI", () => {
  test("complete roadmap exits non-zero without writing", async () => {
    const dir = await writeProject("complete", completeRoadmap());
    const before = await readFile(
      join(dir, "docs", "complete", "WAYPOINTS.md"),
      "utf-8",
    );

    const result = await runWaypoints(dir, [
      "advance",
      "complete",
      "--outcome",
      "Done.",
      "--date",
      "2026-07-04",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("roadmap complete");
    expect(
      await readFile(join(dir, "docs", "complete", "WAYPOINTS.md"), "utf-8"),
    ).toBe(before);
  });

  test("unstarted roadmap exits non-zero without writing", async () => {
    const dir = await writeProject("unstarted", unstartedRoadmap());
    const before = await readFile(
      join(dir, "docs", "unstarted", "WAYPOINTS.md"),
      "utf-8",
    );

    const result = await runWaypoints(dir, [
      "advance",
      "unstarted",
      "--outcome",
      "Done.",
      "--date",
      "2026-07-04",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("mark one pending");
    expect(
      await readFile(join(dir, "docs", "unstarted", "WAYPOINTS.md"), "utf-8"),
    ).toBe(before);
  });

  test("bare advance previews the drafted outcome without writing", async () => {
    const dir = await writeProject("demo", SAMPLE, {
      runlog: "## Final review\nAll tasks passed.\n",
      plan: "## Overview\nProfile work.\n",
    });
    const before = await readFile(
      join(dir, "docs", "demo", "WAYPOINTS.md"),
      "utf-8",
    );

    const result = await runWaypoints(dir, ["advance", "demo"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("DRAFT OUTCOME: All tasks passed.");
    expect(
      await readFile(join(dir, "docs", "demo", "WAYPOINTS.md"), "utf-8"),
    ).toBe(before);
  });

  test("dry-run previews without writing even when outcome is supplied", async () => {
    const dir = await writeProject("demo", SAMPLE, {
      runlog: "## Final review\nAll tasks passed.\n",
    });
    const before = await readFile(
      join(dir, "docs", "demo", "WAYPOINTS.md"),
      "utf-8",
    );

    const result = await runWaypoints(dir, [
      "advance",
      "demo",
      "--dry-run",
      "--outcome",
      "Confirmed.",
      "--date",
      "2026-07-04",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("DRAFT OUTCOME: All tasks passed.");
    expect(
      await readFile(join(dir, "docs", "demo", "WAYPOINTS.md"), "utf-8"),
    ).toBe(before);
  });

  test("outcome writes transition with supplied date", async () => {
    const dir = await writeProject("demo", SAMPLE);

    const result = await runWaypoints(dir, [
      "advance",
      "demo",
      "--outcome",
      "Profile shipped.",
      "--date",
      "2026-07-04",
    ]);
    const roadmap = parseRoadmap(
      await readFile(join(dir, "docs", "demo", "WAYPOINTS.md"), "utf-8"),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "Landed 02-profile, promoting 03-billing to active.",
    );
    expect(roadmap.legs.map((leg) => leg.status)).toEqual([
      "done",
      "done",
      "active",
    ]);
    expect(roadmap.legs[1]).toMatchObject({
      landedDate: "2026-07-04",
      outcome: "Profile shipped.",
    });
  });
});

describe("validation", () => {
  test("accepts valid leg slugs and buckets", () => {
    expect(() => validateLegSlug("01-auth")).not.toThrow();
    expect(() => validateLegSlug("12-profile2")).not.toThrow();
    expect(() => validateBucket("work")).not.toThrow();
    expect(() => validateBucket("review2")).not.toThrow();
  });

  test("rejects invalid leg slugs and dashed buckets", () => {
    expect(() => validateLegSlug("1-auth")).toThrow(/NN-slug/);
    expect(() => validateLegSlug("01-1auth")).toThrow(/NN-slug/);
    expect(() => validateLegSlug("01-auth/extra")).toThrow(/NN-slug/);
    expect(() => validateBucket("my-bucket")).toThrow(/bucket/);
    expect(() => validateBucket("1work")).toThrow(/bucket/);
  });
});

describe("planLegScaffold", () => {
  test("plans leg task directories", () => {
    const result = planLegScaffold({
      proj: "demo",
      nnSlug: "01-auth",
      buckets: ["work", "review"],
      docsRoot: "docs",
    });

    expect(result.legDir).toBe(join("docs", "demo/legs/01-auth"));
    expect(result.createdDirs).toEqual([
      join("docs", "demo/legs/01-auth"),
      join("docs", "demo/legs/01-auth/tasks"),
      join("docs", "demo/legs/01-auth/tasks/_context"),
      join("docs", "demo/legs/01-auth/tasks/work"),
      join("docs", "demo/legs/01-auth/tasks/review"),
    ]);
  });

  test("validates before planning directories", () => {
    expect(() =>
      planLegScaffold({
        proj: "demo",
        nnSlug: "01-auth",
        buckets: ["bad-bucket"],
        docsRoot: "docs",
      }),
    ).toThrow(/bucket/);
  });
});

function completeRoadmap(): string {
  return SAMPLE.replace("- [~] 2.", "- [x] 2.").replace("- [ ] 3.", "- [x] 3.");
}

function unstartedRoadmap(): string {
  return SAMPLE.replace("- [~] 2.", "- [ ] 2.");
}

async function writeProject(
  proj: string,
  waypoints: string,
  activeFiles: { runlog?: string; plan?: string } = {},
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "waypoints-test-"));
  tempDirs.push(dir);
  const projectDir = join(dir, "docs", proj);
  const activeDir = join(projectDir, "legs", "02-profile");
  await mkdir(join(activeDir, ".flightlog"), { recursive: true });
  await writeFile(join(projectDir, "WAYPOINTS.md"), waypoints);
  if (activeFiles.runlog) {
    await writeFile(
      join(activeDir, ".flightlog", "RUNLOG.md"),
      activeFiles.runlog,
    );
  }
  if (activeFiles.plan) {
    await writeFile(join(activeDir, "PLAN.md"), activeFiles.plan);
  }
  return dir;
}

async function runWaypoints(
  cwd: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", SCRIPT_PATH, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}
