# Design

## Intent

A team of agents coordinates through prose that the model must remember and through status tables that someone must type. The measured cost, on the project this plugin came from: 84% of the messages were free text outside any rule; about 2,900 lines of process text and tables were kept by hand; a day could hold more pull requests about the process than about the product; and invented instructions had to be caught by hand.

The plugin inverts that. **State is data the plugin keeps; text is derived from it.** An agent calls a typed tool. The plugin appends an event with the actor taken from the authenticated session, notifies the peers that need to know, counts the deadlines and regenerates the pages.

## Goals, non-goals, anti-goals

Goals: typed, traceable communication with deadlines; fewer hand-kept documents; work control (state, owner, pull request, scope, collisions); progress control (measures, bets, stalls, digests); history kept by the plugin.

Non-goals: replacing GitHub (pull requests, review and merges stay there; the plugin mirrors their state); a GUI (views are Markdown and tool output); anything model- or vendor-specific.

Anti-goals, which would be failures even if everything else worked: an agent acting on an instruction the ledger does not hold; state living in two places again (ledger plus hand-edited Markdown); the product manager or coordinator spending a block typing a report; losing the Claude Code bridge or the record-id check.

## Invariants

1. **Append-only.** `events` refuses UPDATE and DELETE (database triggers). Corrections are new events.
2. **Projections are a pure function of the events.** `Ledger.rebuild()` drops them and replays; the tests compare before and after. A projection never reads the clock or the network.
3. **The actor is not typed by the caller.** Role comes from the session's agent id (`roleOf`), name and session from the host. A text cannot claim another sender.
4. **One clock.** The ledger stamps events with `ledger.now()`, the runtime and the clock job use the same function, so deadlines and event times cannot disagree (a test found and pinned this).
5. **Nothing is pruned.** A record id cited today resolves tomorrow.

## Architecture

See [`uml/out/02-components.svg`](uml/out/02-components.svg) and [`uml/out/20-deployment.svg`](uml/out/20-deployment.svg).

| Module | Responsibility |
|---|---|
| `src/ledger` | `adapter.ts` (bun:sqlite / node:sqlite behind one synchronous surface, savepoint transactions), `schema.ts`, `projections.ts`, `ledger.ts` (append, queries, rebuild, delivery reservation), `import.ts` (agent-mail records) |
| `src/domain` | types, role resolution, the item transition table, file-overlap rule, the name pool, session titles |
| `src/runtime.ts` | the `Runtime` every tool, the CLI and the plugin share: ledger, profile, clock, optional host / Claude link / GitHub link; session registration; target resolution; `post` with the burst gate |
| `src/tools` | 48 tools, one `ToolSpec` each (`name`, `roles`, `input` schema, `run`); `callTool` checks the role, validates, records refusals |
| `src/deliver` | `pull` (reserve → steer into the session → mark delivered) and `dispatch` (OpenCode pull, Claude frame, CLI wake) |
| `src/clock` | `tick`: reminders, escalations, stalls, unclaimed assignments, idle engineers, gone sessions, the digest |
| `src/github` | `gh`-backed link and `syncPullRequests` |
| `src/bridge` | the Claude Code socket (peer `opencode`), frames, tokens, namespace checks, inbound routing |
| `src/prompt`, `src/views`, `src/render` | the role prompt, the board and state digest, the generated pages |
| `src/host/opencode.ts` | the only file that knows the OpenCode plugin API; it types it loosely on purpose |
| `src/cli` | the same tools and views from a shell |

## Data model

Class diagram: [`uml/out/03-classes.svg`](uml/out/03-classes.svg). Event types by prefix: `agent.*`, `message.*`, `item.*`, `decision.*`, `measure.*`, `hold.*`, `incident.*`, `owner.*`, `front.*`, `pr.*`, `clock.*`, `view.*`, `tool.refused`, `bridge.bound`.

Ids are short and sortable: items `W…`, decisions `D…`, holds `H…`, measures `M…` are the milliseconds since the epoch in base 36; a message id is 16 random hex characters whose first 8 are the citable short form.

### Work item life cycle

[`uml/out/04-item-states.svg`](uml/out/04-item-states.svg). Moves are guarded: `assign` needs `ready` and passes the checks of [`12-act-assign-checks`](uml/out/12-act-assign-checks.svg); `ready` (for review) needs a pull request that is not a draft, contains main, and is not covered by a hold; `measured` needs a record; `validated` needs an independent reference. Stages (`planned`, `specified`, `implemented`, `tested`, `validated`) are derived from events, with the commit read from GitHub, never from a message.

### Messages

[`uml/out/05-message-states.svg`](uml/out/05-message-states.svg). A message that needs an answer carries a deadline of one block. The clock re-sends once and escalates after a second block: engineer → coordinator copies the product manager; the other directions are marked escalated and appear in the owner bundle and the state digest.

## Interactions

Use cases per actor ([`01a`](uml/out/01a-use-cases-overview.svg) to [`01e`](uml/out/01e-use-cases-system.svg)), eleven sequences and five activity flows. [`uml/README.md`](uml/README.md) indexes them.

## Decisions taken without the project owner and why

| Decision | Reason |
|---|---|
| SQLite behind an adapter, one file per repository | several OpenCode processes write at once; per-file locks and full scans did not scale (3,000+ records scanned every second) |
| Role checks run in the tool, not by hiding tools | the host API gave no confirmed per-agent tool visibility; the prompt lists only the role's tools |
| Generated pages are opt-in (`render.auto`) | a plugin must not dirty a working tree unasked |
| CLI identity is declared and refused for OpenCode sessions | a Claude Code session has no host-authenticated identity; it must not be able to speak as one that has |
| Reservation of a message for delivery is a direct update, not an event | it is transient and would flood the ledger; it never affects a projection that `rebuild` must reproduce |

## Not done yet

- Archiving a very large ledger as a closed database file.
- Hiding tools per role once the host exposes it.
- A live run inside OpenCode (see the README).
