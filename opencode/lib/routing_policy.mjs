const mutationVerb = String.raw`(?:add|change|configure|create|delete|edit|fix|implement|install|modify|move|overwrite|patch|refactor|remove|rename|replace|update|write|adicion(?:ar|e)|apag(?:ar|ue)|alter(?:ar|e)|atualiz(?:ar|e)|configur(?:ar|e)|corr(?:igir|ija|ige)|cri(?:ar|e)|edit(?:ar|e)|escrev(?:er|a)|exclu(?:ir|a)|faça|fazer|implement(?:ar|e)|instal(?:ar|e)|modifi(?:car|que)|mov(?:er|a)|refator(?:ar|e)|remov(?:er|a)|renome(?:ar|ie)|sobrescrev(?:er|a)|substitu(?:ir|a))`
const mutationIntent = new RegExp(String.raw`\b${mutationVerb}\b`, "i")
const negatedMutationIntent = new RegExp(
  String.raw`\b(?:(?:do\s+not|don't|never|without|must\s+not|should\s+not|cannot|can't)\s+(?:(?:need\s+to|ever)\s+)?${mutationVerb}|(?:n[aã]o|nunca|sem)\s+(?:(?:deve|dever[aá]|pode|poder[aá]|precisa|v[aá]|quero\s+que)\s+)?${mutationVerb})\b`,
  "gi",
)
const minimaxForbiddenIntent = /\b(?:translate|translation|tradu(?:za|zir|ção)|summar(?:ize|ise|y)|resum(?:a|ir|o)|rewrite|rewriting|reescrev(?:a|er)|document(?:e|ar|ation|ação)|brainstorm|copywriting)\b/i

export const routeTargets = Object.freeze({
  minimax: Object.freeze({
    agent: "minimax",
    providerID: "minimax-coding-plan",
    modelID: "MiniMax-M3",
  }),
  glm: Object.freeze({
    agent: "glm",
    providerID: "zai-coding-plan",
    modelID: "glm-5.2",
  }),
  claude: Object.freeze({
    agent: "claude",
    providerID: "claude-agent",
    modelID: "claude-opus-4-8",
  }),
  codex: Object.freeze({
    agent: "codex",
    providerID: "openai",
    modelID: "gpt-5.6-sol",
  }),
})

export function enforceMinimumRoute(route, request) {
  const affirmativeRequest = request.replace(negatedMutationIntent, "")
  if (
    route === "minimax"
    && (mutationIntent.test(affirmativeRequest) || minimaxForbiddenIntent.test(request))
  ) return "glm"
  return route
}

export function routeTarget(route) {
  const target = routeTargets[route]
  if (!target) throw new Error(`unknown route: ${route}`)
  return target
}
