function messageText(parts) {
  return parts
    .filter((part) => (
      part?.type === "text"
      && part.synthetic !== true
      && part.ignored !== true
      && typeof part.text === "string"
    ))
    .map((part) => part.text)
    .join("")
}

function validateCurrentUserMessage(message) {
  if (message?.info?.role !== "user" || !Array.isArray(message.parts)) {
    throw new Error("Claude adapter could not resolve the current user message")
  }
  if (message.parts.some((part) => part?.type === "file")) {
    throw new Error("Claude adapter does not accept file attachments")
  }
  const unsupported = message.parts.find((part) => part?.type !== "text")
  if (unsupported) {
    throw new Error(`Claude adapter does not accept current user part: ${unsupported.type ?? "unknown"}`)
  }
  if (message.parts.some((part) => part.synthetic === true || part.ignored === true)) {
    throw new Error("Claude adapter does not accept synthetic current user context")
  }
}

export function buildSafeClaudeConversation(messages, currentMessageID) {
  if (!Array.isArray(messages)) {
    throw new Error("OpenCode returned invalid messages for Claude context")
  }
  if (typeof currentMessageID !== "string" || !currentMessageID) {
    throw new Error("Claude adapter requires the current OpenCode message ID")
  }

  const current = messages.find((message) => message?.info?.id === currentMessageID)
  validateCurrentUserMessage(current)

  const conversation = []
  for (const message of messages) {
    const role = message?.info?.role
    if (role !== "user" && role !== "assistant") continue
    if (role === "assistant" && message.info.summary === true) continue
    if (!Array.isArray(message.parts)) continue
    const content = messageText(message.parts)
    if (!content.trim()) continue
    conversation.push({ role, content })
  }

  const last = conversation.at(-1)
  if (last?.role !== "user" || last.content !== messageText(current.parts)) {
    throw new Error("Claude context does not end with the current user message")
  }
  return conversation
}
