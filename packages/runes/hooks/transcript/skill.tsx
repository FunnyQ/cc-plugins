import type { On } from "claude-code";

import { config } from "../config";
import {
  bubble,
  DIVIDER,
  errorRows,
  foldSection,
  hideResult,
  memo,
  palette,
  pressRow,
  runLine,
  stateOf,
} from "./bubble";
import { glow, INSTALL_HINT } from "./glow";
import { innerWidth, plural, wrap } from "./text";
import { where } from "./where";

type Output = {
  success?: boolean;
  commandName?: string;
  model?: string;
  status?: "inline" | "forked";
  result?: string;
  background?: boolean;
};

const remember = memo();

type Fs = { exists: (path: string) => Promise<boolean>; read: (path: string) => Promise<unknown> };
type Install = { installPath: string; projectPath?: string };

// a plugin skill resolves through installed_plugins.json, so the version read is the one installed, not the newest in the cache
const skillFile = async (fs: Fs, name: string): Promise<string | undefined> => {
  const [plugin, skill] = name.includes(":") ? name.split(":", 2) : [undefined, name];
  const paths: string[] = [];
  if (plugin) {
    const index = `${where.home}/.claude/plugins/installed_plugins.json`;
    if (await fs.exists(index)) {
      const { plugins = {} } = JSON.parse(String(await fs.read(index))) as {
        plugins?: Record<string, Install[]>;
      };
      for (const [key, installs] of Object.entries(plugins)) {
        if (!key.startsWith(`${plugin}@`)) continue;
        for (const i of installs) {
          // a project-scoped install belongs to that project alone
          if (i.projectPath && i.projectPath !== where.cwd) continue;
          paths.push(`${i.installPath}/skills/${skill}/SKILL.md`, `${i.installPath}/commands/${skill}.md`);
        }
      }
    }
  } else
    paths.push(`${where.cwd}/.claude/skills/${skill}/SKILL.md`, `${where.home}/.claude/skills/${skill}/SKILL.md`);
  for (const path of paths) if (await fs.exists(path)) return String(await fs.read(path));
  return undefined;
};

type Doc = { text: string; count: number };
const docOf = (text: string): Doc => ({ text, count: text.replace(/\n$/, "").split("\n").length });

export const skill = (on: On) => {
  // module state, so a hot reload folds every card again
  const open = new Set<string>();
  // read on the first press of a SKILL.md fold, never while drawing; keyed by skill name, so a hot reload reads it again
  const docs = new Map<string, Doc | "loading" | { missing: string }>();

  hideResult(on, "Skill", "skill");

  on(
    "ui.render",
    { component: "ToolUse", surface: "terminal", props: { tool: "Skill" } },
    ($, e, next) => {
      if (!config.enabled.transcript || !config.enabled.skill) return next(e);
      const { color, error_color, icon, side } = config.skill;
      const { Box, Text, Button } = $.ui.resolve(e);
      const { isRunning, isErrored, isInterrupted, output } = e.props;
      const input = (e.props.input ?? {}) as { skill?: string; args?: string };
      const id = e.requestId;
      const inner = innerWidth(e.viewport?.columns);
      const { text: TEXT, dim: DIM } = palette();
      const o = (typeof output === "object" && output ? output : {}) as Output;

      const forked = o.status === "forked";
      const state = stateOf(e.props) || (o.background ? " · background" : "");
      const title = `${input.skill ?? o.commandName ?? "Skill"}${o.model ? ` · ${o.model}` : ""}${state}`;

      const name = input.skill ?? o.commandName ?? "";
      const meta = o.success === undefined ? "" : o.success ? "success" : "failed";
      const info = [input.args?.trim() ?? "", meta].filter(Boolean);

      // a background fork's result only describes the launch, so it gets no fold
      const result =
        forked && !o.background && o.result
          ? remember(`result\0${id}`, () => docOf(o.result!))
          : undefined;

      // glow runs only once a section is open, so the skills nobody unfolds cost nothing
      const textRows = (key: string, text: string): [string, unknown][] => {
        const runs = glow.view(inner, text);
        if (glow.hintDue()) $.ui.toast(INSTALL_HINT);
        return runs?.length
          ? runs.map((line, i) => [
              `${key}:${i}`,
              runLine(Text, line, ({ text: _, color: c, ...style }) => ({
                ...style,
                color: c ?? TEXT,
              })),
            ])
          : remember(`wrap\0${key}\0${text.length}\0${inner}`, () => wrap(text, inner)).map(
              (line, i) => [`${key}:${i}`, <Text color={TEXT}>{line}</Text>],
            );
      };
      const flip = (key: string) => {
        open.has(key) ? open.delete(key) : open.add(key);
        $.ui.invalidate("ui.render");
      };

      const section = (text: Doc) =>
        foldSection(Button, {
          key: "result",
          label: `result · ${plural(text.count, "line")}`,
          isOpen: open.has(id),
          width: inner,
          onPress: () => flip(id),
          body: () => textRows(`result\0${id}`, text.text),
        });

      const docKey = `${id}:skill.md`;
      const doc = docs.get(name);
      // drawn like a diff's "more lines" row: a divider, then a centred toggle under the body
      const skillMd = (): [string, unknown][] => {
        const isOpen = open.has(docKey);
        const toggle: [string, unknown] = [
          "skill.md:toggle:row",
          pressRow(Button, {
            key: "skill.md:toggle",
            text: isOpen
              ? "▾ fold"
              : `▸ SKILL.md${typeof doc === "object" && "text" in doc ? ` · ${plural(doc.count, "line")}` : ""}`,
            width: inner,
            align: "center",
            onPress: () => {
              flip(docKey);
              if (docs.has(name)) return;
              docs.set(name, "loading");
              skillFile({ exists: (path) => $.fs.exists(path), read: (path) => $.fs.read(path) }, name)
                .then((text) => docs.set(name, text === undefined ? { missing: "(no SKILL.md found)" } : docOf(text)))
                .catch((err: unknown) => docs.set(name, { missing: `(SKILL.md could not be read: ${String(err)})` }))
                .finally(() => $.ui.invalidate("ui.render"));
            },
          }),
        ];
        if (!isOpen) return [["skill.md:divider", DIVIDER], toggle];
        const body: [string, unknown][] =
          doc === undefined || doc === "loading"
            ? [["skill.md:loading", <Text color={DIM}>loading…</Text>]]
            : "missing" in doc
              ? [["skill.md:missing", <Text color={DIM}>{doc.missing}</Text>]]
              : textRows(`skill.md\0${name}`, doc.text);
        return [["skill.md:divider", DIVIDER], ...body, ["skill.md:end", DIVIDER], toggle];
      };

      const rows: [string, unknown][] = [
        ...(typeof output === "string"
          ? errorRows(Text, output, inner, error_color)
          : info.flatMap((line, i) =>
              wrap(line, inner).map((l, j): [string, unknown] => [
                `info:${i}:${j}`,
                <Text color={i || !input.args?.trim() ? DIM : TEXT}>{l}</Text>,
              ]),
            )),
        ...(result ? section(result) : []),
        ...(name ? skillMd() : []),
      ];
      return bubble(
        { Box, Text },
        {
          key: "skill",
          color:
            isErrored || isInterrupted || o.success === false
              ? error_color
              : color,
          icon,
          title,
          side,
          inner,
          rows,
          bar: false,
        },
      );
    },
  );
};
