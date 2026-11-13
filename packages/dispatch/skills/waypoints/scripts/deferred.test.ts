import { describe, expect, test } from "bun:test";
import { appendDeferred, legOf, parseDeferred } from "./deferred";

const ITEM = {
  criterion: "p95 latency under 200ms",
  from: "tasks/api/02-search.md",
  date: "2026-07-04",
  why: "needs the index from the next leg",
};

describe("deferred file", () => {
  test("parseDeferred round-trips appendDeferred", () => {
    const md = appendDeferred(null, "02-profile", [
      ITEM,
      { ...ITEM, criterion: "second one", why: "later" },
    ]);

    expect(md).toContain("# Deferred criteria — 02-profile");
    expect(parseDeferred(md)).toEqual([
      ITEM,
      { ...ITEM, criterion: "second one", why: "later" },
    ]);
  });

  test("appendDeferred keeps existing items", () => {
    const first = appendDeferred(null, "02-profile", [ITEM]);
    const second = appendDeferred(first, "02-profile", [
      { ...ITEM, criterion: "another" },
    ]);

    expect(parseDeferred(second).map((item) => item.criterion)).toEqual([
      ITEM.criterion,
      "another",
    ]);
    expect(second.match(/^# Deferred criteria/gm)).toHaveLength(1);
  });

  test("parseDeferred of an empty file is empty", () => {
    expect(parseDeferred("")).toEqual([]);
  });

  test("legOf matches a leg plan path", () => {
    expect(legOf("docs/demo/legs/02-profile/PLAN.md")).toEqual({
      proj: "demo",
      slug: "02-profile",
    });
    expect(legOf("/abs/docs/demo/legs/02-profile/PLAN.md")).toEqual({
      proj: "demo",
      slug: "02-profile",
    });
    expect(legOf("docs/x/PLAN.md")).toBeNull();
  });
});
