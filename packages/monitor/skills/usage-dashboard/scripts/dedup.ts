// Billing-dedup key for Claude Code transcript entries. Claude Code persists
// multiple snapshots for one API request (thinking / text / tool_use lines)
// that all carry identical billing usage — counting each would double-bill. The
// requestId:messageId pair identifies the request; we fall back to the entry
// uuid, then to a per-file running index so distinct unkeyed lines never
// collapse together. Pure so the keying rule is unit-testable on its own.

export type DedupEntry = {
  requestId?: string;
  uuid?: string;
  message?: { id?: string };
};

export function dedupKey(
  entry: DedupEntry,
  file: string,
  seenSize: number,
): string {
  return entry.requestId && entry.message?.id
    ? `${entry.requestId}:${entry.message.id}`
    : (entry.uuid ?? `${file}:${seenSize}`);
}
