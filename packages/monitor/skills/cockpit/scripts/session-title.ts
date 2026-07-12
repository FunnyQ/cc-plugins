import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Glob } from "bun";
import { codexStateDb } from "./codex-db";
import { openCodeDb } from "../../shared/scripts/opencode";

type Provider = "claude" | "codex" | "opencode";

function normalizeTitle(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function databaseTitle(path: string, sql: string, sessionId: string): string {
  if (!existsSync(path)) return "";
  try {
    const db = new Database(path, { readonly: true });
    try {
      const row = db.query(sql).get(sessionId) as { title?: unknown } | null;
      return normalizeTitle(row?.title);
    } finally {
      db.close();
    }
  } catch {
    return "";
  }
}

function claudeProjectsDir(): string {
  return (
    process.env.COCKPIT_CLAUDE_PROJECTS_DIR ||
    join(homedir(), ".claude", "projects")
  );
}

function claudeTranscriptTitle(sessionId: string): string {
  const root = claudeProjectsDir();
  if (!existsSync(root)) return "";
  const glob = new Glob(`**/${sessionId}.jsonl`);
  for (const relativePath of glob.scanSync({ cwd: root, onlyFiles: true })) {
    try {
      const lines = readFileSync(join(root, relativePath), "utf8").split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line) as {
          type?: string;
          message?: { role?: string; content?: unknown };
        };
        if (entry.type !== "user" || entry.message?.role !== "user") continue;
        const content = entry.message.content;
        if (typeof content === "string") return normalizeTitle(content);
        if (Array.isArray(content)) {
          const text = content
            .map((part) =>
              part && typeof part === "object" && "text" in part
                ? (part as { text?: unknown }).text
                : "",
            )
            .filter((part): part is string => typeof part === "string")
            .join(" ");
          const title = normalizeTitle(text);
          if (title) return title;
        }
      }
    } catch {
      // Missing, malformed, or concurrently-written transcript: no fallback.
    }
  }
  return "";
}

export function resolveHistoricalSessionTitle(
  provider: Provider,
  sessionId: string,
): string {
  if (provider === "codex") {
    return databaseTitle(
      codexStateDb(),
      "select title from threads where id = ? limit 1",
      sessionId,
    );
  }
  if (provider === "opencode") {
    return databaseTitle(
      openCodeDb(),
      "select title from session where id = ? limit 1",
      sessionId,
    );
  }
  return claudeTranscriptTitle(sessionId);
}
