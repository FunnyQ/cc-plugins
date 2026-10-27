import { expect, test } from "claude-code/testing";

import { startSession } from "../transcript/test-session";
import { lessonCard, TEACHER_COLOR } from "./lesson";

type Node = {
  type?: string;
  props?: Record<string, unknown>;
  children?: unknown[];
};
const flat = (n: unknown): Node[] =>
  typeof n === "object" && n !== null
    ? [n as Node, ...((n as Node).children ?? []).flatMap(flat)]
    : [];
const textOf = (n: Node): string =>
  (n.children ?? [])
    .map((c) => (typeof c === "string" ? c : textOf(c as Node)))
    .join("");

// the kit loads the plugin as its own instance, so the test's own hook draws the card the plugin would
test("the desktop lesson card draws the smoking teacher, the struck-out prompt over the rewrite, and validates", async ($, on) => {
  on("ui.render", { component: "UserMessage" } as never, async ($, e) => {
    const ui = $.ui.resolve(e as never) as never;
    return lessonCard(ui, "can you checking it", "Can you check it?") as never;
  });
  await startSession($, on, {
    run: () => ({ value: { exitCode: 0, stdout: "", stderr: "" } }) as never,
  });
  const ui = await $.ui.mount({
    plugin: "runes",
    surface: "desktop",
    component: "UserMessage",
    requestId: "r1",
    props: { text: "can you checking it" },
  } as never);
  const card = (await ui.find({ key: "teacher" })) as Node;
  await ui.unmount();
  expect(card.props).toMatchObject({ borderColor: TEACHER_COLOR });
  const nodes = flat(card);
  expect(
    nodes.some(
      (n) => n.type === "Svg" && String(n.props?.alt).includes("teacher"),
    ),
  ).toBe(true);
  const struck = nodes.find((n) => n.props?.strikethrough === true);
  expect(textOf(struck!)).toBe("can you checking it");
  const rewrite = nodes.find(
    (n) => n.type === "Text" && textOf(n) === "Can you check it?",
  );
  expect(rewrite).toBeDefined();
});
