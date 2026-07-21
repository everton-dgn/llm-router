const UV_PATH = "__UV_PATH__"
const STAGE_VERIFIER_PATH = "__STAGE_VERIFIER_PATH__"

export function prepareStagePayload(projectRoot, configPath, logPath) {
  return {
    project_root: projectRoot,
    config_path: configPath,
    log_path: logPath,
  }
}

export function verifyStagePayload(baselineId) {
  return { baseline_id: baselineId }
}

export async function runStageVerifier(command, payload, context, timeoutMs = 15 * 60 * 1000) {
  const child = Bun.spawn([
    UV_PATH,
    "run",
    "--no-project",
    "--no-python-downloads",
    "python",
    STAGE_VERIFIER_PATH,
    command,
    "--input",
    "-",
  ], {
    cwd: context.directory,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })

  child.stdin.write(JSON.stringify(payload))
  child.stdin.end()

  let aborted = false
  let timedOut = false
  const abortHandler = () => {
    aborted = true
    child.kill()
  }
  context.abort.addEventListener("abort", abortHandler, { once: true })
  const timeout = setTimeout(() => {
    timedOut = true
    child.kill()
  }, timeoutMs)

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (aborted) throw new Error(`stage verifier ${command} was aborted by the OpenCode session`)
    if (timedOut) throw new Error(`stage verifier ${command} timed out after ${timeoutMs}ms`)

    let result
    try {
      result = JSON.parse(stdout)
    } catch (error) {
      throw new Error(
        `stage verifier ${command} returned invalid JSON with exit ${exitCode}: ${stderr.trim() || stdout.trim() || error.message}`,
      )
    }
    if (!result || typeof result !== "object" || Array.isArray(result) || typeof result.status !== "string") {
      throw new Error(`stage verifier ${command} returned an invalid result contract`)
    }
    if (![0, 1, 2].includes(exitCode)) {
      throw new Error(
        `stage verifier ${command} failed with exit ${exitCode}: ${stderr.trim() || stdout.trim()}`,
      )
    }
    return result
  } finally {
    clearTimeout(timeout)
    context.abort.removeEventListener("abort", abortHandler)
  }
}
