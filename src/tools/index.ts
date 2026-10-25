import { commonTools } from "./common.ts"
import { coordinatorTools } from "./coordinator.ts"
import { engineerTools } from "./engineer.ts"
import { pmTools } from "./pm.ts"
import type { ToolSpec } from "./define.ts"

export const ALL_TOOLS: ToolSpec[] = [...commonTools, ...engineerTools, ...coordinatorTools, ...pmTools]

const byName = new Map<string, ToolSpec>()
for (const spec of ALL_TOOLS) {
  if (byName.has(spec.name)) throw new Error(`duplicate tool name ${spec.name}`)
  byName.set(spec.name, spec)
}

export function toolByName(name: string): ToolSpec | undefined {
  return byName.get(name.replace(/^coordination_/, ""))
}

export { callTool } from "./define.ts"
export type { ToolSpec, ToolCtx } from "./define.ts"
