const mutationVerb = String.raw`(?:add|change|configure|create|delete|edit|fix|implement|install|modify|move|overwrite|patch|refactor|remove|rename|replace|update|write|adicion(?:ar|e)|apag(?:ar|ue)|alter(?:ar|e)|atualiz(?:ar|e)|configur(?:ar|e)|corr(?:igir|ija|ige)|cri(?:ar|e)|edit(?:ar|e)|escrev(?:er|a)|exclu(?:ir|a)|faça|fazer|implement(?:ar|e)|instal(?:ar|e)|modifi(?:car|que)|mov(?:er|a)|refator(?:ar|e)|remov(?:er|a)|renome(?:ar|ie)|sobrescrev(?:er|a)|substitu(?:ir|a))`
const mutationIntent = new RegExp(String.raw`\b${mutationVerb}\b`, "i")
const negatedMutationIntent = new RegExp(
  String.raw`\b(?:(?:do\s+not|don't|never|without|must\s+not|should\s+not|cannot|can't)\s+(?:(?:need\s+to|ever)\s+)?${mutationVerb}|(?:n[aã]o|nunca|sem)\s+(?:(?:deve|dever[aá]|pode|poder[aá]|precisa|v[aá]|quero\s+que)\s+)?${mutationVerb})\b`,
  "gi",
)
const claudeMaxEffort = /arquitet|architecture|architectural|produto|product|idea|ideia|brainstorm|copy|venda|sales|marketing|rede social|social media|criativ|creative|roadmap|planej|planning|design|spec|lançamento|launch/i
const claudeXhighEffort = /discuss|debate|trade.?off|pr[oó]s e contras|compare (?:opções|alternativas|abordagens)|policy|política|argument|falsific|open.?ended|decisão operacional/i
const minimaxForbiddenIntent = /\b(?:translate|translation|tradu(?:za|zir|ção)|summar(?:ize|ise|y)|resum(?:a|ir|o)|rewrite|rewriting|reescrev(?:a|er)|document(?:e|ar|ation|ação)|brainstorm|copywriting)\b/i

export const routeTargets = Object.freeze({
  minimax: Object.freeze({
    kind: "task",
    subagent_type: "minimax",
    model: "minimax-coding-plan/MiniMax-M3",
  }),
  glm: Object.freeze({
    kind: "task",
    subagent_type: "glm",
    model: "zai-coding-plan/glm-5.2",
  }),
  claude: Object.freeze({
    kind: "tool",
    tool: "claude_agent",
    model: "claude-opus-4-8",
  }),
  codex: Object.freeze({
    kind: "task",
    subagent_type: "codex",
    model: "openai/gpt-5.6-sol",
  }),
  "codex-reviewer": Object.freeze({
    kind: "task",
    subagent_type: "codex-reviewer",
    model: "openai/gpt-5.6-sol",
  }),
})

const escalationTargets = Object.freeze({
  minimax: "glm",
  glm: "codex",
  claude: "codex",
  codex: null,
  "codex-reviewer": null,
})

export function enforceMinimumRoute(route, stage, request) {
  if (stage === "plan") return "claude"
  if (stage === "execute" && route === "claude") return "codex"
  const affirmativeRequest = request.replace(negatedMutationIntent, "")
  if (
    route === "minimax"
    && (stage === "execute" || mutationIntent.test(affirmativeRequest) || minimaxForbiddenIntent.test(request))
  ) return "glm"
  return route
}

export function selectClaudeEffort(stage, request) {
  if (stage === "plan" || claudeMaxEffort.test(request)) return "max"
  if (claudeXhighEffort.test(request)) return "xhigh"
  return "max"
}

export function routeTarget(route) {
  const target = routeTargets[route]
  if (!target) throw new Error(`unknown route: ${route}`)
  return target
}

export function executionPolicy(route) {
  if (!(route in escalationTargets)) throw new Error(`unknown route: ${route}`)
  return {
    retry_limit: 1,
    escalate_to: escalationTargets[route],
  }
}
