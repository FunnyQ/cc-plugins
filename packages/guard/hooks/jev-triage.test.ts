import { describe, expect, test } from "bun:test";
import type { CommentBlock } from "./comment-core.ts";
import { triage } from "./jev-triage.ts";

const block = (
  start: number,
  lines: string[],
  added: boolean[] = lines.map(() => true),
  tags: CommentBlock["tags"] = lines.map(() => null),
): CommentBlock => ({ start, lines, added, height: lines.length, tags });

const TEXT = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n");

type Sent = {
  state: { file: string; block: string; code: string };
  questions: Record<string, unknown>;
};
type Probs = { keep: number; delete: number; must_kill: number };

const DELETE: Probs = { keep: 0.1, delete: 0.85, must_kill: 0.05 };
const KEEP: Probs = { keep: 0.9, delete: 0.05, must_kill: 0.05 };

function fakeJev(byFirstLine: Record<string, Probs>, sent: Sent[] = []) {
  return (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Sent;
    sent.push(body);
    const first = body.state.block.split("\n")[0]!.split("\t")[1]!;
    const probabilities = byFirstLine[first]!;
    const answers = Object.fromEntries(
      Object.keys(body.questions).map((k) => [k, { probabilities }]),
    );
    return new Response(JSON.stringify({ answers }));
  }) as unknown as typeof fetch;
}

describe("triage", () => {
  test("settles a report Jev is sure of, returning its DELETE verdicts", async () => {
    const lines = await triage(
      [
        {
          file: "a.ts",
          text: TEXT,
          blocks: [block(10, ["// x", "// y", "// z"])],
        },
      ],
      { apiKey: "k", fetch: fakeJev({ "// x": DELETE }) },
    );
    expect(lines).toEqual([
      "a.ts:10 DELETE — Jev p=0.85: restates the code",
      "a.ts:11 DELETE — Jev p=0.85: restates the code",
      "a.ts:12 DELETE — Jev p=0.85: restates the code",
    ]);
  });

  test("names only the added lines of a block", async () => {
    const lines = await triage(
      [
        {
          file: "a.ts",
          text: TEXT,
          blocks: [block(10, ["// x", "// y", "// z"], [false, true, false])],
        },
      ],
      { apiKey: "k", fetch: fakeJev({ "// x": DELETE }) },
    );
    expect(lines).toEqual(["a.ts:11 DELETE — Jev p=0.85: restates the code"]);
  });

  test("settles an all-KEEP report with nothing to deliver", async () => {
    const lines = await triage(
      [
        {
          file: "a.ts",
          text: TEXT,
          blocks: [block(10, ["// x", "// y", "// z"])],
        },
      ],
      { apiKey: "k", fetch: fakeJev({ "// x": KEEP }) },
    );
    expect(lines).toEqual([]);
  });

  test("hands the whole report to the reviewer when one block is unsure", async () => {
    const lines = await triage(
      [
        {
          file: "a.ts",
          text: TEXT,
          blocks: [
            block(10, ["// x", "// y", "// z"]),
            block(50, ["// p", "// q", "// r"]),
          ],
        },
      ],
      {
        apiKey: "k",
        fetch: fakeJev({
          "// x": DELETE,
          "// p": { keep: 0.75, delete: 0.2, must_kill: 0.05 },
        }),
      },
    );
    expect(lines).toBeNull();
  });

  test("holds KEEP to a stricter bar than DELETE", async () => {
    const at = (p: Probs) =>
      triage(
        [
          {
            file: "a.ts",
            text: TEXT,
            blocks: [block(10, ["// x", "// y", "// z"])],
          },
        ],
        {
          apiKey: "k",
          fetch: fakeJev({ "// x": p }),
        },
      );
    expect(await at({ keep: 0.3, delete: 0.6, must_kill: 0.1 })).not.toBeNull();
    expect(await at({ keep: 0.79, delete: 0.2, must_kill: 0.01 })).toBeNull();
    expect(await at({ keep: 0.8, delete: 0.15, must_kill: 0.05 })).toEqual([]);
  });

  test("never settles a MUST KILL, however sure", async () => {
    const lines = await triage(
      [
        {
          file: "a.ts",
          text: TEXT,
          blocks: [block(10, ["// x", "// y", "// z"])],
        },
      ],
      {
        apiKey: "k",
        fetch: fakeJev({
          "// x": { keep: 0.02, delete: 0.03, must_kill: 0.95 },
        }),
      },
    );
    expect(lines).toBeNull();
  });

  test("hands a tagged block to the reviewer without asking Jev", async () => {
    const sent: Sent[] = [];
    const lines = await triage(
      [
        {
          file: "a.ts",
          text: TEXT,
          blocks: [
            block(
              10,
              ["// x", "// eslint-disable-next-line", "// z"],
              undefined,
              [null, "suppression", null],
            ),
          ],
        },
      ],
      { apiKey: "k", fetch: fakeJev({ "// x": DELETE }, sent) },
    );
    expect(lines).toBeNull();
    expect(sent).toHaveLength(0);
  });

  test("asks nothing without a key", async () => {
    const sent: Sent[] = [];
    const lines = await triage(
      [
        {
          file: "a.ts",
          text: TEXT,
          blocks: [block(10, ["// x", "// y", "// z"])],
        },
      ],
      { apiKey: undefined, fetch: fakeJev({ "// x": DELETE }, sent) },
    );
    expect(lines).toBeNull();
    expect(sent).toHaveLength(0);
  });

  test("hands the report to the reviewer when Jev fails", async () => {
    const failing = (async () =>
      new Response("down", { status: 503 })) as unknown as typeof fetch;
    const throwing = (async () => {
      throw new Error("timeout");
    }) as unknown as typeof fetch;
    const files = [
      {
        file: "a.ts",
        text: TEXT,
        blocks: [block(10, ["// x", "// y", "// z"])],
      },
    ];
    expect(await triage(files, { apiKey: "k", fetch: failing })).toBeNull();
    expect(await triage(files, { apiKey: "k", fetch: throwing })).toBeNull();
  });

  test("sends the block and 40 numbered lines either side as state", async () => {
    const sent: Sent[] = [];
    await triage(
      [
        {
          file: "a.ts",
          text: TEXT,
          blocks: [block(100, ["// x", "// y", "// z"])],
        },
      ],
      { apiKey: "k", fetch: fakeJev({ "// x": DELETE }, sent) },
    );
    const code = sent[0]!.state.code.split("\n");
    expect(code[0]).toBe("60\tline 60");
    expect(code.at(-1)).toBe("142\tline 142");
    expect(sent[0]!.state.block).toBe("100\t// x\n101\t// y\n102\t// z");
    expect(Object.keys(sent[0]!.questions)).toEqual(["l100", "l101", "l102"]);
  });

  test("clamps the code window to the file", async () => {
    const sent: Sent[] = [];
    await triage(
      [
        {
          file: "a.ts",
          text: TEXT,
          blocks: [block(2, ["// x", "// y", "// z"])],
        },
      ],
      { apiKey: "k", fetch: fakeJev({ "// x": DELETE }, sent) },
    );
    expect(sent[0]!.state.code.split("\n")[0]).toBe("1\tline 1");
  });
});
