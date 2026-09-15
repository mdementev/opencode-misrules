import { tool, type Plugin, type PluginModule } from "@opencode-ai/plugin"
import type { Event } from "@opencode-ai/sdk"
import { accessSync, constants, readdirSync, readFileSync, statSync, type Dirent } from "node:fs"
import { homedir } from "node:os"
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path"

export const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"])

const SKIP_DIRS = new Set([".git", "node_modules", "dist"])

export type MisrulesConfig = {
  denyPatterns: string[]
}

export type RuleRecord = {
  absolute: string
  display: string
  content: string
}

export type AddOutcome = {
  added: string[]
  rejected: Array<{ path: string; reason: string }>
  emptyDirs: string[]
}

export type RemoveOutcome = {
  removed: string[]
  notFound: string[]
}

function isMarkdown(name: string): boolean {
  const lower = name.toLowerCase()
  for (const ext of MARKDOWN_EXTENSIONS) {
    if (lower.endsWith(ext)) return true
  }
  return false
}

function isSkippedDir(name: string): boolean {
  return name.startsWith(".") || SKIP_DIRS.has(name)
}

export function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  return new RegExp("^" + escaped.replace(/\*/g, ".*") + "$")
}

function matchesDeny(file: string, config: MisrulesConfig): boolean {
  const base = basename(file)
  for (const pattern of config.denyPatterns) {
    const re = globToRegex(pattern)
    if (re.test(base) || re.test(file.replace(sep, "/"))) return true
  }
  return false
}

function displayPath(directory: string, absolute: string): string {
  const rel = relative(directory, absolute)
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : absolute
}

export function loadConfig(directory: string): MisrulesConfig {
  const candidates = [
    join(directory, ".opencode", "misrules.json"),
    join(homedir(), ".config", "opencode", "misrules.json"),
  ]
  for (const file of candidates) {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as { denyPatterns?: unknown }
      const denyPatterns = Array.isArray(raw.denyPatterns)
        ? raw.denyPatterns.filter((p) => typeof p === "string" && p.trim()).map((p) => p.trim())
        : []
      return { denyPatterns }
    } catch {
      return { denyPatterns: [] }
    }
  }
  return { denyPatterns: [] }
}

function collectMarkdown(rootDir: string, config: MisrulesConfig): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    let entries: Dirent[] = []
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as Dirent[]
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!isSkippedDir(entry.name)) walk(full)
      } else if (entry.isFile() && isMarkdown(entry.name) && !matchesDeny(full, config)) {
        out.push(full)
      }
    }
  }
  walk(rootDir)
  return out
}

export class RuleRegistry {
  private sessions = new Map<string, Map<string, RuleRecord>>()

  private mapFor(sessionID: string): Map<string, RuleRecord> {
    let map = this.sessions.get(sessionID)
    if (!map) {
      map = new Map()
      this.sessions.set(sessionID, map)
    }
    return map
  }

  add(
    sessionID: string,
    inputs: string[],
    directory: string,
    config: MisrulesConfig,
  ): AddOutcome {
    const outcome: AddOutcome = { added: [], rejected: [], emptyDirs: [] }
    const store = this.mapFor(sessionID)
    const seen = new Set<string>()

    for (const input of inputs) {
      const absolute = resolve(directory, input.trim())
      if (seen.has(absolute)) continue
      seen.add(absolute)

      let stats: ReturnType<typeof statSync>
      try {
        stats = statSync(absolute)
      } catch {
        outcome.rejected.push({ path: input, reason: "path does not exist" })
        continue
      }

      let files: string[]
      if (stats.isDirectory()) {
        files = collectMarkdown(absolute, config)
        if (files.length === 0) {
          outcome.emptyDirs.push(input)
          continue
        }
      } else if (stats.isFile()) {
        if (!isMarkdown(absolute)) {
          outcome.rejected.push({
            path: input,
            reason: "not a .md/.markdown file",
          })
          continue
        }
        if (matchesDeny(absolute, config)) {
          outcome.rejected.push({ path: input, reason: "blocked by deny pattern" })
          continue
        }
        files = [absolute]
      } else {
        outcome.rejected.push({ path: input, reason: "not a file or directory" })
        continue
      }

      for (const file of files) {
        try {
          accessSync(file, constants.R_OK)
          const content = readFileSync(file, "utf8")
          store.set(file, { absolute: file, display: displayPath(directory, file), content })
          outcome.added.push(displayPath(directory, file))
        } catch {
          outcome.rejected.push({ path: file, reason: "exists but is not readable" })
        }
      }
    }

    if (store.size === 0) this.sessions.delete(sessionID)
    return outcome
  }

