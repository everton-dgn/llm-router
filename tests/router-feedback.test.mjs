import assert from "node:assert/strict"
import test from "node:test"

import {
  createRouterAnnouncer,
  routerStateSignature,
} from "../opencode/lib/router_feedback.mjs"

const state = {
  mode: "adaptive",
  profile: "native",
  providerID: "claude-agent",
  modelID: "claude-opus-5",
}

test("fails closed on an incomplete routing state", () => {
  for (const field of ["mode", "profile", "providerID", "modelID"]) {
    assert.throws(
      () => routerStateSignature({ ...state, [field]: "" }),
      new RegExp(`non-empty ${field}`),
    )
    assert.throws(
      () => routerStateSignature({ ...state, [field]: undefined }),
      new RegExp(`non-empty ${field}`),
    )
  }
})

test("announces only when the mode, profile, or route changes", () => {
  const announcer = createRouterAnnouncer()

  assert.equal(announcer.changed("session-1", state), true)
  assert.equal(announcer.changed("session-1", { ...state }), false)
  assert.equal(announcer.changed("session-1", { ...state, mode: "pinned" }), true)
  assert.equal(announcer.changed("session-1", { ...state, mode: "pinned" }), false)
  assert.equal(
    announcer.changed("session-1", { ...state, mode: "pinned", profile: "restricted" }),
    true,
  )
  assert.equal(
    announcer.changed("session-1", { ...state, mode: "pinned", profile: "restricted", modelID: "glm-5.2" }),
    true,
  )
})

test("tracks each session separately and forgets a finished one", () => {
  const announcer = createRouterAnnouncer()

  assert.equal(announcer.changed("session-1", state), true)
  assert.equal(announcer.changed("session-2", state), true)
  assert.equal(announcer.changed("session-1", state), false)
  assert.equal(announcer.size, 2)

  announcer.forget("session-1")
  assert.equal(announcer.changed("session-1", state), true)
  assert.equal(announcer.changed("session-2", state), false)
})

test("bounds the tracked sessions", () => {
  const announcer = createRouterAnnouncer({ maxSessions: 2 })

  announcer.changed("session-1", state)
  announcer.changed("session-2", state)
  assert.equal(announcer.size, 2)
  announcer.changed("session-3", state)
  assert.equal(announcer.size, 1)
  assert.throws(() => createRouterAnnouncer({ maxSessions: 0 }), /positive integer/)
  assert.throws(() => announcer.changed("", state), /non-empty sessionID/)
})
