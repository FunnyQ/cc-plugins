import { expect, test } from "claude-code/testing";

import { foldSection, memo } from "./bubble";

test("a memo makes each key once, and one memo never evicts another's", () => {
  const a = memo(1);
  const b = memo(1);
  let made = 0;
  const make = () => ++made;
  a("k", make);
  a("k", make);
  b("j", make);
  expect(made).toBe(2);
  expect(a("k", make)).toBe(1);
});

test("a folded section never calls its body", () => {
  let called = false;
  const rows = foldSection((() => null) as never, {
    key: "s",
    label: "x",
    isOpen: false,
    width: 10,
    onPress: () => {},
    body: () => ((called = true), []),
  });
  expect(rows).toHaveLength(1);
  expect(called).toBe(false);
});
