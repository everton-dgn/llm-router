export const STARTUP_NOTICE_MESSAGE = "config.json route/target changes: reinstall, then restart OpenCode. Intent/capability or project override changes: restart OpenCode."

export function showStartupNotice(notify) {
  if (typeof notify !== "function") {
    throw new TypeError("startup notice callback must be a function")
  }
  void Promise.resolve()
    .then(notify)
    .catch(() => {})
}
