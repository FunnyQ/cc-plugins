import { describe, expect, it } from "bun:test";
import { assessComplexity, buildReminder, decideNudge } from "./scribe-nudge";

describe("assessComplexity", () => {
  it("counts files and added+deleted lines", () => {
    const c = assessComplexity("3\t1\tfoo.ts\n10\t2\tbar.ts");
    expect(c.files).toBe(2);
    expect(c.lines).toBe(16);
  });

  it("treats binary '-' columns as a touched file with no line delta", () => {
    const c = assessComplexity("-\t-\timage.png");
    expect(c.files).toBe(1);
    expect(c.lines).toBe(0);
  });

  it("ignores blank lines and empty input", () => {
    expect(assessComplexity("").files).toBe(0);
    expect(assessComplexity("\n\n").files).toBe(0);
  });

  it("flags structural when files >= threshold", () => {
    expect(assessComplexity("1\t0\ta\n1\t0\tb\n1\t0\tc").structural).toBe(true);
  });

  it("flags structural when lines >= threshold even with one file", () => {
    expect(assessComplexity("90\t0\tbig.ts").structural).toBe(true);
  });

  it("is not structural for a small single-file edit", () => {
    expect(assessComplexity("2\t1\tsmall.ts").structural).toBe(false);
  });

  it("counts untracked files from porcelain (which git diff HEAD omits)", () => {
    const c = assessComplexity(
      "2\t1\tsmall.ts",
      "?? a.ts\n?? b.ts\n M small.ts",
    );
    expect(c.files).toBe(3); // 1 tracked + 2 untracked; ` M` is already in numstat
    expect(c.structural).toBe(true);
  });
});

describe("decideNudge", () => {
  const base = {
    now: 1_000_000,
    currentSig: "abc",
    lastSig: null,
    lastNudgeMs: null,
  };

  it("nudges on a fresh change with no prior nudge", () => {
    expect(decideNudge(base)).toBe(true);
  });

  it("does not nudge when there is no detectable change", () => {
    expect(decideNudge({ ...base, currentSig: "" })).toBe(false);
  });

  it("does not re-nudge for the same code-state", () => {
    expect(decideNudge({ ...base, lastSig: "abc", lastNudgeMs: 0 })).toBe(
      false,
    );
  });

  it("does not nudge within the throttle window even if the state changed", () => {
    expect(
      decideNudge({
        now: 1_000_000,
        currentSig: "new",
        lastSig: "old",
        lastNudgeMs: 1_000_000 - 60_000,
        throttleMs: 8 * 60_000,
      }),
    ).toBe(false);
  });

  it("nudges once the throttle window has elapsed and the state changed", () => {
    expect(
      decideNudge({
        now: 1_000_000,
        currentSig: "new",
        lastSig: "old",
        lastNudgeMs: 1_000_000 - 9 * 60_000,
        throttleMs: 8 * 60_000,
      }),
    ).toBe(true);
  });
});

describe("buildReminder", () => {
  it("returns the base reminder for non-structural changes", () => {
    const msg = buildReminder({ files: 1, lines: 4, structural: false });
    expect(msg).toContain("DECISION LOG");
    expect(msg).toContain('subagent_type: "fork"');
    expect(msg).not.toContain("--diagram");
  });

  it("prepends a diagram emphasis with the change size for structural changes", () => {
    const msg = buildReminder({ files: 5, lines: 200, structural: true });
    expect(msg).toContain("--diagram");
    expect(msg).toContain("5 files");
    expect(msg).toContain("200");
    // The base reminder is still present after the lead-in.
    expect(msg).toContain("DECISION LOG");
  });
});
