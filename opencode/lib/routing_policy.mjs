const mutationIntent = /\b(?:add|change|configure|create|delete|edit|fix|implement|install|modify|move|overwrite|patch|refactor|remove|rename|replace|update|write|adicion(?:ar|e)|apag(?:ar|ue)|alter(?:ar|e)|atualiz(?:ar|e)|configur(?:ar|e)|corr(?:igir|ija|ige)|cri(?:ar|e)|edit(?:ar|e)|escrev(?:er|a)|exclu(?:ir|a)|faça|fazer|implement(?:ar|e)|instal(?:ar|e)|modifi(?:car|que)|mov(?:er|a)|refator(?:ar|e)|remov(?:er|a)|renome(?:ar|ie)|sobrescrev(?:er|a)|substitu(?:ir|a))\b/i
const claudeMaxEffort = /arquitet|architecture|architectural|produto|product|idea|ideia|brainstorm|copy|venda|sales|marketing|rede social|social media|criativ|creative|roadmap|planej|planning|design|spec|lançamento|launch/i
const claudeXhighEffort = /discuss|debate|trade.?off|pr[oó]s e contras|compare (?:opções|alternativas|abordagens)|policy|política|argument|falsific|open.?ended|decisão operacional/i

export function enforceMinimumRoute(route, stage, request) {
  if (stage === "plan") return "claude"
  if (stage === "execute" && route === "claude") return "codex"
  if (route === "minimax" && (stage === "execute" || mutationIntent.test(request))) return "glm"
  return route
}

export function selectClaudeEffort(stage, request) {
  if (stage === "plan" || claudeMaxEffort.test(request)) return "max"
  if (claudeXhighEffort.test(request)) return "xhigh"
  return "max"
}
