import { expect, test } from "claude-code/testing";

import { afterCommand, afterOutput, isDenied, scrub } from "./jev";

const kind = (p: Partial<Record<"markdown" | "json" | "diff" | "code" | "plain", number>>) => ({
  markdown: 0, json: 0, diff: 0, code: 0, plain: 0, ...p,
});
const lang = (name: string) => ({ typescript: 0, other: 0, [name]: 1 }) as Record<string, number>;

test("scrub masks the secrets a command or an output sample may carry and leaves the rest", () => {
  const text = [
    "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456' https://api.example.com",
    "key sk-abcdefghijklmnopqrstuvwxyz and ghp_abcdefghijklmnopqrstuvwxyz1234 and AKIAABCDEFGHIJKLMNOP",
    "psql postgres://admin:hunter2hunter2@db.example.com/app",
    "password = correcthorsebattery",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----",
    "plain words and src/app.ts:42 stay",
  ].join("\n");
  const out = scrub(text);
  for (const secret of ["abcdefghijklmnopqrstuvwxyz123456", "sk-abcdef", "ghp_abcdef", "AKIAABCDEF", "hunter2hunter2", "correcthorsebattery", "MIIEabc"])
    expect(out).not.toContain(secret);
  expect(out).toContain("plain words and src/app.ts:42 stay");
  expect(out).toContain("db.example.com");
});

test("isDenied stops the commands that print secrets before anything is sent", () => {
  for (const c of ["env", "printenv", "printenv | grep -i token", "cat .env", "cat ~/.ssh/id_ed25519", "cat ~/.aws/credentials", "gh auth token", "cat ~/.netrc", "cd app && cat .env.local", "cat /proc/self/environ", "security find-generic-password -s x -w", "history | tail"])
    expect([c, isDenied(c)]).toEqual([c, true]);
  for (const c of ["ls -la", "git status", "cat .env.example", "bun test", "env | wc -l", "cat README.md", "grep -rn token src/lexer.ts"])
    expect([c, isDenied(c)]).toEqual([c, false]);
});

test("afterCommand decides alone when the command settles it, and asks for the output otherwise", () => {
  // the rule is on the probability of plain, so the boundary is exact
  const at = (plain: number, risk = 0.1) => afterCommand({ kind: kind({ code: 1 - plain, plain }), language: lang("typescript"), risk });
  expect(at(0.05)).toEqual({ done: true, lang: "typescript" });
  expect(at(0.06)).toEqual({ done: false });
  expect(at(0.5)).toEqual({ done: false });
  expect(at(0.94)).toEqual({ done: false });
  expect(at(0.95)).toEqual({ done: true, lang: undefined });
  // a risky command never gets its output sent, however sure the kind is, and is never asked for its output
  expect(at(0.01, 0.6)).toEqual({ done: true, lang: undefined });
  expect(at(0.01, 0.59)).toEqual({ done: true, lang: "typescript" });
  expect(at(0.5, 0.9)).toEqual({ done: true, lang: undefined });
});

test("afterOutput names the fence for the likeliest non-plain kind, or none", () => {
  expect(afterOutput({ kind: kind({ markdown: 0.8, plain: 0.2 }), language: lang("other") })).toBe("markdown");
  expect(afterOutput({ kind: kind({ json: 0.9, plain: 0.1 }), language: lang("other") })).toBe("json");
  expect(afterOutput({ kind: kind({ diff: 0.9, plain: 0.1 }), language: lang("other") })).toBe("diff");
  expect(afterOutput({ kind: kind({ code: 0.9, plain: 0.1 }), language: lang("typescript") })).toBe("typescript");
  // code in a language the list lacks stays plain: a fence with no language is no help
  expect(afterOutput({ kind: kind({ code: 0.9, plain: 0.1 }), language: lang("other") })).toBeUndefined();
  expect(afterOutput({ kind: kind({ code: 0.69, plain: 0.31 }), language: lang("typescript") })).toBeUndefined();
  expect(afterOutput({ kind: kind({ code: 0.7, plain: 0.3 }), language: lang("typescript") })).toBe("typescript");
});
