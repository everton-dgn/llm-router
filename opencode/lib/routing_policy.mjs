import {
  LEGACY_ROUTE_MANIFEST,
  normalizeAttachmentMediaType,
  routeAcceptsMediaType,
  routeManifestEntry,
} from "./route_manifest.mjs"

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
const minimaxForbiddenIntent = /\b(?:correct|correction|proofread|corr(?:ija|igir|eção)|translate|translation|tradu(?:za|zir|ção)|summar(?:ize|ise|y)|resum(?:a|ir|o)|rewrite|rewriting|reescrev(?:a|er)|document(?:e|ar|ation|ação)|brainstorm|copywriting|naming|(?:product|brand|company|feature)\s+names?|nomes?\s+(?:para|de)\s+(?:(?:o|a)\s+)?(?:produto|marca|empresa|recurso|funcionalidade))\b/i
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
  {
    allowLiteralOnlyRoute = false,
    hasAgentMentions = false,
    hasAttachments = false,
  } = {},
) {
  const affirmativeCapabilities = stripNegatedCapabilityIntents(request)
  return {
    canExecuteCommands: explicitIntentOutsideExplanation(affirmativeCapabilities, commandExecutionIntent),
    // A selected route that declares itself literal-only supplies the semantic
    // classifier signal. The regex floor still vetoes non-literal work.
    canHandleNonLiteralText: allowLiteralOnlyRoute
      ? minimaxForbiddenIntent.test(request) || nonLiteralTextIntent.test(request)
      : minimaxForbiddenIntent.test(request)
        || nonLiteralTextIntent.test(request)
        || !literalReadOnlyIntent.test(request),
    canMutateProject: affirmativeMutation(request),
    canReadRepository: explicitIntentOutsideExplanation(affirmativeCapabilities, repositoryInspectionIntent),
    canUseAgentMentions: hasAgentMentions,
    canUseAttachments: hasAttachments,
    canUseExternalTools: explicitIntentOutsideExplanation(affirmativeCapabilities, webResearchIntent),
  }
}

export const UNKNOWN_ATTACHMENT_MEDIA_TYPE = "application/octet-stream"
export const UNSUPPORTED_MEDIA_TYPE_ERROR_CODE = "unsupported_media_type"
export const NO_COMPATIBLE_ROUTE_ERROR_CODE = "no_compatible_route"

// An attachment with no usable media type keeps a stable identity, so only a
// route that declares that type explicitly can receive it.
export function attachmentMediaTypes(values) {
  if (!Array.isArray(values)) return []
  const mediaTypes = []
  for (const value of values) {
    const mediaType = normalizeAttachmentMediaType(value) || UNKNOWN_ATTACHMENT_MEDIA_TYPE
    if (!mediaTypes.includes(mediaType)) mediaTypes.push(mediaType)
  }
  return mediaTypes
}

function requestMediaTypes(options) {
  return attachmentMediaTypes(options?.attachmentMediaTypes)
}

export function unsupportedRouteMediaTypes(
  route,
  mediaTypes,
  manifest = LEGACY_ROUTE_MANIFEST,
) {
  const entry = routeManifestEntry(manifest, route)
  if (!entry) throw new Error(`unknown route: ${route}`)
  return attachmentMediaTypes(mediaTypes).filter(
    (mediaType) => !routeAcceptsMediaType(entry, mediaType),
  )
}

function routeAcceptsEveryMediaType(route, mediaTypes) {
  return mediaTypes.every((mediaType) => routeAcceptsMediaType(route, mediaType))
}

// A capability gap is not a media rejection: some route does accept every
// attachment, so reusing the media code would name the wrong cause. It still
// stops the message before any worker, so it carries a code of its own and the
// plugin can explain the stop instead of failing silently.
function noCompatibleRouteError(message, mediaTypes = []) {
  const error = new Error(message)
  error.code = NO_COMPATIBLE_ROUTE_ERROR_CODE
  if (mediaTypes.length > 0) error.mediaTypes = mediaTypes
  return error
}

function unsupportedMediaTypeError(manifest, mediaTypes) {
  const rejected = mediaTypes.filter((mediaType) => (
    !manifest.routes.some((route) => routeAcceptsMediaType(route, mediaType))
  ))
  const error = new Error(
    rejected.length > 0
      ? `no route accepts the attached media types: ${rejected.join(", ")}`
      : `no single route accepts every attached media type: ${mediaTypes.join(", ")}`,
  )
  error.code = UNSUPPORTED_MEDIA_TYPE_ERROR_CODE
  error.mediaTypes = rejected.length > 0 ? rejected : mediaTypes
  return error
}

