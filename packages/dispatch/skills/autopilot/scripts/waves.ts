/**
 * Wave arithmetic for the flightdeck header.
 *
 * The orchestrator flies the tree in waves — every task whose dependencies are
 * complete goes out together, then the next scout takes a fresh snapshot. The
 * wave number itself is never written to the flightlog; it survives only in the
 * scout's agent label (`scout-wave-3`), which is why `currentWave` reads labels
 * rather than a field.
 */
import type { FlightlogEntry } from "../../flightplan/scripts/lib/flightlog";
import { parseAgentLabel, type TaskView } from "./fleet";

export type WaveSummary = {
  /** The wave being flown, from the newest scout label. 0 before the first scout. */
  current: number;
  /** Waves still to fly, counting the one in flight. */
  remaining: number;
  /** Task count per remaining wave, `sizes[0]` being the wave in flight. */
  sizes: number[];
  /**
   * Refs that no peel can ever reach — a dependency cycle, or a `Depends on`
   * naming a task that is not in the tree. They are excluded from `sizes`, so
   * without this the header would quietly under-count the work left.
   */
  unschedulable: string[];
};

/**
 * Peel the tree the way the wave loop flies it: take every unfinished task whose
 * dependencies are all complete, assume they land, then take what that unblocked.
 *
 * A floor, not a forecast. A task that fails its gate re-flies inside its own
 * wave, so a run can burn far more agents than this counts — but it can never
 * need fewer waves. The wave already dispatched is `sizes[0]` and stays counted
 * until its tasks read `done` on disk, so `remaining` always includes the one in
 * flight.
 */
export function remainingWaves(
  tasks: TaskView[],
): Pick<WaveSummary, "remaining" | "sizes" | "unschedulable"> {
  const known = new Set(tasks.map((task) => task.ref));
  const pending = new Map(
    tasks
      .filter((task) => task.state !== "done")
      .map((task) => [task.ref, task.dependsOn] as const),
  );

  const sizes: number[] = [];
  while (pending.size > 0) {
    const ready = [...pending]
      .filter(([, dependsOn]) =>
        // A dep outside `known` is unmet forever — same rule as unmetDependencies,
        // which treats an unresolvable ref as blocking rather than as satisfied.
        dependsOn.every((ref) => known.has(ref) && !pending.has(ref)),
      )
      .map(([ref]) => ref);
    if (ready.length === 0) break;
    sizes.push(ready.length);
    for (const ref of ready) pending.delete(ref);
  }

  return {
    remaining: sizes.length,
    sizes,
    unschedulable: [...pending.keys()].sort(),
  };
}

/** The newest wave a scout announced, 0 when none has run. */
export function currentWave(entries: FlightlogEntry[]): number {
  let current = 0;
  for (const entry of entries) {
    const parsed = parseAgentLabel(entry.agentLabel ?? "");
    if (parsed.role === "scout" && parsed.wave !== undefined) {
      current = Math.max(current, parsed.wave);
    }
  }
  return current;
}

export function summarizeWaves(
  tasks: TaskView[],
  entries: FlightlogEntry[],
): WaveSummary {
  return { current: currentWave(entries), ...remainingWaves(tasks) };
}
