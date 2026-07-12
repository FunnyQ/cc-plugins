import { describe, expect, test } from "bun:test";
import { lintEdgeLabels } from "./diagram-lint";

const clean = (src: string) => expect(lintEdgeLabels(src)).toEqual([]);
const flags = (src: string) =>
  expect(lintEdgeLabels(src).length).toBeGreaterThan(0);

// Every expectation here was checked against mermaid's own parser before being written
// down. The obvious rule — "an edge label may not contain brackets" — is FALSE, and an
// earlier version of this lint enforced it and rejected valid diagrams.
describe("lintEdgeLabels", () => {
  // The exact source the skald emitted into a real PR body.
  test("rejects node syntax smuggled into a dotted edge label", () => {
    flags(`flowchart TD
      B["orphan"] -.Cut1["Cut 1: exit on stdin EOF"].-> F1["exits with parent"]`);
  });

  test("rejects a quote that does not wrap the whole label, in every form", () => {
    flags(`flowchart TD\n  A -. N["t"] .-> B`);
    flags(`flowchart TD\n  A -- N["t"] --> B`);
    flags(`flowchart TD\n  A == N["t"] ==> B`);
    flags(`flowchart TD\n  A -->|N["t"]| B`);
    flags(`flowchart TD\n  A -. a"b" .-> B`);
  });

  // Mermaid tolerates bare brackets in the dash/dot/thick forms but not in `|…|`.
  test("rejects brackets only in the pipe form", () => {
    flags(`flowchart TD\n  A -->|a[b]| B`);
    flags(`flowchart TD\n  A -->|a(b)| B`);
    clean(`flowchart TD\n  A -. a[b] .-> B`);
    clean(`flowchart TD\n  A -- a[b] --> B`);
  });

  test("accepts every valid labelled link form", () => {
    clean(`flowchart TD\n  A -. "Cut 1: exit on stdin EOF" .-> B`);
    clean(`flowchart TD\n  A -. plain text .-> B`);
    clean(`flowchart TD\n  A -->|text| B`);
    clean(`flowchart TD\n  A -->|"quoted"| B`);
    clean(`flowchart TD\n  A -- text --> B`);
    clean(`flowchart TD\n  A == text ==> B`);
  });

  test("accepts unlabelled links, including the dotted arrow", () => {
    clean(`flowchart TD\n  A --> B`);
    clean(`flowchart TD\n  A -.-> B`);
    clean(`flowchart TD\n  A --- B`);
    clean(`flowchart TD\n  A ==> B`);
  });

  // Node labels are exactly where quotes and brackets BELONG — the rule must not reach in.
  test("leaves node labels alone", () => {
    clean(`flowchart TD
      A["a label [with] brackets"] --> B("round")
      C{"diamond"} --> D
      classDef bad fill:#5b1a1a,stroke:#e5605f,color:#fff;
      class A bad;`);
  });

  test("says how to fix it, not just that it is wrong", () => {
    const [msg] = lintEdgeLabels(`flowchart TD\n  A -.C1["x"].-> B`);
    expect(msg).toContain("edge label");
    expect(msg).toContain("quote ALL of it or none of it");
  });

  test("stays quiet on diagram types that have no flowchart links", () => {
    clean(`sequenceDiagram\n  Alice->>John: Hello John, how are you?`);
    clean(`pie title Pets\n  "Dogs" : 386`);
  });
});
