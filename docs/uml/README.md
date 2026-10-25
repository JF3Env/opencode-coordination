# Diagrams

PlantUML sources in `src/`, rendered SVG in `out/` (GitHub shows SVG; it does not render PlantUML). Redraw with `java -jar plantuml.jar -tsvg -o ../out src/*.puml` (Graphviz needed). CI checks that every source compiles.

## Use cases

| Diagram | Shows |
|---|---|
| ![](out/01a-use-cases-overview.svg) | Overview: the seven actors (owner, product manager, coordinator, engineer, Claude Code session, GitHub, clock) and the five packages of use cases. |
| ![](out/01b-use-cases-engineer.svg) | The engineer: availability, claim, scope note, progress, ready, block, defect outside scope, handover, result, plus communication; who each case notifies. |
| ![](out/01c-use-cases-coordinator.svg) | The coordinator: proposals and breakdown, assignment (with `fresh` as an extension and the checks as inclusions), review and merge, holds, reporting. |
| ![](out/01d-use-cases-product-manager.svg) | The product manager: propose, decide, prioritize, park, stall; measures and validation; executive summary, bundle, render, export. |
| ![](out/01e-use-cases-system.svg) | Actors without a role: the clock, GitHub, Claude Code sessions, the owner; the session services; bridge and CLI; history. |

## Structure

| Diagram | Shows |
|---|---|
| ![](out/02-components.svg) | Plugin components inside the OpenCode server process and their neighbours: SQLite, profile, generated pages, CLI, Claude Code socket and registry, `gh`. |
| ![](out/20-deployment.svg) | One machine: two OpenCode processes (one owns the bridge), Claude Code processes, the store, sockets, registry, project checkout, npm, GitHub. |
| ![](out/03-classes.svg) | Domain model and services. |

## State machines

| Diagram | Shows |
|---|---|
| ![](out/04-item-states.svg) | Work item life cycle; every transition names who or what fires it, with its guard. |
| ![](out/05-message-states.svg) | Message life cycle: recorded, queued or sent to Claude, delivered, reminded, escalated, answered. |

## Sequences

| Diagram | Shows |
|---|---|
| ![](out/06-seq-session-start.svg) | Plugin setup and a session's first turn: presence, name, title, role prompt, pending deliveries, title protection. |
| ![](out/07-seq-proposal-to-claim.svg) | Propose → accept → assign (with checks) → claim. |
| ![](out/08-seq-ready-review-merge.svg) | Ready (checked on GitHub) → verdict → merge → sync sees the merge and broadcasts → result. |
| ![](out/09-seq-ask-reminder-escalation.svg) | A question with a deadline: reminder after one block, escalation after two. |
| ![](out/10-seq-bridge-claude.svg) | Claude Code: socket frame with `to:`, receipt, outbound with token; the CLI writing the same ledger. |
| ![](out/11-seq-fresh-assign.svg) | Assign with `fresh`: replace the session, keep name, role, model and directory. |
| ![](out/15-seq-hold-freeze.svg) | Hold and freeze: broadcast, refusals, lift. |
| ![](out/16-seq-decision-priority.svg) | Decide → done / cannot; prioritize recomputes the board; the generated state digest. |
| ![](out/17-seq-measure-render-report.svg) | Measures (refused without a record on main), validation, plain-words summaries, render and `render --check`, the owner bundle. |
| ![](out/18-seq-gone-handover-reassign.svg) | Handover, gone detection, reassignment keeping branch and pull request. |
| ![](out/19-seq-verify-instruction.svg) | Defence against invented instructions: the item is in the prompt, `record` finds nothing, `incident` reports it. |

## Activities

| Diagram | Shows |
|---|---|
| ![](out/12-act-assign-checks.svg) | The checks of `assign`, in order. |
| ![](out/13-act-clock-tick.svg) | One clock tick. |
| ![](out/14-act-github-sync.svg) | How a pull request's state moves an item. |
| ![](out/21-act-delivery.svg) | One delivery pass: reserve, steer, mark. |
| ![](out/22-act-engineer-flow.svg) | One assignment from the engineer's seat, in swimlanes. |
