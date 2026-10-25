import { createPlugin } from "./host/opencode.ts"

// The OpenCode plugin: roles, work items, messages, progress and history on one append-only ledger.
export default createPlugin()
export { createPlugin }
export type { PluginOptions } from "./host/opencode.ts"
