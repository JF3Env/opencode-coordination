// One small synchronous SQLite surface over bun:sqlite (inside OpenCode) and node:sqlite (CLI, tests).

export interface Db {
  exec(sql: string): void
  run(sql: string, ...params: unknown[]): void
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[]
  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined
  /** Runs fn atomically. Nested calls become savepoints. fn must be synchronous. */
  transaction<T>(fn: () => T): T
  close(): void
}

interface Statement {
  run(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
}
interface RawDb {
  exec(sql: string): void
  prepare(sql: string): Statement
  close(): void
}

function wrap(raw: RawDb): Db {
  let depth = 0
  return {
    exec: (sql) => raw.exec(sql),
    run: (sql, ...params) => void raw.prepare(sql).run(...params),
    all: <T>(sql: string, ...params: unknown[]) => raw.prepare(sql).all(...params) as T[],
    get: <T>(sql: string, ...params: unknown[]) => raw.prepare(sql).get(...params) as T | undefined,
    transaction<T>(fn: () => T): T {
      const name = `sp${depth}`
      raw.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${name}`)
      depth++
      try {
        const out = fn()
        depth--
        raw.exec(depth === 0 ? "COMMIT" : `RELEASE ${name}`)
        return out
      } catch (error) {
        depth--
        raw.exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO ${name}; RELEASE ${name}`)
        throw error
      }
    },
    close: () => raw.close(),
  }
}

export async function openDb(path: string): Promise<Db> {
  let raw: RawDb
  if ((globalThis as { Bun?: unknown }).Bun) {
    const specifier = "bun:sqlite"
    const mod = (await import(specifier)) as { Database: new (path: string) => RawDb }
    raw = new mod.Database(path)
  } else {
    const { DatabaseSync } = await import("node:sqlite")
    raw = new DatabaseSync(path) as unknown as RawDb
  }
  raw.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;")
  return wrap(raw)
}
