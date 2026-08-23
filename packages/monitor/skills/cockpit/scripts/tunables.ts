// Env-tunable cadences shared by the daemon's long-poll endpoints.
//
// These live together because their defaults are coupled: a park's hop budget
// must stay under the daemon's `idleTimeout` (cockpit-server.ts). Held as one
// copy per endpoint module, raising idleTimeout meant remembering three call
// sites, and a missed one is a silently dropped park — a hung agent, not an
// error.

/** A positive-integer env override, or `fallback` when unset/malformed. */
export function envInt(name: string, fallback: number): number {
  const v = parseInt(process.env[name] || "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

// Single-hop long-poll budget. Kept under the daemon's 255s idleTimeout (see
// cockpit-server.ts) so the hop resolves with a re-pollable sentinel before Bun
// can drop the idle socket; `cockpit wait` simply re-polls. Overridable so tests
// don't wait minutes.
export function waitTimeoutMs(): number {
  return envInt("COCKPIT_WAIT_TIMEOUT_MS", 240_000);
}

/** How long an answer that arrived with nobody parked stays claimable. */
export function stashTtlMs(): number {
  return envInt("COCKPIT_STASH_TTL_MS", 60_000);
}
