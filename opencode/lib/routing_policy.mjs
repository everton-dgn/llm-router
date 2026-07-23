const portugueseMutationVerb = String.raw`(?:adicion(?:ar|e|a)|apag(?:ar|ue|a)|alter(?:ar|e|a)|atualiz(?:ar|e|a)|configur(?:ar|e|a)|corr(?:igir|ija|ige)|cri(?:ar|e|a)|edit(?:ar|e|a)|escrev(?:er|a|e)|exclu(?:ir|a|i)|faça|fazer|faz|implement(?:ar|e|a)|instal(?:ar|e|a)|modifi(?:car|que|ca)|mov(?:er|a|e)|refator(?:ar|e|a)|remov(?:er|a|e)|renome(?:ar|ie|ia)|sobrescrev(?:er|a|e)|substitu(?:ir|a|i))`
const mutationVerb = String.raw`(?:add|change|configure|create|delete|edit|fix|implement|install|modify|move|overwrite|patch|refactor|remove|rename|replace|update|write|${portugueseMutationVerb})`
const mutationIntent = new RegExp(String.raw`\b${mutationVerb}\b`, "i")
const negatedMutationIntent = new RegExp(
  String.raw`\b(?:(?:do\s+not|don't|never|without|must\s+not|should\s+not|cannot|can't|neither)\s+(?:(?:need\s+to|ever)\s+)?${mutationVerb}|(?:n[aã]o|nunca|sem|nem)\s+(?:(?:deve|dever[aá]|pode|poder[aá]|precisa|v[aá]|quero\s+que)\s+)?${mutationVerb})\b`,
  "gi",
)
const coordinatedNegatedMutationIntent = new RegExp(
  String.raw`\b(?:nem|nor|or|ou)\s+${mutationVerb}\b`,
  "gi",
)
const conceptualExplanationIntent = /\b(?:define|describe|discuss|explain|defina|descreva|discuta|explique|what\s+(?:does|is|are)|how\s+does|o\s+que\s+(?:faz|é|significa))\b/i
const planningCreationVerb = String.raw`(?:create|write|draft|prepare|produce|cri(?:ar|e|a)|escrev(?:er|a|e)|redij(?:a|ir)|elabor(?:e|ar|a))`
const planningDeliverable = String.raw`(?:plans?|adrs?|proposals?|strateg(?:y|ies)|roadmaps?|architecture\s+documents?|planos?|propostas?|estrat[eé]gias?|roadmaps?|documentos?\s+de\s+arquitetura)`
const planningDeliverableIntent = new RegExp(
  String.raw`\b(?:${planningCreationVerb})\b[\s\S]{0,60}\b(?:${planningDeliverable})\b`,
  "i",
)
const projectMutationObject = String.raw`(?:files?|folders?|directories?|paths?|source\s+code|code|configs?|configurations?|settings?|dependencies?|packages?|tests?|functions?|classes?|modules?|components?|endpoints?|apis?|schemas?|migrations?|databases?|branches?|readme|scripts?|servers?|routers?|plugins?|bugs?|issues?|race\s+conditions?|fix(?:es)?|corrections?|arquivos?|pastas?|diret[oó]rios?|caminhos?|c[oó]digo(?:-fonte)?|configs?|configuraç(?:ão|ões)|depend[eê]ncias?|pacotes?|testes?|funç(?:ão|ões)|classes?|m[oó]dulos?|componentes?|endpoints?|esquemas?|migraç(?:ão|ões)|bancos?\s+de\s+dados|branches?|scripts?|servidores?|roteadores?|plugins?|bugs?|erros?|falhas?|condiç(?:ão|ões)\s+de\s+corrida|correç(?:ão|ões)|readme|[\w./-]+\.(?:[cm]?[jt]sx?|jsonc?|ya?ml|toml|md|py|rb|go|rs|java|kt|swift|sh|css|scss|html))`
const inherentlyProjectMutationVerb = String.raw`(?:install|patch|refactor|instal(?:ar|e|a)|refator(?:ar|e|a))`
const projectMutationIntent = new RegExp(
  String.raw`\b(?:${inherentlyProjectMutationVerb})\b|\b(?:${mutationVerb})\b[\s\S]{0,80}\b(?:${projectMutationObject})\b|\b(?:${projectMutationObject})\b[\s\S]{0,80}\b(?:${mutationVerb})\b|\b(?:do|faça|faz)\s+(?:it\s+all|everything|logo\s+(?:tudo|td))\b`,
  "i",
)
const mutationComparisonMention = new RegExp(
  String.raw`\b(?:(?:the\s+)?differences?\s+between|(?:a\s+)?diferen[çc]as?\s+entre)\s+(?:${mutationVerb})\s+(?:and|or|e|ou)\s+(?:${mutationVerb})\b`,
  "gi",
)
const minimaxForbiddenIntent = /\b(?:translate|translation|tradu(?:za|zir|ção)|summar(?:ize|ise|y)|resum(?:a|ir|o)|rewrite|rewriting|reescrev(?:a|er)|document(?:e|ar|ation|ação)|brainstorm|copywriting|naming|(?:product|brand|company|feature)\s+names?|nomes?\s+(?:para|de)\s+(?:(?:o|a)\s+)?(?:produto|marca|empresa|recurso|funcionalidade))\b/i
const nonLiteralTextIntent = /\b(?:analy[sz]e|architect|brainstorm|compare|critique|discuss|draft|evaluate|explain|plan|reason|recommend|review|suggest|write|ideas?|strateg(?:y|ies)|sales\s+copy|pros?\s+and\s+cons|stories?|poems?|articles?|analise|arquitet(?:e|ar)|compare|critique|discuta|avalie|explique|planeje|raciocine|recomende|revise|sugira|ideias?|estrat[eé]gias?|plano|pr[oó]s\s+e\s+contras|conte[uú]do)\b/i
const literalReadOnlyIntent = /\b(?:count|list|find|locate|search|extract|format|show|identify|return|sort|filter|conte|quantos?|liste|busque|procure|localize|extraia|formate|mostre|identifique|retorne|ordene|filtre|qual\s+(?:é\s+)?(?:a\s+)?vers[aã]o|what\s+version|o\s+que\s+significa|what\s+does[\s\S]{0,80}\s+mean)\b/i
const repositoryInspectionVerb = String.raw`(?:inspect|read|check|search|find|scan|review|open|list|count|verify|look\s+at|inspecion(?:e|ar|a)|leia|ler|l[eê]|verifi(?:que|car|ca)|bus(?:que|car|ca)|procur(?:e|ar|a)|vasculh(?:e|ar|a)|revis(?:e|ar|a)|abr(?:a|ir|e)|list(?:e|ar|a)|cont(?:e|ar|a)|analis(?:e|ar|a))`
const repositoryResource = String.raw`(?:repo(?:sitor(?:y|ies))?|codebase|workspace|source\s+code|code|projects?|project\s+files?|package\.json|readme(?:\.md)?|reposit[oó]rios?|projetos?|c[oó]digo(?:[-\s]+fonte)?|arquivos?\s+(?:do|deste|desse)\s+projeto|[\w./-]+\.(?:[cm]?[jt]sx?|jsonc?|ya?ml|toml|md|py|rb|go|rs|java|kt|swift|sh|css|scss|html))`
const repositoryInspectionIntent = new RegExp(
  String.raw`\b(?:${repositoryInspectionVerb})\b[\s\S]{0,100}\b(?:${repositoryResource})\b|\b(?:${repositoryResource})\b[\s\S]{0,100}\b(?:${repositoryInspectionVerb})\b`,
  "i",
)
const webResearchVerb = String.raw`(?:browse|research|search|look\s+up|consult|pesquis(?:e|ar|a)|bus(?:que|car|ca)|procur(?:e|ar|a)|consult(?:e|ar|a)|naveg(?:ue|ar|a))`
const webResource = String.raw`(?:web|internet|online|websites?|sites?)`
const webResearchIntent = new RegExp(
  String.raw`\b(?:${webResearchVerb})\b[\s\S]{0,80}\b(?:${webResource})\b|\b(?:${webResource})\b[\s\S]{0,80}\b(?:${webResearchVerb})\b`,
  "i",
)
const commandExecutionVerb = String.raw`(?:run|execute|invoke|launch|start|build|test|lint|typecheck|rod(?:e|ar|a)|execut(?:e|ar|a)|inici(?:e|ar|a)|compil(?:e|ar|a)|test(?:e|ar|a))`
const commandResource = String.raw`(?:tests?|testes?|test\s+suite|commands?|comandos?|scripts?|build|lint|typecheck|pytest|npm|pnpm|node|uv|cargo|go\s+test|functions?|funç(?:ão|ões)|servers?|servidores?|projects?|projetos?)`
const commandName = String.raw`(?:git|npm|pnpm|node|uv|pytest|cargo|rg|grep|ls|pwd|cat|sed|awk|bash|zsh|sh)`
const commandExecutionIntent = new RegExp(
  String.raw`\b(?:${commandExecutionVerb})\b[\s\S]{0,80}\b(?:${commandResource})\b|\b(?:${commandResource})\b[\s\S]{0,80}\b(?:${commandExecutionVerb})\b|\b(?:${commandExecutionVerb})\b[^;.\n]{0,40}\b(?:${commandName})\b|\b(?:${commandName})\b\s+[-\w.:/@]+|\b(?:ls|pwd)\b(?=\s*(?:$|[;,.!?]))`,
  "i",
)
const negationPrefix = String.raw`(?:(?:do\s+not|don't|never|without|neither)|(?:n[aã]o|nunca|sem|nem))\s+(?:(?:need\s+to|ever|deve|dever[aá]|pode|poder[aá]|precisa|v[aá])\s+)?`
const negatedRepositoryInspectionIntent = new RegExp(
  String.raw`\b${negationPrefix}(?:${repositoryInspectionVerb})\b[^;.\n]{0,100}?\b(?:${repositoryResource})\b`,
  "gi",
)
const negatedWebResearchIntent = new RegExp(
  String.raw`\b${negationPrefix}(?:${webResearchVerb})\b[^;.\n]{0,80}?\b(?:${webResource})\b`,
  "gi",
)
const negatedCommandExecutionIntent = new RegExp(
  String.raw`\b${negationPrefix}(?:(?:${commandExecutionVerb})\b[^;.\n]{0,80}?\b(?:${commandResource}|${commandName})\b|(?:${commandName})\b(?:\s+[-\w.:/@]+)?)`,
  "gi",
)
const explicitTaskTransition = String.raw`(?:[;.\n]|\b(?:and\s+then|but|then|also|e\s+depois|mas|depois|tamb[eé]m)\b)`
const bareTaskConnector = new RegExp(
  String.raw`\b(?:and|or)\s+(?=${mutationVerb}\b)|\b(?:e|ou)\s+(?=${portugueseMutationVerb}\b)`,
  "gi",
)
const clauseBoundary = /([;.\n]|\b(?:but|mas)\b)/gi

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

