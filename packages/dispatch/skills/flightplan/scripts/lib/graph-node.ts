import { type ParsedTask, refToString, taskValidity } from "./parse-task";

export type NodeValidity =
  | { kind: "complete" }
  | { kind: "unfinished"; status: string | null }
  | { kind: "invalid"; rule: string; reason: string };

export type GraphNode = {
  ref: string;
  bucket: string;
  nn: string;
  title: string;
  status: string | null;
  dependsOn: string[];
  blocks: string[];
  finalReview: boolean;
  validity: NodeValidity;
};

export function nodesFromParsedTasks(
  byRef: Record<string, ParsedTask>,
): Record<string, GraphNode> {
  return Object.fromEntries(
    Object.entries(byRef).map(([ref, task]) => [
      ref,
      {
        ref,
        bucket: task.bucket,
        nn: task.nn,
        title: task.title,
        status: task.status,
        dependsOn: task.dependsOn.map(refToString),
        blocks: task.blocks.map(refToString),
        finalReview: task.finalReview,
        validity: taskValidity(task),
      },
    ]),
  );
}

/**
 * The dependencies of `node` that are not satisfied yet, as refs.
 *
 * The readiness rule lives here alone: a dependency is satisfied only when the
 * upstream node is *validly* complete. A task claiming `Status: done` over an
 * unticked gate box, or a graph node whose trail declared `failed`, keeps
 * blocking, so a lost gate result can never unlock downstream work.
 */
export function unmetNodeDependencies(
  node: GraphNode,
  byRef: Record<string, GraphNode>,
): string[] {
  return node.dependsOn.filter((ref) => {
    const dependency = byRef[ref];
    return dependency === undefined || dependency.validity.kind !== "complete";
  });
}
