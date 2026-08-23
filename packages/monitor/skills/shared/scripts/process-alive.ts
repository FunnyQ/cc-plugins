/**
 * Is a PID still running?
 *
 * Signal 0 performs the permission and existence checks without delivering
 * anything. ESRCH → no such process (dead); EPERM → the process exists but is
 * owned by someone else (alive).
 *
 * Lives in shared/ because both daemons' singleton guards need it: keeping it
 * on cockpit-channel.ts made usage-dashboard import an MCP stdio server — and
 * the whole MCP SDK — for six lines.
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}
