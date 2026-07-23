import { readFileSync, writeFileSync } from 'node:fs'
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

export function mergeOpenCodeConfig(currentSource, requiredSource) {
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
  const options = { current: '', output: '', required: '' }
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    if (!['--current', '--output', '--required'].includes(option)) {
      throw new Error(
        'Usage: node scripts/merge-opencode-config.mjs --current FILE --required FILE --output FILE'
      )
    }
    const value = argv[index + 1]
    if (!value) throw new Error(`${option} requires a file path`)
    options[option.slice(2)] = value
    index += 1
  }
  for (const [key, value] of Object.entries(options)) {
    if (!value) throw new Error(`--${key} is required`)
  }
  return options
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  const current = readFileSync(options.current, 'utf8')
  const required = readFileSync(options.required, 'utf8')
  writeFileSync(options.output, mergeOpenCodeConfig(current, required), 'utf8')
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
