import assert from "node:assert/strict"
import test from "node:test"

import {
  showStartupNotice,
  STARTUP_NOTICE_MESSAGE,
} from "../opencode/lib/startup_notice.mjs"

test("startup notice distinguishes reinstall from restart-only changes", () => {
  assert.match(STARTUP_NOTICE_MESSAGE, /route\/target changes: reinstall, then restart OpenCode/u)
  assert.match(STARTUP_NOTICE_MESSAGE, /project override changes: restart OpenCode/u)
})

test("startup notice does not wait for an unavailable TUI", async () => {
  let called = false
  const pending = new Promise(() => {})

  const result = showStartupNotice(() => {
    called = true
    return pending
  })

  assert.equal(result, undefined)
  await Promise.resolve()
  assert.equal(called, true)
})

test("startup notice absorbs asynchronous TUI failures", async () => {
  showStartupNotice(async () => {
    throw new Error("TUI unavailable")
  })

  await Promise.resolve()
  await Promise.resolve()
})
