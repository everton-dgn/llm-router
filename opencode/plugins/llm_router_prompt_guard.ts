import { createRouterPromptGuard } from "../lib/prompt_guard.mjs"

export default async function llmRouterPromptGuard() {
  return createRouterPromptGuard()
}
