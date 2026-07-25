import { readFileSync, writeFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  applyEdits,
  modify,
  parse,
  printParseErrorCode
} from 'jsonc-parser'

const managedCollections = ['provider', 'command', 'agent']

function parseObject(source, label) {
  const errors = []
  const value = parse(source, errors, {
    allowTrailingComma: true,
    disallowComments: false
  })
  if (errors.length > 0) {
    const first = errors[0]
    throw new Error(
      `${label} is invalid JSONC at offset ${first.offset}: ${printParseErrorCode(first.error)}`
    )
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must contain a JSON object`)
  }
  return value
}

function assertManagedCollection(config, key, label) {
  const value = config[key]
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}.${key} must contain a JSON object`)
  }
  return value
}

function staleManagedConfigRecords(stateSource, required) {
  if (stateSource === undefined) return []
  const state = parseObject(stateSource, 'Existing llm-router installation state')
  if (!Array.isArray(state.managedConfig)) {
    throw new Error('Existing llm-router installation state.managedConfig must be an array')
  }
  return state.managedConfig.filter((record, index) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error(`Existing llm-router installation state.managedConfig[${index}] must be an object`)
    }
    const propertyPath = record.path
    if (
      !Array.isArray(propertyPath)
      || propertyPath.length !== 2
      || !managedCollections.includes(propertyPath[0])
      || typeof propertyPath[1] !== 'string'
      || !propertyPath[1]
    ) return false
    return !Object.prototype.hasOwnProperty.call(
      assertManagedCollection(
        required,
        propertyPath[0],
        'Required llm-router configuration'
      ),
      propertyPath[1]
    )
  })
}

export function mergeOpenCodeConfig(
  currentSource,
  requiredSource,
  { stateSource, onPreserveStale = () => {} } = {}
) {
  const current = parseObject(currentSource, 'Existing OpenCode configuration')
  const required = parseObject(requiredSource, 'Required llm-router configuration')
  const formattingOptions = {
    eol: '\n',
    insertSpaces: true,
    tabSize: 2
  }
  let merged = String(currentSource)

  const setValue = (propertyPath, value) => {
    merged = applyEdits(
      merged,
      modify(merged, propertyPath, value, { formattingOptions })
    )
  }

  for (const record of staleManagedConfigRecords(stateSource, required)) {
    const [collection, key] = record.path
    if (!Object.prototype.hasOwnProperty.call(current[collection] ?? {}, key)) continue
    if (
      Object.prototype.hasOwnProperty.call(record, 'installedValue')
      && isDeepStrictEqual(current[collection][key], record.installedValue)
    ) {
      setValue(record.path, undefined)
    } else {
      onPreserveStale(record.path)
    }
  }

  if (!Object.prototype.hasOwnProperty.call(current, '$schema')) {
    setValue(['$schema'], required.$schema)
  }
  setValue(['model'], required.model)
  setValue(['default_agent'], required.default_agent)

  for (const collection of managedCollections) {
    const existingEntries = current[collection]
    if (
      existingEntries !== undefined
      && (
        !existingEntries
        || typeof existingEntries !== 'object'
        || Array.isArray(existingEntries)
      )
    ) {
      throw new Error(
        `Existing OpenCode configuration.${collection} must contain a JSON object`
      )
    }
    const requiredEntries = assertManagedCollection(
      required,
      collection,
      'Required llm-router configuration'
    )
    for (const [key, value] of Object.entries(requiredEntries)) {
      setValue([collection, key], value)
    }
  }

  parseObject(merged, 'Merged OpenCode configuration')
  return merged.endsWith('\n') ? merged : `${merged}\n`
}

function parseArgs(argv) {
  const options = { current: '', output: '', required: '', state: '' }
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    if (!['--current', '--output', '--required', '--state'].includes(option)) {
      throw new Error(
        'Usage: node scripts/merge-opencode-config.mjs --current FILE --required FILE --output FILE [--state FILE]'
      )
    }
    const value = argv[index + 1]
    if (!value) throw new Error(`${option} requires a file path`)
    options[option.slice(2)] = value
    index += 1
  }
  for (const key of ['current', 'output', 'required']) {
    const value = options[key]
    if (!value) throw new Error(`--${key} is required`)
  }
  return options
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  const current = readFileSync(options.current, 'utf8')
  const required = readFileSync(options.required, 'utf8')
  const stateSource = options.state ? readFileSync(options.state, 'utf8') : undefined
  const merged = mergeOpenCodeConfig(current, required, {
    stateSource,
    onPreserveStale: (propertyPath) => {
      console.error(`preserved user-modified stale config: ${propertyPath.join('.')}`)
    }
  })
  writeFileSync(options.output, merged, 'utf8')
}

const isMainModule = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false

if (isMainModule) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
