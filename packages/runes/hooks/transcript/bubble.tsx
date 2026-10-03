import type { Elements, On } from "claude-code";

import { config, type Rune, type Side } from "../config";
import { hex } from "./ansi";
import { cells, wrap } from "./text";

type BubbleProps = {
  color: string;
  icon: string;
  // cut to the header's room
  title?: string;
  // where the bar and the icon sit
  side: Side;
  inner: number;
  rows: [key: string, child: unknown][];
  key: string;
  // down: a tee on the bottom edge hands a line to the card drawn next; up: this card takes that line in.
  // `at` is the link's column from an unindented card's left edge, so both cards of a pair share one number
  link?: { to: "down" | "up"; at: number };
  // false draws the bar's column blank, so the frame still lines up with the other bubbles
  bar?: boolean;
  // columns the card sits in
  indent?: number;
  // a hover group: every edge rests muted and lights to `color` while the pointer is on any of it
  scope?: string;
};

const SATURATION = 0.5;
const BRIGHTNESS = 0.75;
// one entry per colour drawn: the configured ones, the shell palette and glow's
const muted = new Map<string, string>();

// glow's light style is the one sign of a light terminal the config carries
export const isLight = () => config.glow.style === "light";

// text stands in for the terminal's foreground, which has no hex to mute
// dim replaces dimColor, which lit every card's dim text at once under any pointer, live
// move these into config.yaml if anyone wants to retheme
export const PALETTES = {
  dark: {
    text: "#d4d4d4",
    dim: "#8a8a8a",
    str: "#b5bd68",
    var: "#b294bb",
    op: "#de935f",
  },
  light: {
    text: "#4d4d4c",
    dim: "#8e908c",
    str: "#718c00",
    var: "#8959a8",
    op: "#f5871f",
  },
};

export const palette = () => PALETTES[isLight() ? "light" : "dark"];

// a finished card's content never changes, yet every redraw re-derived it; each card keeps its own, so one kind never evicts another's
export const memo = (size = 200) => {
  const cache = new Map<string, unknown>();
  return <V,>(key: string, make: () => V): V => {
    if (cache.has(key)) return cache.get(key) as V;
    const value = make();
    cache.set(key, value);
    if (cache.size > size) cache.delete(cache.keys().next().value!);
    return value;
  };
};

// the title's tail for a call still running or cut short
export const stateOf = (p: { isRunning: boolean; isInterrupted: boolean }) =>
  p.isInterrupted ? " · interrupted" : p.isRunning ? " · running" : "";

// the text the model read for a call that errored, wrapped to the card
export const errorRows = (
  Text: Elements["terminal"]["Text"],
  text: string,
  width: number,
  color: string,
): [string, unknown][] =>
  wrap(text.replace(/\n+$/, ""), width).map((line, i) => [
    `err:${i}`,
    <Text color={color}>{line}</Text>,
  ]);

// a card that draws its call's result makes the engine's own block under it a repeat, so that block draws empty
export const hideResult = (on: On, tool: string, rune: Rune) =>
  on(
    "ui.render",
    { component: "ToolResult", props: { tool } },
    ($, e, next) => {
      if (!config.enabled.transcript || !config.enabled[rune]) return next(e);
      const { Box } = $.ui.resolve(e);
      return <Box key={`${rune}:result`} />;
    },
  );

// pulls each channel halfway to the colour's grey, then moves it a quarter toward the background,
// so the hue stays at lower saturation and contrast
export const mute = (color: string, light = isLight()) => {
  const key = `${light}${color}`;
  const known = muted.get(key);
  if (known) return known;
  const rgb = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  const [r = 0, g = 0, b = 0] = rgb;
  const grey = 0.299 * r + 0.587 * g + 0.114 * b;
  const out = hex(
    ...rgb.map((c) => {
      const flat = c + (grey - c) * SATURATION;
      return Math.round(light ? 255 - (255 - flat) * BRIGHTNESS : flat * BRIGHTNESS);
    }),
  );
  muted.set(key, out);
  return out;
};

// a row that draws a rule across the card, joined to its side borders
export const DIVIDER = Symbol("divider");

// the Text props for a colour that rests muted and lights up while its hover group is under the pointer
export const paint = (color: string, scope?: string) =>
  scope ? { color: mute(color), hover: { color, scope } } : { color };

// a Button padded to the row: Box takes no onPress, so the padding is what makes the whole row the press target
export const pressRow = (
  Button: Elements["terminal"]["Button"],
  {
    key,
    text,
    width,
    onPress,
    hover,
    align = "left",
  }: {
    key: string;
    text: string;
    width: number;
    onPress: () => void;
    hover?: { color: string; scope: string };
    align?: "left" | "center";
  },
) => {
  const room = Math.max(0, width - cells(text));
  const left = align === "center" ? Math.floor(room / 2) : 0;
  return (
    <Button key={key} plain {...(hover ? { hover } : {})} onPress={onPress}>
      {`${" ".repeat(left)}${text}${" ".repeat(room - left)}`}
    </Button>
  );
};

// a divider, then the fold label centred on a full-row Button
export const foldRows = (
  Button: Elements["terminal"]["Button"],
  {
    key,
    isOpen,
    hidden,
    width,
    onPress,
    hover,
  }: {
    key: string;
    isOpen: boolean;
    hidden: number;
    width: number;
    onPress: () => void;
    hover?: { color: string; scope: string };
  },
): [string, unknown][] => {
  const text = isOpen ? "▾ fold" : `▸ ${hidden} more lines`;
  return [
    [`${key}:divider`, DIVIDER],
    [
      `${key}:more:row`,
      pressRow(Button, { key: `${key}:more`, text, width, onPress, hover, align: "center" }),
    ],
  ];
};

