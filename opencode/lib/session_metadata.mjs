const updatesBySession = new Map()

function requireSessionID(sessionID) {
  if (typeof sessionID !== "string" || !sessionID) {
    throw new Error("OpenCode session ID is required for metadata updates")
  }
}

function exactMetadata(metadata) {
  if (metadata === undefined) return {}
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("OpenCode session metadata is invalid")
  }
  return metadata
}

export async function updateSessionMetadata({
  sessionID,
  readMetadata,
  writeMetadata,
  update,
}) {
  requireSessionID(sessionID)
  for (const [name, value] of Object.entries({ readMetadata, writeMetadata, update })) {
    if (typeof value !== "function") throw new TypeError(`${name} must be a function`)
  }

  const previous = updatesBySession.get(sessionID) ?? Promise.resolve()
  const operation = previous
    .catch(() => undefined)
    .then(async () => {
      const current = exactMetadata(await readMetadata(sessionID))
      const next = exactMetadata(await update(current))
      await writeMetadata(sessionID, next)
      return next
    })

  updatesBySession.set(sessionID, operation)
  try {
    return await operation
  } finally {
    if (updatesBySession.get(sessionID) === operation) {
      updatesBySession.delete(sessionID)
    }
  }
}
