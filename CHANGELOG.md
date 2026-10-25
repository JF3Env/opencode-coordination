# Changelog

## 0.1.0

First version.

- Append-only SQLite ledger (Node `node:sqlite` and Bun `bun:sqlite`), deterministic projections, `rebuild`.
- 48 tools for engineers, the coordinator and the product manager, with role checks from the session's agent id and refusals recorded as events.
- Work-item life cycle with assignment checks (file overlap, one open item per engineer, holds and freezes), fresh-session assignment, handover and reassignment.
- Deadlines followed by the clock: reminder after one block, escalation after two, stalls, unclaimed assignments, idle engineers, gone sessions.
- GitHub sync through `gh` (link, ready, merged, closed, steward verdict, description check).
- Claude Code bridge on a Unix socket and a CLI sharing the same ledger.
- Generated pages (`ACTIVE`, board, roadmap, status, snapshot) with `render --check`.
- Import of the earlier agent-mail records.
