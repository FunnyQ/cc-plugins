// Tests for the --diagram write-time lint. The lint runs Mermaid's real parser
// headless (happy-dom + the vendored bundle), so these tests are the renderer's
// verdict, not an approximation of it. The lint must stay conservative —
// legitimate syntax (sequence async arrows, cylinder shapes, quoted labels,
// frontmatter, `<br>` in a label) must pass.
// Run: bun test packages/monitor/skills/cockpit/scripts/diagram-lint.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DIAGRAM_TYPES, lintDiagram } from "./diagram-lint";
import { SEMANTIC_NODES } from "../dashboard/dist/modules/diagram.js";

describe("lintDiagram", () => {
  test("a clean flowchart with semantic classes passes", async () => {
    const src = `flowchart TD
  A[start]:::start --> B{has env?}
  B -->|yes| C[use it]:::ok
  B -->|no| D[fallback]:::bad
  D --> E[read config]:::fix`;
    expect(await lintDiagram(src)).toEqual([]);
  });

  test("empty source is one clear error", async () => {
    expect(await lintDiagram("  \n ")).toEqual(["empty diagram source"]);
  });

  test("unknown first line is flagged with examples", async () => {
    const problems = await lintDiagram("flowchat TD\n  A --> B");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"flowchat TD"');
    expect(problems[0]).toContain("flowchart TD");
  });

  test("frontmatter and %% directives are skipped when finding the type", async () => {
    const src = `---
title: rollup flow
---
%%{init: {"theme":"base"}}%%
%% a comment
stateDiagram-v2
  [*] --> Queued`;
    expect(await lintDiagram(src)).toEqual([]);
  });

  // The regression that motivated the real parser: a `.` inside a `-.text.->`
  // dotted-arrow label closes the arrow at `-.context.` and the lexer chokes.
  // No heuristic saw it — bracketProblem strips quoted labels and never looks
  // at edge labels at all — so it passed lint and rendered as raw source.
  test("a dot inside a dotted-arrow label is caught by the real parser", async () => {
    const src = `flowchart TB
  A["a"]
  B["b"]
  A -.context.mjs 撈.-> B`;
    const problems = await lintDiagram(src);
    expect(problems.length).toBeGreaterThanOrEqual(1);
    expect(problems[0]).toContain("mermaid parse error");
    expect(problems[0]).toContain("line 4"); // the parser carries the location
  });

  // Counter-case: `<br>` in a quoted label is legal mermaid. The parser says so;
  // no rule may be added that would flag it.
  test("a <br> inside a quoted label passes", async () => {
    const src = `flowchart TB
  A["one<br>two"]
  B["b"]
  A --> B`;
    expect(await lintDiagram(src)).toEqual([]);
  });

  test("unclosed bracket is flagged", async () => {
    const problems = await lintDiagram("flowchart TD\n  A[oops --> B[fine]");
    expect(problems.some((p) => p.includes("mermaid parse error"))).toBe(true);
    expect(problems.some((p) => p.includes("unclosed"))).toBe(true);
  });

  test("stray closer is flagged", async () => {
    const problems = await lintDiagram("flowchart TD\n  A[x]] --> B");
    expect(problems.some((p) => p.includes("mermaid parse error"))).toBe(true);
    expect(problems.some((p) => p.includes('stray "]"'))).toBe(true);
  });

  test("sequence async arrows -) and --) are not bracket errors", async () => {
    const src = `sequenceDiagram
  Alice-)John: fire and forget
  Alice--)John: async reply`;
    expect(await lintDiagram(src)).toEqual([]);
  });

  test("brackets inside quoted labels are ignored", async () => {
    const src = `flowchart TD
  A["array[0] access"] --> B`;
    expect(await lintDiagram(src)).toEqual([]);
  });

  test("unknown :::class is flagged and lists the palette", async () => {
    const problems = await lintDiagram("flowchart TD\n  A[x]:::success --> B");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(":::success");
    for (const name of Object.keys(SEMANTIC_NODES)) {
      expect(problems[0]).toContain(name);
    }
  });

  test("every predefined semantic class passes", async () => {
    for (const name of Object.keys(SEMANTIC_NODES)) {
      expect(await lintDiagram(`flowchart TD\n  A[x]:::${name} --> B`)).toEqual(
        [],
      );
    }
  });

  test("unquoted parens in a node label are flagged with the quoted fix", async () => {
    const problems = await lintDiagram(
      "flowchart TD\n  A[cache miss (L2)] --> B",
    );
    expect(problems.some((p) => p.includes("mermaid parse error"))).toBe(true);
    // The parser says where; the heuristic still says how to fix.
    expect(problems.some((p) => p.includes('["cache miss (L2)"]'))).toBe(true);
  });

  test("cylinder shape [(db)] is not a paren error", async () => {
    expect(await lintDiagram("flowchart LR\n  A --> B[(rollup.db)]")).toEqual(
      [],
    );
  });

  test("a slash-command label [/release] is flagged with the quoted fix", async () => {
    const problems = await lintDiagram(
      "flowchart TD\n  A[/release]:::start --> B",
    );
    expect(problems.some((p) => p.includes("mermaid parse error"))).toBe(true);
    expect(problems.some((p) => p.includes("parallelogram/trapezoid"))).toBe(
      true,
    );
    expect(problems.some((p) => p.includes('["/release"]'))).toBe(true);
  });

  test("a backslash-leading label is flagged the same way", async () => {
    const problems = await lintDiagram("flowchart TD\n  A[\\undo] --> B");
    expect(problems.some((p) => p.includes("never closes"))).toBe(true);
  });

  test("balanced parallelogram/trapezoid shapes pass", async () => {
    expect(
      await lintDiagram("flowchart TD\n  A[/input/] --> B[/read\\]"),
    ).toEqual([]);
  });

  test("quoting a slash-command label passes", async () => {
    expect(
      await lintDiagram('flowchart TD\n  A["/release"]:::start --> B'),
    ).toEqual([]);
  });

  test("quoted label with parens passes", async () => {
    expect(
      await lintDiagram('flowchart TD\n  A["cache miss (L2)"] --> B'),
    ).toEqual([]);
  });

  test("mindmap cloud/bang shapes skip the bracket rule", async () => {
    const src = `mindmap
  root((center))
    a)cloud shape(
    b))bang((`;
    expect(await lintDiagram(src)).toEqual([]);
  });

  test("stateDiagram [*] markers pass", async () => {
    const src = `stateDiagram-v2
  [*] --> Running
  Running --> [*]`;
    expect(await lintDiagram(src)).toEqual([]);
  });

  test("non-flowchart types the renderer supports pass the type check", async () => {
    const fixtures = [
      "kanban\n  Todo\n    task1[Fix the bug]",
      'C4Context\n  Person(user, "User")\n  System(app, "App")',
      "xychart-beta\n  x-axis [jan, feb]\n  bar [5, 9]",
      "block-beta\n  columns 2\n  a b",
      "sankey-beta\n  A,B,10",
      "requirementDiagram\n  requirement r1 {\n    id: 1\n  }",
    ];
    for (const src of fixtures) {
      expect(await lintDiagram(src)).toEqual([]);
    }
  });

  test("every whitelisted type exists in the vendored mermaid bundle", () => {
    const bundle = readFileSync(
      join(import.meta.dir, "../dashboard/dist/vendor/mermaid.min.js"),
      "utf8",
    );
    for (const type of DIAGRAM_TYPES) {
      expect(bundle.includes(type)).toBe(true);
    }
  });

  // A bad first line short-circuits (mermaid can't identify the language, so
  // every downstream rule would be guessing). Once the type is valid, the class
  // rule and the parser both report.
  test("multiple problems are all reported", async () => {
    const problems = await lintDiagram(
      "flowchart TD\n  A[bad (label)]:::nope --> B[unclosed",
    );
    expect(problems.length).toBeGreaterThanOrEqual(3);
    expect(problems.some((p) => p.includes(":::nope"))).toBe(true);
    expect(problems.some((p) => p.includes("mermaid parse error"))).toBe(true);
  });
});
