import { tool, type Plugin } from "@opencode-ai/plugin"
import type { Event } from "@opencode-ai/sdk"
import { loadConfig, RuleRegistry } from "../src/registry.ts"

export const Misrules: Plugin = async ({ directory }) => {
  const registry = new RuleRegistry()
  let config = loadConfig(directory)

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
      // opencode mutates the system array in place; push keeps l[0] unchanged
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