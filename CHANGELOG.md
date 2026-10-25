# Changelog

## Unreleased

- The duplicate and burst gates and the length limit now apply only to free text written by an agent (`ask`, `answer`). A message a tool composes after it recorded a change is never refused: a coordinator deferring eleven proposals in a row had every change recorded, ten of them never told the product manager, and each call returned an error. A tool notification over the limit is cut with a pointer to `coordination_item` instead of failing.
- The role is bound to the agent a session started with: an agent switch inside the session is recorded as `agent.role_denied` and ignored, subagents never hold a role, and tools run with the role the ledger holds, not the agent id of the call. CLI and Claude Code identities hold only the role the profile's new `cli` block grants their name; `--role` only checks it. The README says where this is a guard and where it is not, with the OpenCode permission rule that closes the shell path for engineers.
- A blocked item no longer uses up the engineer's open-item slot, so the coordinator can assign other work while it waits.
- `ready` without a GitHub link keeps the pull-request number given; the assignment clears the engineer's availability flag, so idleness is counted from the next availability.
- Answering a resent question closes the original, and the resent text names the record it repeats.
- A session that comes back after being gone keeps its name; the profile's role aliases are valid addresses for `ask`.
- GitHub: a pull request is fetched by number or head branch (not only among the hundred most recent), `github.baseBranch` replaces the hard-coded `main`, a steward comment that requests changes returns the item to work once, and a merge of an item assigned but never claimed is recorded.
- The status line check accepts `and/or`, `24/7` and plain figures; only real codes, paths and hashes are refused.
- The plugin's own follow-ups are exempt from the burst gate; a CLI identity is never steered as a session; event-type filters match exactly; the CLI entry point resolves its own path safely.
- The transition table and the item state diagram now show every move the tools and the GitHub sync make.

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
