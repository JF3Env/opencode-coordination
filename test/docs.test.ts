import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { toolsDoc } from "../scripts/gen-docs.ts"
import { ALL_TOOLS } from "../src/tools/index.ts"

test("docs/TOOLS.md is the generated tool table: a new or changed tool fails this test until the doc is regenerated", () => {
  assert.equal(readFileSync(new URL("../docs/TOOLS.md", import.meta.url), "utf8"), toolsDoc())
})

test("every tool has a role list, a description that says what it does, and a unique name", () => {
  const names = new Set<string>()
  for (const t of ALL_TOOLS) {
    assert.ok(!names.has(t.name), `duplicate ${t.name}`)
    names.add(t.name)
    assert.ok(t.description.length > 40, `${t.name}: description too short`)
    assert.ok(t.roles === "any" || t.roles.length > 0)
  }
  assert.ok(ALL_TOOLS.length >= 40)
})

test("the name pool has two hundred distinct names", async () => {
  const { NAME_POOL } = await import("../src/domain/names.ts")
  assert.equal(NAME_POOL.length, 200)
  assert.equal(new Set(NAME_POOL).size, 200)
})