export const routeCapabilities = Object.freeze({
  minimax: Object.freeze({
    canExecuteCommands: false,
    canHandleNonLiteralText: false,
    canMutateProject: false,
    canReadRepository: true,
    canUseAgentMentions: false,
    canUseAttachments: false,
    canUseExternalTools: false,
  }),
  glm: Object.freeze({
    canExecuteCommands: true,
    canHandleNonLiteralText: true,
    canMutateProject: true,
    canReadRepository: true,
    canUseAgentMentions: true,
    canUseAttachments: true,
    canUseExternalTools: true,
  }),
  claude: Object.freeze({
    canExecuteCommands: true,
    canHandleNonLiteralText: true,
    canMutateProject: true,
    canReadRepository: true,
    canUseAgentMentions: true,
    canUseAttachments: true,
    canUseExternalTools: true,
  }),
  codex: Object.freeze({
    canExecuteCommands: true,
    canHandleNonLiteralText: true,
    canMutateProject: true,
    canReadRepository: true,
    canUseAgentMentions: true,
    canUseAttachments: true,
    canUseExternalTools: true,
  }),
})

function stripNegatedMutations(request) {
  return request
    .split(clauseBoundary)
    .map((clause) => {
      const stripped = clause.replace(negatedMutationIntent, "")
      if (stripped === clause) return clause
      return stripped.replace(coordinatedNegatedMutationIntent, "")
    })
    .join("")
}

