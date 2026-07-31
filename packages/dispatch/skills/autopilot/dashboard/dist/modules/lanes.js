const SCORE_MAX = 5;
const RUBRIC_SCORE_MAX = 5;
const PERCENT_MAX = 100;

function clamp(value, maximum) {
  return Math.min(Math.max(Number(value) || 0, 0), maximum);
}

function percentage(value, maximum = SCORE_MAX) {
  return `${(clamp(value, maximum) / maximum) * PERCENT_MAX}%`;
}

export function buildLanes(tree) {
  const tasks = Array.isArray(tree?.tasks) ? tree.tasks : [];

  return [...(tree?.buckets ?? [])]
    .sort((left, right) => left.localeCompare(right))
    .map((bucket) => {
      const laneTasks = tasks
        .filter((task) => task.bucket === bucket)
        .sort((left, right) => left.nn.localeCompare(right.nn, undefined, { numeric: true }));

      return {
        bucket,
        tasks: laneTasks,
        done: laneTasks.filter((task) => task.state === "done").length,
      };
    });
}

export function Lanes({ tree }) {
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
                      <span class="fill" :class="scoreClass(task.latestScore)" :style="{ inlineSize: scorePosition(task.latestScore.weighted) }"></span>
                      <span class="threshold" :style="{ insetInlineStart: scorePosition(task.latestScore.threshold) }"></span>
                    </span>
                    <span class="value">{{ formatScore(task.latestScore.weighted) }}</span>
                  </span>
                </button>
                <div
                  v-if="hasBreakdown(task)"
                  v-show="isExpanded(task.ref)"
                  class="c-rubric-breakdown"
                  :id="\`rubric-\${task.ref.replace('/', '-')}\`"
                >
                  <div v-for="dimension in task.latestScore.breakdown" :key="dimension.name" class="dimension">
                    <span class="label">{{ dimension.name }}</span>
                    <span class="bar" :style="{ inlineSize: weightWidth(dimension.weight, task.latestScore.breakdown) }">
                      <span class="fill" :style="{ inlineSize: rubricScoreWidth(dimension.score) }"></span>
                    </span>
                    <span class="score">{{ formatScore(dimension.score) }}</span>
                  </div>
                </div>
              </article>
            </div>
          </section>
        </div>
      </div>
    `,
    expandedRefs: {},
    lanes() {
      return buildLanes(tree);
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
    scoreClass(score) {
      if (score.hardFailed) return "-failed";
      if (score.passed) return "-passed";
      return "-pending";
    },
    scorePosition(value) {
      return percentage(value);
    },
    rubricScoreWidth(score) {
      return percentage(score, RUBRIC_SCORE_MAX);
    },
    weightWidth(weight, breakdown) {
      const largestWeight = Math.max(...breakdown.map((dimension) => dimension.weight), 1);
      return percentage(weight, largestWeight);
    },
    formatScore(score) {
      return Number(score).toFixed(2);
    },
  };
}
