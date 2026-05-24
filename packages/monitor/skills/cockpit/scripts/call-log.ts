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
// Only the *latest* needs_your_call can be open: logging a newer call supersedes
// any older one (mirrors handleWait's superseded check), so an older call never
// reopens — not even when the newer one is later answered. We therefore scan
// from the end, gather the responses that come *after* the latest call, then
// stop at that call and decide:
//   - a `response` carrying `call === <id>` answers that specific call;
//   - a legacy `response` without a `call` (older logs / session-only routing)
//     closes whatever the latest open call is.
// The latest call is open unless one of those closed it. Responses that answer
// an *older* (already-superseded) call are irrelevant and don't reopen it.
//
// Every needs_your_call decision carries an `id` (cockpit log always stamps
// one), so an open call has a resolvable id.
export function latestOpenCallId(lines: string[]): string | null {
  const answeredCalls = new Set<string>();
  let sawLegacyResponse = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    let rec: CallLogRecord;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (rec.type === "response") {
      if (typeof rec.call === "string") answeredCalls.add(rec.call);
      else sawLegacyResponse = true;
      continue;
    }
    if (rec.type === "decision" && rec.needs_your_call === true) {
      const id = typeof rec.id === "string" ? rec.id : null;
      // The latest call is closed by a legacy (call-less) response or by a
      // response explicitly naming it. Either way → nothing open.
      if (sawLegacyResponse) return null;
      if (id !== null && answeredCalls.has(id)) return null;
      return id;
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
