import assert from 'node:assert/strict'
import test from 'node:test'

import { parse } from 'jsonc-parser'

import { mergeOpenCodeConfig } from './merge-opencode-config.mjs'

const required = JSON.stringify({
  $schema: 'https://opencode.ai/config.json',
  autoupdate: false,
  model: 'ollama/router',
  default_agent: 'router',
  disabled_providers: ['unused-provider'],
  provider: {
    ollama: { name: 'Managed Ollama' },
    'claude-agent': { name: 'Managed Claude' }
  },
  command: {
    'router-auto': { description: 'Managed command' }
  },
  agent: {
    router: { model: 'ollama/router' },
    claude: { model: 'claude-agent/opus' }
  }
})

test('preserves comments and unrelated OpenCode configuration', () => {
  const current = `{
  // Keep this user comment.
  "$schema": "https://example.invalid/custom-schema.json",
  "autoupdate": true,
  "disabled_providers": ["user-disabled"],
  "theme": "user-theme",
  "provider": {
    "custom": { "name": "Custom provider" },
    "ollama": { "name": "Old router provider" },
  },
  "command": {
    "custom-command": { "description": "Keep me" }
  },
  "agent": {
    "custom-agent": { "model": "custom/model" }
  }
}`

  const merged = mergeOpenCodeConfig(current, required)
  const parsed = parse(merged)

  assert.match(merged, /Keep this user comment/)
  assert.equal(parsed.$schema, 'https://example.invalid/custom-schema.json')
  assert.equal(parsed.autoupdate, true)
  assert.deepEqual(parsed.disabled_providers, ['user-disabled'])
  assert.equal(parsed.theme, 'user-theme')
  assert.deepEqual(parsed.provider.custom, { name: 'Custom provider' })
  assert.deepEqual(parsed.provider.ollama, { name: 'Managed Ollama' })
  assert.deepEqual(parsed.provider['claude-agent'], { name: 'Managed Claude' })
  assert.deepEqual(parsed.command['custom-command'], {
    description: 'Keep me'
  })
  assert.deepEqual(parsed.command['router-auto'], {
    description: 'Managed command'
  })
  assert.deepEqual(parsed.agent['custom-agent'], {
    model: 'custom/model'
  })
  assert.equal(parsed.model, 'ollama/router')
  assert.equal(parsed.default_agent, 'router')
})

test('adds missing managed collections to a minimal configuration', () => {
  const merged = parse(mergeOpenCodeConfig('{"theme":"system"}', required))

  assert.equal(merged.$schema, 'https://opencode.ai/config.json')
  assert.equal(merged.theme, 'system')
  assert.equal(merged.provider.ollama.name, 'Managed Ollama')
  assert.equal(merged.command['router-auto'].description, 'Managed command')
  assert.equal(merged.agent.router.model, 'ollama/router')
  assert.equal(merged.autoupdate, undefined)
  assert.equal(merged.disabled_providers, undefined)
})

test('removes only unchanged stale managed entries from a previous install', () => {
  const installedWorker = { model: 'custom/old', mode: 'subagent' }
  const current = JSON.stringify({
    provider: {},
    command: {},
    agent: {
      'stale-unchanged': installedWorker,
      'stale-modified': {
        ...installedWorker,
        description: 'User customization'
      },
      'user-agent': { model: 'user/model' }
    }
  })
  const stateSource = JSON.stringify({
    managedConfig: [
      {
        path: ['agent', 'stale-unchanged'],
        installedValue: installedWorker
      },
      {
        path: ['agent', 'stale-modified'],
        installedValue: installedWorker
      }
    ]
  })
  const preserved = []

  const merged = parse(mergeOpenCodeConfig(current, required, {
    stateSource,
    onPreserveStale: (propertyPath) => preserved.push(propertyPath)
  }))

  assert.equal(merged.agent['stale-unchanged'], undefined)
  assert.equal(
    merged.agent['stale-modified'].description,
    'User customization'
  )
  assert.deepEqual(merged.agent['user-agent'], { model: 'user/model' })
  assert.deepEqual(preserved, [['agent', 'stale-modified']])
})

test('rejects invalid or structurally incompatible existing JSONC', () => {
  assert.throws(
    () => mergeOpenCodeConfig('{"provider":,}', required),
    /invalid JSONC/
  )
  assert.throws(
    () => mergeOpenCodeConfig('[]', required),
    /must contain a JSON object/
  )
  assert.throws(
    () => mergeOpenCodeConfig('{"provider":[]}', required),
    /configuration\.provider must contain a JSON object/
  )
})
