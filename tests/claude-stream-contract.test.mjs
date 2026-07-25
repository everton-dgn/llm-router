import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { homedir } from "node:os"
import path from "node:path"
import { test } from "node:test"

import { buildClaudeEnvironment } from "../opencode/lib/claude_agent.mjs"
import { serializeClaudePrompt } from "../opencode/providers/claude_agent_provider.mjs"

// Unit tests only prove that the adapter emits the shapes it intends to emit.
// Claude Code owns the streaming-input parser, and it rejected the assistant
// history the adapter used to send, so every handoff after an assistant turn
// died with exit code 1. This suite feeds the real binary the exact transcript
// the adapter produces.
//
// Every message is replayed with shouldQuery set to false, so the parser
// validates the whole transcript and the session ends without a model call:
// the run reports num_turns 0 and total_cost_usd 0.

const CLAUDE_PATH = process.env.LLM_ROUTER_CLAUDE_PATH ?? "claude"
const CLAUDE_TIMEOUT_MS = 120_000

const CLAUDE_ARGS = [
  "--print",
  "--verbose",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--setting-sources",
  "",
  "--safe-mode",
  "--no-chrome",
]

const currentPrompt = [
  { role: "user", content: [{ type: "text", text: "responda apenas: pronto" }] },
]

const history = [
  { role: "user", content: [{ type: "text", text: "pedido anterior" }] },
  { role: "assistant", content: [{ type: "text", text: "resposta anterior" }] },
  { role: "user", content: [{ type: "text", text: "responda apenas: pronto" }] },
]

async function collectSDKMessages(request) {
  const messages = []
  for await (const message of request) messages.push(message)
  return messages
}

function replayOnly(messages) {
  return `${messages
    .map((message) => JSON.stringify(
      message.type === "user" ? { ...message, shouldQuery: false } : message,
    ))
    .join("\n")}\n`
}

function runClaude(input, { args = CLAUDE_ARGS, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_PATH, args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...(env ? { env } : {}),
    })
    let stdout = ""
    let stderr = ""
    const timeout = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`Claude Code did not answer within ${CLAUDE_TIMEOUT_MS}ms`))
    }, CLAUDE_TIMEOUT_MS)

    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.on("error", (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on("close", (code) => {
      clearTimeout(timeout)
      resolve({ code, stdout, stderr })
    })
    child.stdin.end(input)
  })
}

async function claudeIsAvailable() {
  try {
    const { code } = await runClaudeVersion()
    return code === 0
  } catch {
    return false
  }
}

function runClaudeVersion() {
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_PATH, ["--version"], { stdio: ["ignore", "ignore", "ignore"] })
    child.on("error", reject)
    child.on("close", (code) => resolve({ code }))
  })
}

function resultMessages(stdout) {
  return stdout
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return undefined
      }
    })
    .filter((message) => message?.type === "result")
}

test("Claude Code accepts the transcript the adapter serializes", async (t) => {
  if (!await claudeIsAvailable()) {
    t.skip(`Claude Code is not executable at ${CLAUDE_PATH}`)
    return
  }

  const serialized = serializeClaudePrompt(currentPrompt, history)
  const messages = await collectSDKMessages(serialized.request)
  assert.deepEqual(
    messages.map((message) => message.type),
    ["user", "assistant", "user"],
  )

  const { code, stdout, stderr } = await runClaude(replayOnly(messages))
  const output = `${stdout}\n${stderr}`

  assert.doesNotMatch(output, /Expected message role/)
  assert.doesNotMatch(output, /Error parsing streaming input line/)
  assert.equal(code, 0, `Claude Code exited with ${code}: ${stderr.trim() || "no stderr"}`)

  const results = resultMessages(stdout)
  assert.ok(results.length > 0, "Claude Code returned no result message")
  for (const result of results) {
    assert.equal(result.is_error, false)
    assert.equal(result.subtype, "success")
    // The replayed transcript must not reach the model, otherwise this check
    // would bill a request on every run.
    assert.equal(result.num_turns, 0)
    assert.equal(result.total_cost_usd, 0)
  }
})

// The adapter filters the environment before spawning Claude Code, and OpenCode
// starts from a desktop app that never exports CLAUDE_CONFIG_DIR. Claude Code
// then reads a profile with no session and answers every handoff with
// "OAuth session expired and could not be refreshed". `auth status` costs
// nothing and reads the same profile the transport will use.
test("Claude Code is signed in under the environment the adapter builds", async (t) => {
  if (!await claudeIsAvailable()) {
    t.skip(`Claude Code is not executable at ${CLAUDE_PATH}`)
    return
  }

  // Only the variables a desktop-launched process is guaranteed to carry. USER
  // matters on macOS, where the credential lives in the login keychain under
  // that account name.
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude")
  const env = buildClaudeEnvironment(
    {
      HOME: homedir(),
      PATH: process.env.PATH ?? "",
      USER: process.env.USER ?? "",
    },
    { configDir },
  )

  const { code, stdout, stderr } = await runClaude("", { args: ["auth", "status"], env })
  assert.equal(code, 0, `claude auth status exited with ${code}: ${stderr.trim() || "no stderr"}`)

  const status = JSON.parse(stdout)
  assert.equal(
    status.loggedIn,
    true,
    `Claude Code is not signed in for ${configDir}. `
      + `Run: CLAUDE_CONFIG_DIR=${configDir} claude auth login`,
  )
})

test("Claude Code still rejects an assistant turn inside a user envelope", async (t) => {
  if (!await claudeIsAvailable()) {
    t.skip(`Claude Code is not executable at ${CLAUDE_PATH}`)
    return
  }

  // The control for the check above: without it, a parser that accepted every
  // shape would make the previous test pass for the wrong reason. If this ever
  // fails, Claude Code started accepting the legacy envelope and the adapter's
  // assistant replay became optional rather than required.
  const legacy = [
    {
      type: "user",
      message: { role: "assistant", content: [{ type: "text", text: "resposta anterior" }] },
      parent_tool_use_id: null,
      shouldQuery: false,
    },
    {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "responda apenas: pronto" }] },
      parent_tool_use_id: null,
      origin: { kind: "human" },
      shouldQuery: false,
    },
  ]

  const { stdout, stderr } = await runClaude(replayOnly(legacy))
  assert.match(`${stdout}\n${stderr}`, /Expected message role 'user', got 'assistant'/)
})