  remove(sessionID: string, inputs: string[], directory: string): RemoveOutcome {
    const outcome: RemoveOutcome = { removed: [], notFound: [] }
    const store = this.sessions.get(sessionID)
    if (!store) return outcome

    for (const input of inputs) {
      const absolute = resolve(directory, input.trim())
      let removedAny = false
      for (const [key, record] of [...store.entries()]) {
        if (key === absolute || key.startsWith(absolute + sep)) {
          store.delete(key)
          outcome.removed.push(record.display)
          removedAny = true
        }
      }
      if (!removedAny) outcome.notFound.push(input)
    }

    if (store.size === 0) this.sessions.delete(sessionID)
    return outcome
  }

  list(sessionID: string, directory: string): string[] {
    const store = this.sessions.get(sessionID)
    if (!store) return []
    return [...store.values()].map((r) => r.display)
  }

  drop(sessionID: string): void {
    this.sessions.delete(sessionID)
  }

  block(sessionID: string): string {
    const store = this.sessions.get(sessionID)
    if (!store || store.size === 0) return ""
    const names = [...store.values()].map((r) => r.display).join(", ")
    const parts = [...store.values()].map(
      (r) => `Instructions from: ${r.display}\n${r.content}`,
    )
    return `<misrules loaded="${names}">\n${parts.join("\n---\n")}\n</misrules>`
  }
}

export const Misrules: Plugin = async ({ directory }) => {
  const registry = new RuleRegistry()
  const config = loadConfig(directory)

  const addTool = tool({
    description:
      "Register the given markdown files (paths or directory names) as persistent session rules. " +
      "Their content is included in the model's system prompt on every subsequent step of this session, including after compaction. " +
      "Accepts files and directories; directories are scanned recursively for .md/.markdown files. " +
      "Only existing, readable .md/.markdown files are accepted; anything else is rejected with a reason. " +
      "Load exactly what was requested: use only paths you have verified by reading the filesystem, and do not add or expand anything on your own.",
    args: {
      paths: tool.schema
        .array(tool.schema.string().min(1))
        .min(1)
        .describe(
          "Absolute paths or project-relative paths to markdown files or directories to register as rules",
        ),
    },
    async execute({ paths }, ctx) {
      const outcome = registry.add(ctx.sessionID, paths, ctx.directory, config)
      const parts: string[] = []
      if (outcome.added.length > 0) {
        parts.push(`Registered ${outcome.added.length} rule file(s):\n- ${outcome.added.join("\n- ")}`)
      }
      if (outcome.rejected.length > 0) {
        parts.push(
          `Rejected ${outcome.rejected.length}:\n- ${outcome.rejected
            .map((r) => `${r.path} (${r.reason})`)
            .join("\n- ")}`,
        )
      }
      if (outcome.emptyDirs.length > 0) {
        parts.push(
          `No .md/.markdown files found in:\n- ${outcome.emptyDirs.join("\n- ")}`,
        )
      }
      if (parts.length === 0) parts.push("Nothing to register.")
      return { output: parts.join("\n\n") }
    },
  })

  const removeTool = tool({
    description:
      "Unregister previously registered session rules by exact file path or directory prefix. " +
      "Removes exactly what was requested, nothing else.",
    args: {
      paths: tool.schema
        .array(tool.schema.string().min(1))
        .min(1)
        .describe("Absolute or project-relative paths (or directory prefixes) of rules to unregister"),
    },
    async execute({ paths }, ctx) {
      const outcome = registry.remove(ctx.sessionID, paths, ctx.directory)
      const parts: string[] = []
      if (outcome.removed.length > 0) {
        parts.push(`Unregistered ${outcome.removed.length} rule file(s):\n- ${outcome.removed.join("\n- ")}`)
      }
      if (outcome.notFound.length > 0) {
        parts.push(`Not registered:\n- ${outcome.notFound.join("\n- ")}`)
      }
      if (parts.length === 0) parts.push("No rules were registered.")
      return { output: parts.join("\n\n") }
    },
  })

  const listTool = tool({
    description:
      "List the markdown files currently registered as session rules. Returns only file paths, nothing else.",
    args: {},
    async execute(_args, ctx) {
      const items = registry.list(ctx.sessionID, ctx.directory)
      return {
        output:
          items.length === 0
            ? "No rules registered in this session."
            : `Registered rules (${items.length}):\n- ${items.join("\n- ")}`,
      }
    },
  })

  return {
    tool: {
      misrules_add: addTool,
      misrules_remove: removeTool,
      misrules_list: listTool,
    },
    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return
      const block = registry.block(input.sessionID)
      if (!block) return
      output.system.push(block)
    },
    "experimental.session.compacting": async (input, output) => {
      const items = registry.list(input.sessionID, directory)
      if (items.length === 0) return
      output.context.push(
        "The following misrules files are loaded in this session and stay in effect: " +
          items.join(", "),
      )
    },
    event: async ({ event: ev }: { event: Event }) => {
      if (ev.type === "session.deleted") {
        registry.drop(ev.properties.info.id)
      }
    },
  }
}

export default {
  id: "opencode-misrules",
  server: Misrules,
} satisfies PluginModule
