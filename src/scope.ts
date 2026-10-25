import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

const run = promisify(execFile)

/** The scope of a directory is its repository: every worktree of one repository shares the git common dir. */
export async function scopeOf(directory: string): Promise<string> {
  try {
    const { stdout } = await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: directory, timeout: 3000 })
    return stdout.trim() || resolve(directory)
  } catch {
    return resolve(directory)
  }
}

export function dataRoot(): string {
  return process.env.COORDINATION_HOME ?? join(homedir(), ".local", "share", "opencode", "coordination")
}

export function ledgerPathFor(scope: string): string {
  return join(dataRoot(), createHash("sha1").update(scope).digest("hex").slice(0, 12), "ledger.db")
}