// Keeps the selected route when it accepts every attachment, otherwise borrows
// the closest route above it and only then looks below.
export function enforceMediaCompatibleRoute(
  route,
  mediaTypes,
  manifest = LEGACY_ROUTE_MANIFEST,
) {
  const selected = routeManifestEntry(manifest, route)
  if (!selected) throw new Error(`unknown route: ${route}`)
  const requested = attachmentMediaTypes(mediaTypes)
  if (requested.length === 0) return route
  if (routeAcceptsEveryMediaType(selected, requested)) return route

  const promoted = manifest.routes.find((candidate) => (
    candidate.order > selected.order
    && routeAcceptsEveryMediaType(candidate, requested)
  ))
  if (promoted) return promoted.id
  const alternative = manifest.routes.find(
    (candidate) => routeAcceptsEveryMediaType(candidate, requested),
  )
  if (!alternative) throw unsupportedMediaTypeError(manifest, requested)
  return alternative.id
}

export function routeCapabilities(manifest = LEGACY_ROUTE_MANIFEST) {
  return Object.freeze(Object.fromEntries(
    manifest.routes.map(({ id, capabilities }) => [id, capabilities]),
  ))
}

export function routeTargets(manifest = LEGACY_ROUTE_MANIFEST) {
  return Object.freeze(Object.fromEntries(
    manifest.routes.map(({ id, target }) => [id, target]),
  ))
}

export function routeSupportsRequest(
  route,
  request,
  options,
  manifest = LEGACY_ROUTE_MANIFEST,
) {
  const entry = routeManifestEntry(manifest, route)
  if (!entry) throw new Error(`unknown route: ${route}`)
  if (!routeAcceptsEveryMediaType(entry, requestMediaTypes(options))) return false
  const required = requiredRouteCapabilities(request, options)
  return Object.entries(required).every(
    ([capability, needed]) => !needed || entry.capabilities[capability] === true,
  )
}

export function routeSupportsSelectedRequest(
  candidateRoute,
  selectedRoute,
  request,
  options,
  manifest = LEGACY_ROUTE_MANIFEST,
) {
  const selected = routeManifestEntry(manifest, selectedRoute)
  if (!selected) throw new Error(`unknown route: ${selectedRoute}`)
  return routeSupportsRequest(candidateRoute, request, {
    ...options,
    allowLiteralOnlyRoute: selected.capabilities.canHandleNonLiteralText === false,
  }, manifest)
}

export function minimumCompatibleRoute(
  request,
  options,
  manifest = LEGACY_ROUTE_MANIFEST,
) {
  const route = manifest.routes.find((candidate) => (
    routeSupportsRequest(candidate.id, request, options, manifest)
  ))
  if (route) return route.id
  const mediaTypes = requestMediaTypes(options)
  if (mediaTypes.length > 0) throw unsupportedMediaTypeError(manifest, mediaTypes)
  throw noCompatibleRouteError("no compatible route available for request")
}

export function enforceMinimumRoute(
  route,
  request,
  options,
  manifest = LEGACY_ROUTE_MANIFEST,
) {
  const selected = routeManifestEntry(manifest, route)
  if (!selected) throw new Error(`unknown route: ${route}`)
  if (routeSupportsSelectedRequest(route, route, request, options, manifest)) return route
  const promoted = manifest.routes.find((candidate) => (
    candidate.order > selected.order
    && routeSupportsSelectedRequest(candidate.id, route, request, options, manifest)
  ))
  if (promoted) return promoted.id

  // An attachment the selected route cannot read may only be served by a
  // cheaper route, so media incompatibility also searches below it.
  const mediaTypes = requestMediaTypes(options)
  if (mediaTypes.length > 0 && !routeAcceptsEveryMediaType(selected, mediaTypes)) {
    const alternative = manifest.routes.find((candidate) => (
      routeSupportsSelectedRequest(candidate.id, route, request, options, manifest)
    ))
    if (alternative) return alternative.id
    // The media error belongs to requests the attachments alone made
    // unroutable; a capability gap keeps its own message.
    if (!manifest.routes.some((candidate) => routeAcceptsEveryMediaType(candidate, mediaTypes))) {
      throw unsupportedMediaTypeError(manifest, mediaTypes)
    }
    throw noCompatibleRouteError(
      `no route accepts ${mediaTypes.join(", ")} and also supports the request`,
      mediaTypes,
    )
  }
  throw noCompatibleRouteError(`no compatible route available above: ${route}`)
}

export function routeTarget(route, manifest = LEGACY_ROUTE_MANIFEST) {
  const target = routeManifestEntry(manifest, route)?.target
  if (!target) throw new Error(`unknown route: ${route}`)
  return target
}
