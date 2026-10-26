import { expect, test } from "claude-code/testing";
import type { ModelUsage } from "claude-code";

import type { ExplainEntry, ExplainView } from "../../types";
import {
  MAX_ENTRIES,
  patchEntry,
  selectedOf,
  usageOf,
  withEntry,
} from "./state";

const text = (id: string): ExplainEntry => ({
  id,
  at: 1,
  title: id,
  kind: "text",
  body: id,
});
const empty: ExplainView = { entries: [], isRunning: false };

test("withEntry puts the new entry first and selects it", () => {
  const v = withEntry(withEntry(empty, text("a")), text("b"));
  expect(v.entries.map((e) => e.id)).toEqual(["b", "a"]);
  expect(v.selected).toBe("b");
});

test("withEntry caps at 12, drops the oldest, and keeps isRunning and error", () => {
  const entries = Array.from({ length: MAX_ENTRIES }, (_, i) => text(`e${i}`));
  const v = withEntry({ entries, isRunning: true, error: "boom" }, text("new"));
  expect(v.entries).toHaveLength(12);
  expect(v.entries[0]!.id).toBe("new");
  expect(v.entries.map((e) => e.id)).not.toContain("e11");
  expect(v.isRunning).toBe(true);
  expect(v.error).toBe("boom");
});

test("patchEntry changes only the matching entry, and an unknown id changes nothing", () => {
  const html: ExplainEntry = {
    id: "h",
    at: 2,
    title: "h",
    kind: "html",
    summary: "s",
    path: "/p",
    check: "pending",
  };
  const v: ExplainView = { entries: [html, text("t")], isRunning: false };
  const out = patchEntry(v, "h", {
    check: "ok",
    note: "fine",
  } as Partial<ExplainEntry>);
  expect(out.entries[0]).toEqual({ ...html, check: "ok", note: "fine" });
  expect(out.entries[1]).toEqual(text("t"));
  expect(patchEntry(v, "nope", { title: "x" }).entries).toEqual(v.entries);
});

test("selectedOf returns the selected entry, falls back to the newest, and is undefined when empty", () => {
  const v: ExplainView = { entries: [text("a"), text("b")], isRunning: false };
  expect(selectedOf({ ...v, selected: "b" })!.id).toBe("b");
  expect(selectedOf(v)!.id).toBe("a");
  expect(selectedOf({ ...v, selected: "gone" })!.id).toBe("a");
  expect(selectedOf(empty)).toBeUndefined();
});

test("usageOf folds cache creation into input", () => {
  const u = {
    input_tokens: 10,
    cache_creation_input_tokens: 5,
    cache_read_input_tokens: 100,
    output_tokens: 7,
  } as ModelUsage;
  expect(usageOf(u)).toEqual({ input: 15, cacheRead: 100, output: 7 });
});