function firstConceptualIntent(request) {
  return [conceptualExplanationIntent.exec(request), planningDeliverableIntent.exec(request)]
    .filter(Boolean)
    .sort((left, right) => left.index - right.index)[0]
}

function affirmativeMutation(request) {
  const candidate = stripNegatedMutations(request)
  const explanation = firstConceptualIntent(candidate)
  if (!explanation) return projectMutationIntent.test(candidate)
  if (projectMutationIntent.test(candidate.slice(0, explanation.index))) return true
  const suffix = candidate
    .slice(explanation.index + explanation[0].length)
    .replace(mutationComparisonMention, "")

  for (const transition of suffix.matchAll(new RegExp(explicitTaskTransition, "gi"))) {
    if (projectMutationIntent.test(suffix.slice(transition.index + transition[0].length))) {
      return true
    }
  }
  for (const connector of suffix.matchAll(new RegExp(bareTaskConnector.source, "gi"))) {
    if (mutationIntent.test(suffix.slice(0, connector.index))) continue
    if (projectMutationIntent.test(suffix.slice(connector.index + connector[0].length))) {
      return true
    }
  }
  return false
}

function explicitIntentOutsideExplanation(request, intent) {
  const explanation = firstConceptualIntent(request)
  if (!explanation) return intent.test(request)
  if (intent.test(request.slice(0, explanation.index))) return true

  const suffix = request.slice(explanation.index + explanation[0].length)
  for (const transition of suffix.matchAll(new RegExp(explicitTaskTransition, "gi"))) {
    if (intent.test(suffix.slice(transition.index + transition[0].length))) return true
  }
  return false
}

