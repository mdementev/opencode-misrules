import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { globToRegex, loadConfig, RuleRegistry } from "./misrules.ts"

function setupProject() {
  const dir = mkdtempSync(join(tmpdir(), "misrules-test-"))
  mkdirSync(join(dir, ".opencode"), { recursive: true })
  mkdirSync(join(dir, "docs"), { recursive: true })
  mkdirSync(join(dir, "docs", "nested"), { recursive: true })
  mkdirSync(join(dir, "node_modules"), { recursive: true })
  writeFileSync(join(dir, "docs", "style.md"), "# Style\nUse 2 spaces.")
  writeFileSync(join(dir, "docs", "testing.md"), "# Testing\nUnit tests required.")
  writeFileSync(join(dir, "docs", "nested", "naming.md"), "# Naming\ncamelCase.")
  writeFileSync(join(dir, "docs", "ignore.me"), "not markdown")
  writeFileSync(join(dir, "node_modules", "dep.md"), "should be skipped")
  writeFileSync(join(dir, "docs", ".env.example"), "SECRET=1")
  writeFileSync(join(dir, "docs", "secret.md"), "SHHH")
  writeFileSync(join(dir, ".opencode", "misrules.json"), JSON.stringify({ denyPatterns: ["*.env*", "*secret*"] }))
  return dir
}

test("globToRegex matches with * wildcards", () => {
  assert.equal(globToRegex("*.env*").test(".env.local"), true)
  assert.equal(globToRegex("*.env*").test(".env"), true)
  assert.equal(globToRegex("*.env*").test("styles.env.md"), true)
  assert.equal(globToRegex("*.env*").test("readme.md"), false)
  assert.equal(globToRegex("*secret*").test("my_secret_notes.md"), true)
})

test("loadConfig reads denyPatterns", (t) => {
  const dir = setupProject()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const cfg = loadConfig(dir)
  assert.deepEqual(cfg.denyPatterns, ["*.env*", "*secret*"])
})

test("add: single file, dir expansion, skip rules, relative display", (t) => {
  const dir = setupProject()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const reg = new RuleRegistry()
  const cfg = loadConfig(dir)

  const one = reg.add("s1", ["docs/style.md"], dir, cfg)
  assert.deepEqual(one.added, ["docs/style.md"])

  const all = reg.add("s1", ["docs"], dir, cfg)
  const names = new Set(all.added)
  assert.ok(names.has("docs/testing.md"))
  assert.ok(names.has("docs/nested/naming.md"))
  assert.ok(!names.has("node_modules/dep.md"))
  assert.equal(all.rejected.length, 0)

  assert.deepEqual(reg.list("s1", dir).sort(), [
    "docs/nested/naming.md",
    "docs/style.md",
    "docs/testing.md",
  ])
})

test("add: guards reject missing, non-md, denied", (t) => {
  const dir = setupProject()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const reg = new RuleRegistry()
  const cfg = loadConfig(dir)

  const out = reg.add("s1", ["docs/nope.md", "docs/ignore.me", "docs/secret.md"], dir, cfg)
  assert.deepEqual(out.added, [])
  assert.deepEqual(
    out.rejected.map((r) => r.reason),
    ["path does not exist", "not a .md/.markdown file", "blocked by deny pattern"],
  )
})

test("remove: exact path and directory prefix", (t) => {
  const dir = setupProject()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const reg = new RuleRegistry()
  const cfg = loadConfig(dir)
  reg.add("s1", ["docs"], dir, cfg)

  const r1 = reg.remove("s1", ["docs/style.md"], dir)
  assert.deepEqual(r1.removed, ["docs/style.md"])

  const r2 = reg.remove("s1", ["docs/nested"], dir)
  assert.deepEqual(r2.removed, ["docs/nested/naming.md"])
  assert.deepEqual(reg.list("s1", dir), ["docs/testing.md"])
})

test("block: wraps content with Instructions from", (t) => {
  const dir = setupProject()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const reg = new RuleRegistry()
  reg.add("s1", ["docs/style.md"], dir, loadConfig(dir))
  const block = reg.block("s1")
  assert.ok(block.includes("<misrules loaded=\"docs/style.md\">"))
  assert.ok(block.includes("Instructions from: docs/style.md"))
  assert.ok(block.includes("Use 2 spaces."))
  assert.ok(block.endsWith("</misrules>"))
  assert.equal(reg.block("nope"), "")
})

test("session isolation and drop", (t) => {
  const dir = setupProject()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const reg = new RuleRegistry()
  reg.add("s1", ["docs/style.md"], dir, loadConfig(dir))
  assert.equal(reg.list("s2", dir).length, 0)
  reg.drop("s1")
  assert.equal(reg.list("s1", dir).length, 0)
})
