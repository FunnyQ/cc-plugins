import type { FlightlogEntry } from "../../flightplan/scripts/lib/flightlog";
import { parseAgentLabel, type TaskView } from "./fleet";

export type WaveSummary = {
  current: number;
  remaining: number;
  sizes: number[];
  unschedulable: string[];
};

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
