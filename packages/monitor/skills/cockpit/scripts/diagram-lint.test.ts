// Tests for the --diagram write-time lint. Each rule targets a known Mermaid
// parse killer; the lint must stay conservative — legitimate syntax (sequence
// async arrows, cylinder shapes, quoted labels, frontmatter) must pass.
// Run: bun test packages/monitor/skills/cockpit/scripts/diagram-lint.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DIAGRAM_TYPES, lintDiagram } from "./diagram-lint";
import { SEMANTIC_NODES } from "../dashboard/dist/modules/diagram.js";

describe("lintDiagram", () => {
  test("a clean flowchart with semantic classes passes", () => {
    const src = `flowchart TD
  A[start]:::start --> B{has env?}
  B -->|yes| C[use it]:::ok
  B -->|no| D[fallback]:::bad
  D --> E[read config]:::fix`;
    expect(lintDiagram(src)).toEqual([]);
  });

  test("empty source is one clear error", () => {
    expect(lintDiagram("  \n ")).toEqual(["empty diagram source"]);
  });

  test("unknown first line is flagged with examples", () => {
    const problems = lintDiagram("flowchat TD\n  A --> B");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"flowchat TD"');
    expect(problems[0]).toContain("flowchart TD");
  });

  test("frontmatter and %% directives are skipped when finding the type", () => {
    const src = `---
title: rollup flow
---
%%{init: {"theme":"base"}}%%
%% a comment
stateDiagram-v2
  [*] --> Queued`;
    expect(lintDiagram(src)).toEqual([]);
  });

  test("unclosed bracket is flagged", () => {
    const problems = lintDiagram("flowchart TD\n  A[oops --> B[fine]");
    expect(problems.some((p) => p.includes("unclosed"))).toBe(true);
  });

  test("stray closer is flagged", () => {
    const problems = lintDiagram("flowchart TD\n  A[x]] --> B");
    expect(problems.some((p) => p.includes('stray "]"'))).toBe(true);
  });

  test("sequence async arrows -) and --) are not bracket errors", () => {
    const src = `sequenceDiagram
  Alice-)John: fire and forget
  Alice--)John: async reply`;
    expect(lintDiagram(src)).toEqual([]);
  });

  test("brackets inside quoted labels are ignored", () => {
    const src = `flowchart TD
  A["array[0] access"] --> B`;
    expect(lintDiagram(src)).toEqual([]);
  });

  test("unknown :::class is flagged and lists the palette", () => {
    const problems = lintDiagram("flowchart TD\n  A[x]:::success --> B");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(":::success");
    for (const name of Object.keys(SEMANTIC_NODES)) {
      expect(problems[0]).toContain(name);
    }
  });

  test("every predefined semantic class passes", () => {
    for (const name of Object.keys(SEMANTIC_NODES)) {
      expect(lintDiagram(`flowchart TD\n  A[x]:::${name} --> B`)).toEqual([]);
    }
  });

  test("unquoted parens in a node label are flagged with the quoted fix", () => {
    const problems = lintDiagram("flowchart TD\n  A[cache miss (L2)] --> B");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('["cache miss (L2)"]');
  });

  test("cylinder shape [(db)] is not a paren error", () => {
    expect(lintDiagram("flowchart LR\n  A --> B[(rollup.db)]")).toEqual([]);
  });

  test("a slash-command label [/release] is flagged with the quoted fix", () => {
    const problems = lintDiagram("flowchart TD\n  A[/release]:::start --> B");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("parallelogram/trapezoid");
    expect(problems[0]).toContain('["/release"]');
  });

  test("a backslash-leading label is flagged the same way", () => {
    const problems = lintDiagram("flowchart TD\n  A[\\undo] --> B");
    expect(problems.some((p) => p.includes("never closes"))).toBe(true);
  });

  test("balanced parallelogram/trapezoid shapes pass", () => {
    expect(lintDiagram("flowchart TD\n  A[/input/] --> B[/read\\]")).toEqual(
      [],
    );
  });

  test("quoting a slash-command label passes", () => {
    expect(lintDiagram('flowchart TD\n  A["/release"]:::start --> B')).toEqual(
      [],
    );
  });

  test("quoted label with parens passes", () => {
    expect(lintDiagram('flowchart TD\n  A["cache miss (L2)"] --> B')).toEqual(
      [],
    );
  });

  test("mindmap cloud/bang shapes skip the bracket rule", () => {
    const src = `mindmap
  root((center))
    a)cloud shape(
    b))bang((`;
    expect(lintDiagram(src)).toEqual([]);
  });

  test("stateDiagram [*] markers pass", () => {
    const src = `stateDiagram-v2
  [*] --> Running
  Running --> [*]`;
    expect(lintDiagram(src)).toEqual([]);
  });

  test("non-flowchart types the renderer supports pass the type check", () => {
    const fixtures = [
      "kanban\n  Todo\n    task1[Fix the bug]",
      'C4Context\n  Person(user, "User")\n  System(app, "App")',
      "xychart-beta\n  x-axis [jan, feb]\n  bar [5, 9]",
      "block-beta\n  columns 2\n  a b",
      "sankey-beta\n  A,B,10",
      "requirementDiagram\n  requirement r1 {\n    id: 1\n  }",
    ];
    for (const src of fixtures) {
      expect(lintDiagram(src)).toEqual([]);
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

  test("multiple problems are all reported", () => {
    const problems = lintDiagram(
      "flowchat TD\n  A[bad (label)]:::nope --> B[unclosed",
    );
    expect(problems.length).toBeGreaterThanOrEqual(3);
  });
});
