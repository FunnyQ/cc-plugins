# Waypoint Mode

Planning **one leg** of an existing rolling-wave roadmap, instead of a whole standalone plan. The roadmap tier lives in the `waypoints` skill; flightplan only fills in the leg the roadmap says is active.

Enter this mode only when the request targets a specific waypointed project:

- the user names it, OR
- the user points at a `docs/<proj>/` that holds `WAYPOINTS.md`, OR
- the user references a leg or the roadmap, OR
- exactly one roadmap exists AND the request is clearly to plan its next leg.

If multiple roadmaps exist and none is named, ask which. Don't guess. If the request is an ordinary "spec this out" with no roadmap intent, stay in normal flightplan mode even when a `WAYPOINTS.md` exists elsewhere.

## Flow

Resolve the sibling script from this skill's load-time base directory:
`WAYPOINTS_SCRIPT="<base-dir>/../waypoints/scripts/waypoints.ts"`.

1. Read the active leg — its `NN-slug`, `DONE-STATE`, and the prior-legs digest:
   ```bash
   bun "$WAYPOINTS_SCRIPT" active <proj>
   ```
2. Interview for **that leg's done-state only**. Use the prior-legs digest as rolling-wave context. Do not re-plan the whole project.
3. Scaffold with the waypoints script, not `scaffold.ts`:
   ```bash
   bun "$WAYPOINTS_SCRIPT" leg-scaffold <proj> <NN-slug> <buckets>
   ```
4. Write the leg's spec + `tasks/` into `docs/<proj>/legs/<NN-slug>/`, using the same split as SKILL.md Step 5: author the spec and `_context/` yourself, fan the task files out one forked subagent each.
5. Run `lint-task.ts`, `build-readme.ts`, and `review-plan.ts` against that leg path. They already accept arbitrary paths.
6. Execution is unchanged: `/autopilot docs/<proj>/legs/<NN-slug>`.