function stripNegatedCapabilityIntents(request) {
  return request
    .replace(negatedCommandExecutionIntent, "")
    .replace(negatedRepositoryInspectionIntent, "")
    .replace(negatedWebResearchIntent, "")
}

export function requiredRouteCapabilities(
  request,
  { hasAgentMentions = false, hasAttachments = false } = {},
) {
  const affirmativeCapabilities = stripNegatedCapabilityIntents(request)
  return {
    canExecuteCommands: explicitIntentOutsideExplanation(affirmativeCapabilities, commandExecutionIntent),
    canHandleNonLiteralText:
      minimaxForbiddenIntent.test(request)
      || nonLiteralTextIntent.test(request)
      || !literalReadOnlyIntent.test(request),
    canMutateProject: affirmativeMutation(request),
    canReadRepository: explicitIntentOutsideExplanation(affirmativeCapabilities, repositoryInspectionIntent),
    canUseAgentMentions: hasAgentMentions,
    canUseAttachments: hasAttachments,
    canUseExternalTools: explicitIntentOutsideExplanation(affirmativeCapabilities, webResearchIntent),
  }
}

export function routeSupportsRequest(route, request, options) {
  const capabilities = routeCapabilities[route]
  if (!capabilities) throw new Error(`unknown route: ${route}`)
  const required = requiredRouteCapabilities(request, options)
  return Object.entries(required).every(
    ([capability, needed]) => !needed || capabilities[capability] === true,
  )
}

export function enforceMinimumRoute(route, request, options) {
  if (routeSupportsRequest(route, request, options)) return route
  if (route === "minimax") return "glm"
  if (route === "claude") return "codex"
  return route
}

export function routeTarget(route) {
  const target = routeTargets[route]
  if (!target) throw new Error(`unknown route: ${route}`)
  return target
}
