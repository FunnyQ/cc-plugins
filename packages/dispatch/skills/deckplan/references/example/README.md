# Repository tour example

Copy this directory to use it as a Workflow starting point or a flightdeck fixture.
Use Bun and a graph-capable Dispatch installation.
The script uses the host's Workflow tool; running it with `bun workflow.js` does not provide the Workflow globals.
Read the [graph contract](../../../autopilot/references/graph-contract.md) for the format and [authoring guide](../authoring.md) for the prompt conventions.

The five nodes span `scout`, `build`, and `audit`, in that deliberate order.
The edge `scout/01 → build/01` crosses lanes.
The saved trail is a paused demonstration with a retry, a score, and all five displayed states.
A real run performs a repository inspection and writes reports into its run directory; its outcomes depend on the repository.

## A. Look at the example — no agents run

Replace angle-bracket placeholders with resolved absolute paths before executing commands.
Use a new directory for this walkthrough so copying the fixture cannot overwrite an existing run.

1. Create the run directory and trail subdirectory. Use a fixed slug under your data directory: `<XDG_DATA_HOME>/q-lab/flightdeck/repository-tour`, or `<absolute home>/.local/share/q-lab/flightdeck/repository-tour` when `XDG_DATA_HOME` is unset.

   ```sh
   mkdir -p "<absolute run directory>/.flightlog"
   ```

2. Copy the graph, identifier, and trail into place.

   ```sh
   cp "<absolute example directory>/graph.json" "<absolute run directory>/graph.json"
   cp "<absolute example directory>/run.id" "<absolute run directory>/run.id"
   cp "<absolute example directory>/run.jsonl" "<absolute run directory>/.flightlog/run.jsonl"
   ```

   Edit the copied graph's `repoRoot` to the absolute working repository path.
   The template intentionally carries `/absolute/path/to/working-repository`, an absolute placeholder that validates without encoding a developer's machine.
   Keep the saved trail at the example directory's top level: the runtime `.flightlog` directory creates a self-ignoring `.gitignore` on first append.

3. Check for an existing server on port 5758 before starting this foreground server. Choose another free port with `--port` if needed.

   ```sh
   bun "<absolute autopilot/scripts path>/flightdeck.ts" --plan "<absolute run directory>" --serve --port 5758
   ```

   Open `http://127.0.0.1:5758` in a browser.
   Keep the command running while inspecting the panels.
   If the installed reader reports `--plan must contain a tasks/ directory` without naming `graph.json`, it predates graph support; use a graph-capable Dispatch build.

4. Check the five panels below. Switch between the lanes and dependency graph views; expand a task or fleet row to inspect details.

   | Panel                | Check                                                                                                                                                                                                                                                                     | Regression symptom                                                                             |
   | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
   | Lanes panel          | Read lanes as `scout`, `build`, `audit`; find both scout nodes, both build nodes, and the audit node under their respective lanes.                                                                                                                                        | Lanes are alphabetised as `audit`, `build`, `scout`, or nodes appear under the wrong lane.     |
   | Dependency graph     | Find the crossover from `scout/01` to `build/01` and the edge from `build/01` to `build/02`.                                                                                                                                                                              | The cross-lane edge is missing.                                                                |
   | State of each node   | Match every node to the state table below.                                                                                                                                                                                                                                | A node's displayed state contradicts its trail, such as the recovered scout remaining invalid. |
   | Fleet table          | Find five agent rows: scout dev attempts 1 and 2, scout judge attempt 2, build dev attempt 1, and audit dev attempt 1. Inspect the judge's passing 4.5 score, threshold marker at 4 on the five-point scale (`>= 4` in the trail), and accuracy 5 / coverage 4 breakdown. | The retry row is missing, or the score verdict is absent.                                      |
   | Counts in the header | Find total 5, done 1, in progress 1, ready 1, blocked 1, invalid 1.                                                                                                                                                                                                       | Invalid is omitted or the run is presented as complete.                                        |

   | Node                               | Displayed state           | Evidence                                                                        |
   | ---------------------------------- | ------------------------- | ------------------------------------------------------------------------------- |
   | `scout/01` Inventory repository    | Complete (`done`)         | A later `done` declaration supersedes the first attempt's `failed` declaration. |
   | `scout/02` Survey documentation    | Ready                     | No entries and no dependencies.                                                 |
   | `build/01` Draft repository guide  | In flight (`in-progress`) | Opening note with no closing note; upstream scout is complete.                  |
   | `build/02` Review repository guide | Blocked                   | Its prerequisite `build/01` is incomplete; no blocked state is declared.        |
   | `audit/01` Check license evidence  | Invalid                   | Explicit `failed` declaration with a reason, followed by an agent end note.     |

   Expect no historical token spend from this fabricated identifier and trail: the fixture ships no transcripts.

## B. Adapt it and actually run it

Complete placement and the panel checks in A first.
Stop the foreground server with Ctrl-C when finished inspecting the fixture, or leave it running to watch the reset and new events live.

5. Confirm that no workflow agents are running for this directory. Ask the run owner before touching any existing trail, including the demonstration trail. After approval, move the trail aside to an unused timestamped archive:

   ```sh
   mv "<absolute run directory>/.flightlog/run.jsonl" "<absolute run directory>/.flightlog/run.jsonl.<ISO timestamp>"
   ```

   Choose a new timestamp if the archive already exists.
   Preserve the graph unless changing the topology.
   Never move, delete, or reset the trail during a run.

6. Write a fresh identifier before starting agents. Copy the workflow script into the run directory for adaptation.

   ```sh
   uuidgen > "<absolute run directory>/run.id"
   cp "<absolute example directory>/workflow.js" "<absolute run directory>/workflow.js"
   ```

   Read the new identifier and replace `repository-tour-example-20260906T060000Z` in the copied script's `CFG.runId` with that exact value.
   Every initial prompt interpolates this value; clearing the trail without changing it would allow previous transcripts to contribute spend.

7. Replace the script's three absolute configuration paths:

   | Field           | Substitute                                                                                                 |
   | --------------- | ---------------------------------------------------------------------------------------------------------- |
   | `CFG.runDir`    | The run directory under your data directory, containing the identifier and `.flightlog/run.jsonl`.         |
   | `CFG.flightlog` | The installed flightplan skill's `scripts/flightlog.ts`, which may live in a separate plugin installation. |
   | `CFG.repoRoot`  | The repository the agents inspect; use the exact value in the copied graph's `repoRoot`.                   |

   Resolve `~` and shell variables before inserting these literals.
   Adapt the five work descriptions — the second argument of each `node(...)` call — to your repository. The prompt around them is built once by `node`, so the announce command, the state command, the end note, and the label always name the same node; change the ref in one place only.
   Keep all nodes and dependencies declared in the graph before execution.
   Keep announce/end identity values paired and retain the explicit success/failure state commands.
   The script gates the guide on a successful inventory and the guide review on a successful guide; unrelated documentation and license checks run in parallel.

8. Start the server with step A.3's command if it has stopped. In a harness exposing the Workflow tool, submit the complete adapted `workflow.js` source to that tool for execution. Watch state changes and fleet rows arrive live. Each successful node appends `state done`; a failed inspection appends `state failed`. The script does not reproduce the fabricated retry and score: retain those saved events for dashboard testing, and add a judge/retry policy when adapting the real workflow if your job needs one. Inspect reports in the run directory when execution finishes.
