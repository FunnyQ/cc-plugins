import {
  compareTaskOrder,
  formatScore,
  formatTokens,
  freshTokens,
  hasTokenReading,
  percent,
  renderRubric,
  scoreClass,
} from "./format.js";

export function buildLanes(tree) {
  const tasks = Array.isArray(tree?.tasks) ? tree.tasks : [];
  const byBucket = new Map();

  for (const task of tasks) {
    const laneTasks = byBucket.get(task.bucket);
    if (laneTasks) laneTasks.push(task);
    else byBucket.set(task.bucket, [task]);
  }

  // The bucket order arrives sorted from /api/tree, which owns that rule.
  return (tree?.buckets ?? []).map((bucket) => {
    const laneTasks = (byBucket.get(bucket) ?? []).sort(compareTaskOrder);

    return {
      bucket,
      tasks: laneTasks,
      done: laneTasks.filter((task) => task.state === "done").length,
    };
  });
}

export function Lanes({ tree, usage }) {
  // Held in the closure, not on the scope: a cache written during a render must
  // not be reactive, or storing it would schedule the very render that filled it.
  let cachedFrom = null;
  let cachedLanes = [];

  return {
    $template: `
      <div class="c-task-lanes">
        <p v-if="!tree.tasks.length && !tree.buckets.length" class="empty" role="status">
          No tasks in this flight tree.
        </p>
        <div v-else class="strip">
          <section v-for="lane in lanes()" :key="lane.bucket" class="c-task-lane" :aria-labelledby="\`lane-\${lane.bucket}\`">
            <header class="heading">
              <h2 :id="\`lane-\${lane.bucket}\`">{{ lane.bucket }}</h2>
              <span>{{ lane.done }} / {{ lane.tasks.length }}</span>
            </header>
            <div class="stack">
              <p v-if="!lane.tasks.length" class="lane-empty">No parsed tasks</p>
              <article v-for="task in lane.tasks" :key="task.ref" class="c-task-card" :class="\`-\${task.state}\`">
                <button
                  type="button"
                  class="summary"
                  :class="{ '-expandable': hasBreakdown(task) }"
                  :aria-expanded="hasBreakdown(task) ? isExpanded(task.ref) : null"
                  :aria-controls="hasBreakdown(task) ? \`rubric-\${task.ref.replace('/', '-')}\` : null"
                  :disabled="!hasBreakdown(task)"
                  @click="hasBreakdown(task) && toggle(task.ref)"
                >
                  <span class="identity">
                    <span class="status" aria-hidden="true"></span>
                    <span class="ref">{{ task.ref }}</span>
                    <span class="state-label">State: {{ task.state }}</span>
                  </span>
                  <span class="title">{{ task.title }}</span>
                  <span v-if="task.attempts > 1 || task.finalReview || task.blockedBy.length" class="badges">
                    <span v-if="task.attempts > 1" class="badge">Attempt {{ task.attempts }}</span>
                    <span v-if="task.finalReview" class="badge">Final review</span>
                    <span v-for="dependency in task.blockedBy" :key="dependency" class="badge">Blocked by {{ dependency }}</span>
                  </span>
                  <span v-if="task.latestScore" class="c-score-meter">
                    <span class="track" aria-hidden="true">
                      <span class="fill" :class="scoreClass(task.latestScore)" :style="{ inlineSize: percent(task.latestScore.weighted) }"></span>
                      <span class="threshold" :style="{ insetInlineStart: percent(task.latestScore.threshold) }"></span>
                    </span>
                    <span class="value">{{ formatScore(task.latestScore.weighted) }}</span>
                  </span>
                  <span class="token-figure" :class="{ '-absent': !hasTokenReading(freshTokens(usage.byTask[task.ref])) }">{{ formatTokens(freshTokens(usage.byTask[task.ref])) }}</span>
                  <span v-if="usage.codexByTask[task.ref]" class="token-figure -codex">cdx {{ formatTokens(freshTokens(usage.codexByTask[task.ref])) }}</span>
                </button>
                <div
                  v-if="hasBreakdown(task)"
                  v-show="isExpanded(task.ref)"
                  class="c-rubric-breakdown"
                  :id="\`rubric-\${task.ref.replace('/', '-')}\`"
                  v-html="renderRubric(task.latestScore)"
                ></div>
              </article>
            </div>
          </section>
        </div>
      </div>
    `,
    expandedRefs: {},
    // The template re-reads lanes() on every render, including a rubric toggle.
    // Each /api/tree payload replaces the tasks array, so its identity is what
    // decides whether the grouping and the sorts have to run again.
    lanes() {
      if (cachedFrom !== tree.tasks) {
        cachedFrom = tree.tasks;
        cachedLanes = buildLanes(tree);
      }
      return cachedLanes;
    },
    isExpanded(ref) {
      return this.expandedRefs[ref] === true;
    },
    toggle(ref) {
      this.expandedRefs = {
        ...this.expandedRefs,
        [ref]: !this.isExpanded(ref),
      };
    },
    hasBreakdown(task) {
      return Boolean(task.latestScore?.breakdown?.length);
    },
    scoreClass,
    percent,
    renderRubric,
    formatScore,
    formatTokens,
    freshTokens,
    hasTokenReading,
  };
}
