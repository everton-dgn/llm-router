/**
 * OpenCode 1.18.4 gives legacy plugins a v1 SDK client even though session
 * selection is exposed only by the v2 SDK. In `opencode run`, that legacy
 * client's protected transport contains the in-process fetch installed by the
 * plugin loader. Reusing it avoids a recursive HTTP request to a listener that
 * does not exist in headless mode.
 *
 * Keep this compatibility seam isolated until PluginInput exposes a public v2
 * client or transport.
 */
export function createOpenCodeV2ClientFromLegacyTransport({
  legacyClient,
  createV2Client,
  directory,
}) {
  const transport = legacyClient?._client
  if (typeof transport?.getConfig !== "function") {
    throw new Error("OpenCode 1.18.4 legacy client transport is unavailable")
  }

  const config = transport.getConfig()
  if (typeof config?.baseUrl !== "string" || !config.baseUrl) {
    throw new Error("OpenCode 1.18.4 legacy client transport has no baseUrl")
  }
  if (typeof config.fetch !== "function") {
    throw new Error("OpenCode 1.18.4 legacy client transport has no fetch function")
  }
  if (typeof createV2Client !== "function") {
    throw new TypeError("createV2Client must be a function")
  }

  return createV2Client({
    baseUrl: config.baseUrl,
    headers: config.headers,
    fetch: config.fetch,
    directory,
  })
}
