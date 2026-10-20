import { describe, expect, test } from "bun:test";
import { lintDiagram } from "./diagram-lint";
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

  test("a frontmatter mindmap that fails to parse still skips the bracket rule", async () => {
    const problems = await lintDiagram(
      "---\ntitle: x\n---\nmindmap\n  root\n    a)cloud(\n    b))bang((\n  x -.a.b.-> y",
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("mermaid parse error");
  });

  test("a cylinder shape in a failing flowchart gets no paren hint", async () => {
    const problems = await lintDiagram("flowchart TD\n  A[(db)] -.a.b.-> B");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("mermaid parse error");
  });

  test("stateDiagram [*] markers pass", async () => {
    const src = `stateDiagram-v2
  [*] --> Running
  Running --> [*]`;
    expect(await lintDiagram(src)).toEqual([]);
  });

  test("every example in references/diagram.md passes", async () => {
    const doc = await Bun.file(
      `${import.meta.dir}/../references/diagram.md`,
    ).text();
    const examples = [...doc.matchAll(/```mermaid\n([\s\S]*?)```/g)].map(
      (m) => m[1],
    );
    expect(examples.length).toBeGreaterThanOrEqual(5);
    for (const src of examples) {
      expect({ src, problems: await lintDiagram(src) }).toEqual({
        src,
        problems: [],
      });
    }
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

  test("multiple problems are all reported", async () => {
    const problems = await lintDiagram(
      "flowchart TD\n  A[bad (label)]:::nope --> B[unclosed",
    );
    expect(problems.length).toBeGreaterThanOrEqual(3);
    expect(problems.some((p) => p.includes(":::nope"))).toBe(true);
    expect(problems.some((p) => p.includes("mermaid parse error"))).toBe(true);
  });
});
