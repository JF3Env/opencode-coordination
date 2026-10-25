import type { Actor } from "./types.ts"

/** The actor of events the plugin itself produces: deliveries, clock, GitHub sync, renders. */
export const SYSTEM_ACTOR: Actor = { session: "system", name: "coordination", role: "other" }
export const IMPORT_ACTOR: Actor = { session: "import", name: "agent-mail", role: "other" }
