import { TIMEOUT_MS, type Post } from "./jev-screen.ts";

/** Jev's transport for the bun hooks; the Claude Code mod builds its own on `$.http.fetch`. */
export const fetchPost: Post = (url, init) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
