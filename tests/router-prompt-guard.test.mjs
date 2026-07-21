import assert from "node:assert/strict"
import test from "node:test"

import {
  createRouterPromptGuard,
  requireRouterRequest,
} from "../opencode/lib/prompt_guard.mjs"

function userMessage(sessionID, text, agent = "router") {
  return {
    input: { sessionID, agent },
    output: {
      message: { agent },
      parts: [{ type: "text", text }],
    },
  }
}

test("returns the exact captured user request without tool argument injection", async () => {
  const hooks = createRouterPromptGuard()
  const exact = "conte os arquivos; não altere nada \"aqui\""
  const message = userMessage("session-1", exact)
  await hooks["chat.message"](message.input, message.output)

  assert.equal(requireRouterRequest("session-1"), exact)
})

test("keeps requests isolated by session and updates them on each user turn", async () => {
  const hooks = createRouterPromptGuard()
  for (const [sessionID, request] of [["one", "primeiro"], ["two", "segundo"], ["one", "terceiro"]]) {
    const message = userMessage(sessionID, request)
    await hooks["chat.message"](message.input, message.output)
  }

  assert.equal(requireRouterRequest("one"), "terceiro")
  assert.equal(requireRouterRequest("two"), "segundo")
})

test("ignores synthetic text when capturing a request", async () => {
  const hooks = createRouterPromptGuard()
  const message = userMessage("session-1", "original")
  message.output.parts.push({ type: "text", text: "generated", synthetic: true })
  await hooks["chat.message"](message.input, message.output)

  assert.equal(requireRouterRequest("session-1"), "original")
})

test("fails closed when no original router request was captured", async () => {
  const hooks = createRouterPromptGuard()
  assert.throws(
    () => requireRouterRequest("missing"),
    /original router request is unavailable/,
  )
  await hooks.dispose()
})

test("forgets the captured request when a session becomes idle or is deleted", async () => {
  for (const type of ["session.idle", "session.deleted"]) {
    const hooks = createRouterPromptGuard()
    const message = userMessage(type, "original")
    await hooks["chat.message"](message.input, message.output)
    await hooks.event({ event: { type, properties: { sessionID: type } } })

    assert.throws(
      () => requireRouterRequest(type),
      /original router request is unavailable/,
    )
  }
})
