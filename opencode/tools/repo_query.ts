import { tool } from "@opencode-ai/plugin"
import { runRepositoryQuery } from "../lib/repo_query.mjs"

export default tool({
  description: "Safely inspect repository state and non-sensitive versioned or untracked files without a shell. Supports status, files, read_file, literal search, diff, log, and largest_files_by_lines.",
  args: {
    action: tool.schema.enum(["status", "files", "read_file", "search", "diff", "log", "largest_files_by_lines"]),
    path: tool.schema.string().optional().describe("Relative file or directory filter inside the worktree"),
    include_untracked: tool.schema.boolean().optional().describe("Include non-ignored untracked files; defaults to false"),
    query: tool.schema.string().optional().describe("Literal text for the search action"),
    case_sensitive: tool.schema.boolean().optional(),
    line_start: tool.schema.number().int().optional(),
    line_end: tool.schema.number().int().optional(),
    max_results: tool.schema.number().int().optional(),
  },
  async execute(args, context) {
    return JSON.stringify(await runRepositoryQuery(args, context.worktree))
  },
})
