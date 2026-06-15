import type { Backend, Mode } from "../types";

export function getBackend(
  registry: Record<string, Backend>,
  name: string,
): Backend | undefined {
  return registry[name];
}

export function capabilityGate(backend: Backend, mode: Mode): string | null {
  return backend.supports.has(mode)
    ? null
    : `${mode} is not supported on ${backend.name}`;
}
