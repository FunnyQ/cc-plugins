import { expect, test } from "claude-code/testing";

import { layout, tokenize } from "./shell";

const kinds = (line: string) =>
  tokenize(line)
    .filter((t) => t.kind !== "space")
    .map((t) => `${t.kind}:${t.text}`);

test("tokenize names commands, flags, strings, variables and operators", () => {
  expect(
    kinds(`cd a && FOO=1 bun test --x "s p" $HOME | grep -E 'y' # note`),
  ).toEqual([
    "cmd:cd",
    "text:a",
    "op:&&",
    "var:FOO=1",
    "cmd:bun",
    "text:test",
    "flag:--x",
    'str:"s p"',
    "var:$HOME",
    "op:|",
    "cmd:grep",
    "flag:-E",
    "str:'y'",
    "comment:# note",
  ]);
});

test("tokenize keeps an operator inside quotes as part of the string", () => {
  expect(kinds(`echo "a && b" ; ls`)).toEqual([
    "cmd:echo",
    'str:"a && b"',
    "op:;",
    "cmd:ls",
  ]);
});

test("tokenize starts a command after $( and keeps redirections as operators", () => {
  expect(kinds(`echo $(git rev-parse HEAD) 2>&1 > out`)).toEqual([
    "cmd:echo",
    "op:$(",
    "cmd:git",
    "text:rev-parse",
    "text:HEAD",
    "op:)",
    "op:2>&1",
    "op:>",
    "text:out",
  ]);
});

const plain = (lines: ReturnType<typeof layout>) =>
  lines.map((l) => l.map((p) => p.text).join(""));

test("layout leaves a command that fits on one line", () => {
  expect(plain(layout("ls -la && pwd", 40))).toEqual(["$ ls -la && pwd"]);
});

test("layout breaks a long chain before && and |, indented under the $", () => {
  expect(
    plain(
      layout(
        `cd packages/runes && bun test hooks/ --parallel | grep -E "fail"`,
        40,
      ),
    ),
  ).toEqual([
    "$ cd packages/runes",
    "  && bun test hooks/ --parallel",
    '  | grep -E "fail"',
  ]);
});

test("layout hard-wraps a piece still wider than the line", () => {
  expect(plain(layout("echo aaaaaaaaaaaaaaaa", 12))).toEqual([
    "$ echo aaaaa",
    "  aaaaaaaaaa",
    "  a",
  ]);
});

test("layout keeps each source line of a multi-line command", () => {
  expect(plain(layout("a\nb", 40))).toEqual(["$ a", "  b"]);
});
