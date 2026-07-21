import { tool } from "@opencode-ai/plugin"
import { runStageVerifier, verifyStagePayload } from "../lib/stage_tools.mjs"

export default tool({
  description: "Consume one stage baseline, detect its exact Git delta, and run every applicable deterministic gate.",
  args: {
    baseline_id: tool.schema.string().regex(/^[a-f0-9]{32}$/).describe("Opaque one-shot baseline identifier returned by stage_prepare"),
  },
  async execute(args, context) {
    const result = await runStageVerifier(
      "verify",
      verifyStagePayload(args.baseline_id),
      context,
    )
    return JSON.stringify(result)
  },
})
