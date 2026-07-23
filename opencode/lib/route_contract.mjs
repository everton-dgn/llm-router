const allowedRoutes = new Set(["minimax", "glm", "claude", "codex"])
const allowedKeys = new Set(["schema_version", "intent", "route"])
export const MAX_CLASSIFIER_REQUEST_BYTES = 128 * 1024

export function assertClassifierRequestSize(request) {
  if (typeof request !== "string" || request.length === 0) {
    throw new Error("llm-router classifier request must be non-empty text")
  }
  const size = Buffer.byteLength(request, "utf8")
  if (size > MAX_CLASSIFIER_REQUEST_BYTES) {
    throw new Error(
      `llm-router classifier request exceeds ${MAX_CLASSIFIER_REQUEST_BYTES} UTF-8 bytes`,
    )
  }
  return size
}

export function parseClassifierResult(raw) {
  let value
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new Error(`llm-router returned invalid JSON: ${error.message}`)
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("llm-router result must be a JSON object")
  }
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key))
  if (unknownKeys.length > 0) {
    throw new Error(`llm-router result contains unknown fields: ${unknownKeys.join(", ")}`)
  }
  if (value.schema_version !== 1) {
    throw new Error(`unsupported llm-router schema_version: ${String(value.schema_version)}`)
  }
  if (typeof value.intent !== "string" || value.intent.length === 0) {
    throw new Error("llm-router result has an invalid intent")
  }
  if (typeof value.route !== "string" || !allowedRoutes.has(value.route)) {
    throw new Error(`llm-router result has an invalid route: ${String(value.route)}`)
  }
  return value
}
