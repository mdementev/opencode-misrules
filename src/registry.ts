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