#!/usr/bin/env bun
/**
 * PostToolUse hook: surface the comment blocks an edit added or grew, so the
 * model re-judges why vs what.
 *
 * Input (stdin): JSON with tool_name, tool_input, and on Claude Code a
 * tool_response carrying the diff the write produced.
 * Output: silent unless a reportable block exists.
 * Exit codes:
 *   0 = ok / skipped file type / nothing to report
 *   2 = block reported (PostToolUse exit 2 + stderr surfaces feedback to the LLM)
 *
 * Detects only. The why-vs-what judgement is the model's — this hook never
 * guesses at meaning, it just hands the lines back.
 *
 * A block reports when it runs MIN_BLOCK_LINES or longer AND this edit put at
 * least one line in it. One- and two-line comments never fire: measured over
 * this repo, that silences 68% of blocks, which is what keeps the hook quiet
 * enough to leave switched on. The file-header block is exempt — it documents
 * the module, which is the one place prose is the point.
 */

import {
  ASK,
  baseName,
  blocksFor,
  formatReason,
  type ToolInput,
  type ToolResponse,
} from "./comment-core.ts";
import { fetchPost } from "./jev-fetch.ts";
import { screenBlocks, screenNote } from "./jev-screen.ts";
import { recordReported } from "./sweep-state.ts";

async function main(): Promise<number> {
  let payload: {
    session_id?: string;
    tool_name?: string;
    tool_input?: ToolInput;
    tool_response?: ToolResponse;
  };
  try {
    payload = JSON.parse(await Bun.stdin.text());
  } catch {
    return 0;
  }

  const toolName = payload.tool_name ?? "";
  if (toolName !== "Edit" && toolName !== "Write") return 0;

  const input = payload.tool_input ?? {};
  const filePath = input.file_path ?? "";
  const { blocks, asked } = await blocksFor(
    toolName,
    input,
    payload.tool_response ?? {},
    (path) => Bun.file(path).text(),
  );
  if (blocks.length === 0) return 0;

  if (payload.session_id) recordReported(payload.session_id, filePath, asked);

  const fileName = baseName(filePath);
  const screen = await screenBlocks(fileName, blocks, {
    apiKey: process.env.TYPESAFE_API_KEY,
    fetch: fetchPost,
  });
  const note = screenNote("💬 comment-guard", screen);
  // Claude Code reads stdout JSON only on exit 0, so a full withdrawal is the one case that can reach the user.
  if (screen.kept.length === 0) {
    if (note) console.log(JSON.stringify({ systemMessage: note }));
    return 0;
  }
  const reason = `${formatReason(fileName, screen.kept)}\n${ASK}`;
  console.error(note ? `${reason}\n${note}` : reason);
  return 2;
}

if (import.meta.main) {
  process.exit(await main());
}
