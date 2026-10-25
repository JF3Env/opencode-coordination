import type { z } from "zod"
import type { Actor, Role } from "../domain/types.ts"
import { SYSTEM_ACTOR } from "../domain/system.ts"
import { ToolFailure, type Runtime } from "../runtime.ts"

export interface ToolCtx {
  rt: Runtime
  actor: Actor
}

export interface ToolSpec {
  name: string
  roles: readonly Role[] | "any"
  description: string
  input: z.ZodObject<any>
  run(ctx: ToolCtx, input: any): Promise<string> | string
}

export function tool<S extends z.ZodObject<any>>(spec: {
  name: string
  roles: readonly Role[] | "any"
  description: string
  input: S
  run: (ctx: ToolCtx, input: z.output<S>) => Promise<string> | string
}): ToolSpec {
  return spec as unknown as ToolSpec
}

export function roleLabel(spec: ToolSpec): string {
  return spec.roles === "any" ? "any role" : spec.roles.join(" or ")
}

function refuse(rt: Runtime, spec: ToolSpec, actor: Actor, reason: string): never {
  try {
    rt.ledger.append({ type: "tool.refused", actor, payload: { tool: spec.name, reason } })
  } catch {
    // A refusal must reach the caller even when the audit write fails.
  }
  throw new ToolFailure(reason)
}

/** Runs one tool: checks the role from the session's agent, validates the input, records refusals as events. */
export async function callTool(rt: Runtime, spec: ToolSpec, actor: Actor, raw: unknown): Promise<string> {
  if (spec.roles !== "any" && !spec.roles.includes(actor.role)) {
    refuse(rt, spec, actor, `${spec.name} may be used only by ${roleLabel(spec)}. This session is ${actor.role}.`)
  }
  const parsed = spec.input.safeParse(raw ?? {})
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")
    refuse(rt, spec, actor, `Invalid input for ${spec.name}: ${issues}`)
  }
  try {
    return await spec.run({ rt, actor }, parsed.data)
  } catch (error) {
    if (error instanceof ToolFailure) refuse(rt, spec, actor, error.message)
    throw error
  }
}

export { SYSTEM_ACTOR }
