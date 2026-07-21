import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { promisify } from "node:util"

import {
  DISALLOWED_TOOLS,
  READ_ONLY_TOOLS,
  buildClaudeQueryOptions,
  consumeClaudeResult,
  enforceClaudeReadOnlyTool,
  isSensitiveClaudePath,
  mapClaudeEffort,
  runClaudeAgentQuery,
} from "../opencode/lib/claude_agent.mjs"

const execFileAsync = promisify(execFile)

function fakeQueryFrom(messages, onClose = () => {}) {
  return () => {
    const stream = (async function* () {
      yield* messages
    })()
    stream.close = async () => onClose()
    return stream
  }
}

test("maps router effort to Agent SDK effort", () => {
  assert.equal(mapClaudeEffort("xhigh"), "xhigh")
  assert.equal(mapClaudeEffort("max"), "max")
  assert.throws(() => mapClaudeEffort("medium"), /Unsupported Claude effort/)
})

test("builds an isolated read-only request configuration", async () => {
  const abortController = new AbortController()
  const options = buildClaudeQueryOptions({
    stage: "request",
    effort: "xhigh",
    cwd: "/tmp/project",
    abortController,
  })

  assert.equal(options.abortController, abortController)
  assert.equal(options.model, "claude-opus-4-8")
  assert.equal(options.effort, "xhigh")
  assert.equal(options.permissionMode, "dontAsk")
  assert.equal(options.persistSession, false)
  assert.equal(options.strictMcpConfig, true)
  assert.deepEqual(options.settingSources, [])
  assert.deepEqual(options.mcpServers, {})
  assert.deepEqual(options.tools, READ_ONLY_TOOLS)
  assert.deepEqual(options.allowedTools, READ_ONLY_TOOLS)
  assert.deepEqual(options.disallowedTools, DISALLOWED_TOOLS)

  assert.equal(options.canUseTool, undefined)
  assert.equal(typeof options.hooks.PreToolUse[0].hooks[0], "function")
  assert.deepEqual(await enforceClaudeReadOnlyTool({ tool_name: "Write" }, process.cwd()), {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Tool Write is not allowed in read-only Claude delegation",
    },
  })
})

test("blocks sensitive, external, and escaping symlink reads", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "claude-guard-workspace-"))
  const external = await mkdtemp(path.join(tmpdir(), "claude-guard-external-"))
  try {
    await writeFile(path.join(workspace, "safe.txt"), "safe\n")
    await writeFile(path.join(workspace, "secret.pem"), "sensitive\n")
    await symlink(external, path.join(workspace, "escape"))
    await symlink(path.join(workspace, "secret.pem"), path.join(workspace, "public.txt"))

    const allow = await enforceClaudeReadOnlyTool(
      { tool_name: "Read", tool_input: { file_path: "safe.txt" } },
      workspace,
    )
    assert.equal(allow.hookSpecificOutput.permissionDecision, "allow")

    for (const filePath of [
      path.join(external, "outside.txt"),
      "escape/outside.txt",
      "public.txt",
      "secret.pem",
      ".env",
      "nested/.env.local",
      ".git/config",
      "credentials.json",
      ".ssh/config",
      ".aws/credentials",
      ".kube/config",
      "service_account-prod.json",
    ]) {
      const decision = await enforceClaudeReadOnlyTool(
        { tool_name: "Read", tool_input: { file_path: filePath } },
        workspace,
      )
      assert.equal(decision.hookSpecificOutput.permissionDecision, "deny", filePath)
    }

    assert.equal(isSensitiveClaudePath("nested/private.key"), true)
    assert.equal(isSensitiveClaudePath("src/public.ts"), false)
  } finally {
    await execFileAsync("trash", [workspace, external])
  }
})

test("uses plan permission mode and rejects unsupported stages", () => {
  const plan = buildClaudeQueryOptions({
    stage: "plan",
    effort: "max",
    cwd: "/tmp/project",
    abortController: new AbortController(),
  })
  assert.equal(plan.permissionMode, "plan")
  assert.equal(plan.effort, "max")

  assert.throws(
    () => buildClaudeQueryOptions({
      stage: "execute",
      effort: "max",
      cwd: "/tmp/project",
      abortController: new AbortController(),
    }),
    /Unsupported Claude stage/,
  )
})

test("returns only the final successful result message", async () => {
  const result = await consumeClaudeResult((async function* () {
    yield { type: "assistant", message: { content: [{ type: "text", text: "intermediate" }] } }
    yield { type: "result", subtype: "success", is_error: false, result: "  final answer  " }
  })())

  assert.equal(result, "final answer")
})

test("rejects missing, failed, error, and empty result messages", async () => {
  await assert.rejects(
    consumeClaudeResult((async function* () { yield { type: "assistant" } })()),
    /without a result message/,
  )
  await assert.rejects(
    consumeClaudeResult((async function* () {
      yield { type: "result", subtype: "error_max_turns", errors: ["turn limit"] }
    })()),
    /error_max_turns: turn limit/,
  )
  await assert.rejects(
    consumeClaudeResult((async function* () {
      yield { type: "result", subtype: "success", is_error: true, result: "billing error" }
    })()),
    /billing error/,
  )
  await assert.rejects(
    consumeClaudeResult((async function* () {
      yield { type: "result", subtype: "success", is_error: false, result: "   " }
    })()),
    /empty response/,
  )
})

test("passes the SDK options, returns success, and closes the query", async () => {
  let received
  let closed = false
  const query = ({ prompt, options }) => {
    received = { prompt, options }
    return fakeQueryFrom([
      { type: "result", subtype: "success", is_error: false, result: "done" },
    ], () => { closed = true })()
  }

  const result = await runClaudeAgentQuery({
    query,
    request: "Plan the migration",
    stage: "plan",
    effort: "max",
    cwd: "/tmp/project",
    parentSignal: new AbortController().signal,
    timeoutMs: 1_000,
  })

  assert.equal(result, "done")
  assert.equal(received.prompt, "Plan the migration")
  assert.equal(received.options.permissionMode, "plan")
  assert.equal(closed, true)
})

test("propagates parent abort and closes the query", async () => {
  const parent = new AbortController()
  let closed = false
  const query = ({ options }) => {
    const stream = (async function* () {
      await new Promise((resolve, reject) => {
        options.abortController.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
      })
    })()
    stream.close = async () => { closed = true }
    return stream
  }

  const pending = runClaudeAgentQuery({
    query,
    request: "Discuss the architecture",
    stage: "request",
    effort: "xhigh",
    cwd: "/tmp/project",
    parentSignal: parent.signal,
    timeoutMs: 1_000,
  })
  parent.abort()

  await assert.rejects(pending, /aborted by the OpenCode session/)
  assert.equal(closed, true)
})

test("enforces timeout and closes the query", async () => {
  let closed = false
  const query = ({ options }) => {
    const stream = (async function* () {
      await new Promise((resolve, reject) => {
        options.abortController.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
      })
    })()
    stream.close = async () => { closed = true }
    return stream
  }

  await assert.rejects(
    runClaudeAgentQuery({
      query,
      request: "Discuss the architecture",
      stage: "request",
      effort: "xhigh",
      cwd: "/tmp/project",
      parentSignal: new AbortController().signal,
      timeoutMs: 10,
    }),
    /timed out after 10ms/,
  )
  assert.equal(closed, true)
})
