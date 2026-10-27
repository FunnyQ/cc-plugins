// With `explain.theme: auto`, asks TypeSafe's Jev which theme suits a page. Only the title, the h2 headings and which
// blocks the page holds leave the machine, secret-masked, never the prose.

import { THEMES, type Theme } from "../config";
import { type Post, scrub, systemOne } from "../transcript/jev";
import { holdsClass, prepareBlocks, unescapeHtml } from "./blocks";
import { THEME_FIT } from "./protocol";

const HEADING_CHARS = 80;

export type Inventory = {
  title: string;
  headings: string[];
  timeline: boolean;
  diff: boolean;
  diagram: boolean;
  table: boolean;
  code: boolean;
  cards: boolean;
};

// numeric references and the five escapes are decoded; a rarer named reference (`&commat;`) can still hide a secret from scrub, so decode named references too if a page is seen to use them
const decode = (text: string) =>
  unescapeHtml(
    text
      .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
        String.fromCodePoint(parseInt(hex, 16)),
      )
      .replace(/&#(\d+);/g, (_, dec: string) =>
        String.fromCodePoint(Number(dec)),
      ),
  );

const textOf = (html: string) =>
  decode(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();

export const themeInventory = (title: string, main: string): Inventory => {
  const { main: lifted, kinds } = prepareBlocks(main);
  return {
    title: scrub(textOf(title)),
    headings: [...lifted.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2\s*>/gi)].map(
      ([, inner]) => scrub(textOf(inner!)).slice(0, HEADING_CHARS),
    ),
    timeline: holdsClass(lifted, "ol", "timeline"),
    diff: kinds.has("diff"),
    diagram: kinds.has("mermaid"),
    table: /<table\b/i.test(lifted),
    code: kinds.has("code"),
    cards: holdsClass(lifted, "div", "cards"),
  };
};

const question = (inventory: Inventory) => ({
  state: inventory,
  questions: {
    theme: {
      type: "choice",
      instructions:
        "Which visual theme suits an explainer page with this `title`, these section `headings`, and these blocks (`timeline`, `diff`, `diagram`, `table`, `code`, `cards` say whether the page holds one)?",
      criteria: THEME_FIT,
    },
  },
});

export const jevTheme = async (
  t: { post: Post; apiKey: string },
  inventory: Inventory,
): Promise<Theme | undefined> => {
  const answers = await systemOne(t, question(inventory)).catch(
    () => undefined,
  );
  const [top] = Object.entries(answers?.theme?.probabilities ?? {})
    .filter(([name]) => (THEMES as readonly string[]).includes(name))
    .sort((a, b) => b[1] - a[1]);
  return top?.[0] as Theme | undefined;
};

let transport: { post: Post; apiKey: string } | undefined;

export const themer = {
  pick: (title: string, main: string): Promise<Theme | undefined> =>
    transport
      ? jevTheme(transport, themeInventory(title, main))
      : Promise.resolve(undefined),
  work(next: { apiKey: string | undefined; post: Post }) {
    transport = next.apiKey
      ? { post: next.post, apiKey: next.apiKey }
      : undefined;
  },
};
