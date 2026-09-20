import test from 'node:test'
import assert from 'node:assert/strict'

import { decodeZenCapabilities } from '../src/catalog.ts'
// @ts-expect-error scripts are plain ESM with no .d.ts
import { probeRequest, selectCandidates } from '../scripts/probe-models.mjs'

const capabilityBody = {
  opencode: {
    id: 'opencode',
    api: 'https://opencode.ai/zen/v1',
    npm: '@ai-sdk/openai-compatible',
    models: {
      'qwen-free': { id: 'qwen-free', provider: { npm: '@ai-sdk/openai-compatible' } },
      'muse-free': { id: 'muse-free', provider: { npm: '@ai-sdk/openai' } },
      'claude-free': { id: 'claude-free', provider: { npm: '@ai-sdk/anthropic' } },
      'weird-free': { id: 'weird-free', provider: { npm: '@ai-sdk/google' } },
    },
  },
}

const zenIds = ['qwen-free', 'muse-free', 'claude-free', 'weird-free', 'mystery-free']
const prices = new Set(zenIds)
const ledger = { verified: [], unavailable: [], pending: [] }

test('selectCandidates keeps every known-protocol id for native probing and skips unsupported SDKs', () => {
  const caps = decodeZenCapabilities(capabilityBody)
  assert.deepEqual(selectCandidates(zenIds, prices, ledger, caps), [
    'claude-free',
    'muse-free',
    'mystery-free',
    'qwen-free',
  ])
})

test('selectCandidates degrades to probing every candidate when capabilities are unavailable', () => {
  assert.deepEqual(selectCandidates(zenIds, prices, ledger, null), [
    'claude-free',
    'muse-free',
    'mystery-free',
    'qwen-free',
    'weird-free',
  ])
})

test('probeRequest builds the native endpoint per protocol', () => {
  const chat = probeRequest('x-free', 'chat')
  assert.equal(chat.url, 'https://opencode.ai/zen/v1/chat/completions')
  assert.equal(chat.headers.authorization, 'Bearer public')
  assert.deepEqual(chat.body.model, 'x-free')

  const responses = probeRequest('x-free', 'responses')
  assert.equal(responses.url, 'https://opencode.ai/zen/v1/responses')
  assert.equal(responses.body.input, 'hi')
  assert.equal(responses.body.stream, true)

  const messages = probeRequest('x-free', 'anthropic')
  assert.equal(messages.url, 'https://opencode.ai/zen/v1/messages')
  assert.equal(messages.headers['x-api-key'], 'public')
  assert.equal(messages.headers.authorization, undefined, 'anthropic auth is x-api-key, not Bearer')
  assert.deepEqual(messages.body.messages, [{ role: 'user', content: 'hi' }])
})

// The free tier answers 403 FreeTierError unless the request carries streaming
// plus the core agent tools, so every probe body must stay agent-shaped.
test('probeRequest sends agent-shaped bodies the free tier accepts', () => {
  assert.equal(probeRequest('x-free', 'chat').body.stream, true)
  assert.equal(probeRequest('x-free', 'anthropic').body.stream, true)

  const chat = probeRequest('x-free', 'chat').body.tools
  assert.deepEqual(
    chat.map((tool: { function: { name: string } }) => tool.function.name),
    ['bash', 'read'],
  )
  assert.deepEqual(chat[0].type, 'function')

  const responses = probeRequest('x-free', 'responses').body.tools
  assert.deepEqual(
    responses.map((tool: { name: string }) => tool.name),
    ['bash', 'read'],
  )
  assert.deepEqual(responses[0].type, 'function')

  const messages = probeRequest('x-free', 'anthropic').body.tools
  assert.deepEqual(
    messages.map((tool: { name: string }) => tool.name),
    ['bash', 'read'],
  )
  assert.deepEqual(messages[0].input_schema, { type: 'object', properties: {} })
})
