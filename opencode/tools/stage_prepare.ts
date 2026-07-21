import { tool } from "@opencode-ai/plugin"
import { prepareStagePayload, runStageVerifier } from "../lib/stage_tools.mjs"

const CONFIG_PATH = "__LLM_ROUTER_CONFIG_PATH__"
const LOG_PATH = "__STAGE_LOG_PATH__"

export default tool({
  description: "Capture a one-shot Git baseline immediately before a GLM or Codex stage that may modify files.",
  args: {},
  async execute(_args, context) {
    const result = await runStageVerifier(
      "prepare",
      prepareStagePayload(context.worktree, CONFIG_PATH, LOG_PATH),
      context,
    )
    return JSON.stringify(result)
  },
})
