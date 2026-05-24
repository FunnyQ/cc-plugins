// Pure decision-log scanning, shared by the daemon broker (server) and the
// cockpit CLI (client) so both agree on "which needs_your_call is open".
// Kept side-effect free (no fs/network) so it can be unit-tested directly —
// the same seam the daemon-lifecycle.ts extraction established.

export type CallLogRecord = {
  type?: string;
  needs_your_call?: boolean;
  id?: string;
  call?: string;
};

// The id of the latest still-open needs_your_call, or null when none is open.
//
// Scan from the end: the first `response` reached means the latest call is
// already answered (no open call); a `needs_your_call` decision reached first
// means it's still open. Every needs_your_call decision carries an `id`
// (cockpit log always stamps one), so an open call always has a resolvable id.
export function latestOpenCallId(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    let rec: CallLogRecord;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (rec.type === "response") return null; // latest call already answered
    if (rec.type === "decision" && rec.needs_your_call === true) {
      return typeof rec.id === "string" ? rec.id : null;
    }
  }
  return null;
}

// Two callIds "match" for delivery when they're equal, or when either side is
// absent (null). The null-tolerance keeps legacy callers — that don't stamp a
// callId — working: an answer still reaches the session's parked wait. When
// BOTH sides name a call, the ids must agree, which is what stops an answer to
// one card from waking a wait parked on a different (stale) card.
export function callMatches(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  return a == null || b == null || a === b;
}