// a toggle row that folds a whole section away; open, the body follows and a fold row closes it from its end.
// body is a function, so a folded section derives nothing
export const foldSection = (
  Button: Elements["terminal"]["Button"],
  {
    key,
    label,
    isOpen,
    width,
    onPress,
    body,
  }: {
    key: string;
    label: string;
    isOpen: boolean;
    width: number;
    onPress: () => void;
    body: () => [string, unknown][];
  },
): [string, unknown][] => {
  const toggle: [string, unknown] = [
    `${key}:toggle:row`,
    pressRow(Button, {
      key: `${key}:toggle`,
      text: `${isOpen ? "▾" : "▸"} ${label}`,
      width,
      onPress,
    }),
  ];
  if (!isOpen) return [toggle];
  return [
    toggle,
    ...body(),
    ...foldRows(Button, { key: `${key}:end`, isOpen: true, hidden: 0, width, onPress }),
  ];
};

// one row of styled runs; an empty one draws a space so the row keeps its height
export const runLine = <R extends { text: string }>(
  Text: Elements["terminal"]["Text"],
  runs: R[],
  styleOf: (run: R) => object = ({ text: _, ...style }) => style,
  outer: object = {},
) => (
  <Text {...outer}>
    {runs.length
      ? runs.map((run, j) => (
          <Text key={String(j)} {...styleOf(run)}>
            {run.text}
          </Text>
        ))
      : " "}
  </Text>
);

// every bubble shares this frame; every edge is drawn by hand, since Box borders refuse single sides and hid an absolute label
export const bubble = (
  { Box, Text }: Pick<Elements["terminal"], "Box" | "Text">,
  {
    color,
    icon,
    title,
    side,
    inner,
    rows,
    key,
    link,
    bar = true,
    indent = 0,
    scope,
  }: BubbleProps,
) => {
  const ink = paint(color, scope);
  // a glyph drawn wider than its one cell covers the space after it, so an icon before text or a left rule gets two
  const label = title
    ? `${wrap(`${icon}  ${title}`, inner - 3)[0]} `
    : `${icon}${side === "right" ? " " : "  "}`;
  const mid = link ? link.at - indent : -1;
  // what the header's rule fills: the frame less its corners, the label and its padding
  const fill = inner - cells(label);
  // a rule starting at column `from` takes the link's ┴ when the middle falls inside it
  const rule = (from: number) => {
    const line = [..."─".repeat(Math.max(0, fill))];
    if (link?.to === "up" && mid >= from && mid < from + line.length)
      line[mid - from] = "┴";
    return <Text {...ink}>{line.join("")}</Text>;
  };
  const header =
    side === "left" ? (
      <Box flexDirection="row">
        <Text {...ink}>{"╭─ "}</Text>
        <Text bold {...ink}>
          {label}
        </Text>
        {rule(3 + cells(label))}
        <Text {...ink}>{"╮"}</Text>
      </Box>
    ) : (
      <Box flexDirection="row">
        <Text {...ink}>{"╭"}</Text>
        {rule(1)}
        <Text bold {...ink}>
          {` ${label}`}
        </Text>
        <Text {...ink}>{"─╮"}</Text>
      </Box>
    );
  const frame = (
    <Box
      flexDirection="column"
      {...(side === "left" ? { flexGrow: 1, marginLeft: 1 } : {})}
    >
      {header}
      {/* each row is one terminal line, so the side borders are one glyph tall */}
      {rows.map(([k, child]) =>
        child === DIVIDER ? (
          <Box key={k} flexDirection="row">
            <Text {...ink}>{`├${"─".repeat(inner + 2)}┤`}</Text>
          </Box>
        ) : (
          <Box key={k} flexDirection="row">
            <Text {...ink}>{"│ "}</Text>
            <Box width={inner}>{child as never}</Box>
            <Text {...ink}>{" │"}</Text>
          </Box>
        ),
      )}
      <Box flexDirection="row">
        <Text {...ink}>
          {link?.to === "down"
            ? `╰${"─".repeat(mid - 1)}┬${"─".repeat(inner + 2 - mid)}╯`
            : `╰${"─".repeat(inner + 2)}╯`}
        </Text>
      </Box>
    </Box>
  );
  // an empty Box stretches to its row's height, so the bar follows the bubble
  const strip = (
    <Box
      width={1}
      flexShrink={0}
      marginLeft={side === "right" ? 1 : 0}
      backgroundColor={bar ? color : undefined}
    />
  );
  return (
    <Box
      key={key}
      flexDirection="row"
      marginTop={link?.to === "up" ? 0 : 1}
      marginLeft={indent}
      // the column CHROME leaves spare goes before a right-side frame, not between it and its bar
      {...(side === "right" ? { justifyContent: "flex-end" as const } : {})}
      // a hover group lights over the Box's whole area, so a hovering card must not stretch past its frame
      {...(scope ? { alignSelf: "flex-start" as const } : {})}
    >
      {side === "left" ? strip : null}
      {frame}
      {side === "right" ? strip : null}
    </Box>
  );
};
