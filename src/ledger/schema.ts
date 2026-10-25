import type { Db } from "./adapter.ts"

export const SCHEMA_VERSION = 1

// events is the only source of truth: triggers refuse any UPDATE or DELETE. The other tables are projections that
// rebuild() recomputes by replaying events.
export const PROJECTION_TABLES = ["agents", "items", "messages", "decisions", "holds", "measures", "incidents", "owner_orders", "summaries", "fronts"] as const

export function migrate(db: Db): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  at TEXT NOT NULL,
  scope TEXT NOT NULL,
  actor_session TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  type TEXT NOT NULL,
  subject TEXT,
  payload TEXT NOT NULL,
  refs TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_type ON events (type);
CREATE INDEX IF NOT EXISTS events_subject ON events (subject);
CREATE INDEX IF NOT EXISTS events_actor ON events (actor_session);
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

CREATE TABLE IF NOT EXISTS agents (session_id TEXT PRIMARY KEY, name TEXT, role TEXT, status TEXT, seen_at TEXT, doc TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS agents_name ON agents (name);
CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, state TEXT NOT NULL, assignee TEXT, front TEXT, doc TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS items_state ON items (state);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, short TEXT NOT NULL, to_id TEXT, from_id TEXT, item TEXT, kind TEXT,
  at TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, reserved_until TEXT,
  needs_answer_by TEXT, answered INTEGER NOT NULL DEFAULT 0, doc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_pending ON messages (to_id, delivered);
CREATE INDEX IF NOT EXISTS messages_short ON messages (short);
CREATE INDEX IF NOT EXISTS messages_open ON messages (answered, needs_answer_by);
CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, doc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS holds (id TEXT PRIMARY KEY, active INTEGER NOT NULL, doc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS measures (id TEXT PRIMARY KEY, name TEXT NOT NULL, front TEXT, at TEXT NOT NULL, doc TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS measures_name ON measures (name, at);
CREATE TABLE IF NOT EXISTS incidents (id TEXT PRIMARY KEY, doc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS owner_orders (id TEXT PRIMARY KEY, doc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS summaries (key TEXT PRIMARY KEY, doc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS fronts (id TEXT PRIMARY KEY, doc TEXT NOT NULL);
`)
  db.run("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)", String(SCHEMA_VERSION))
}

export function dropProjections(db: Db): void {
  for (const table of PROJECTION_TABLES) db.exec(`DELETE FROM ${table}`)
}
