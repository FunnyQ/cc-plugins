import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  assertSingleActive,
  formatActive,
  parseRoadmap,
  planLegScaffold,
  serializeRoadmap,
  validateBucket,
  validateLegSlug,
} from "./waypoints";

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
