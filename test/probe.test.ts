import test from 'node:test'
import assert from 'node:assert/strict'

import { decodeZenCapabilities } from '../src/catalog.ts'
import { disguiseHeaders } from '../src/ids.ts'
// @ts-expect-error scripts are plain ESM with no .d.ts
import { countsAsVerified, probeRequest, selectCandidates } from '../scripts/probe-models.mjs'

const capabilityBody = {
  opencode: {
    id: 'opencode',
    api: 'https://opencode.ai/inference/v1',
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

test('selectCandidates keeps every known-protocol id for native probing and skips unsupported SDKs', () => {
  const caps = decodeZenCapabilities(capabilityBody)
  assert.deepEqual(selectCandidates(zenIds, prices, caps), [
    'claude-free',
    'muse-free',
    'mystery-free',
    'qwen-free',
  ])
})

test('selectCandidates degrades to probing every candidate when capabilities are unavailable', () => {
  assert.deepEqual(selectCandidates(zenIds, prices, null), [
    'claude-free',
    'muse-free',
    'mystery-free',
    'qwen-free',
    'weird-free',
  ])
})

test('selectCandidates probes only what /v1/models lists, never a ledger-only id', () => {
  // 2026-10-24: the ledger used to feed the probe set too, so 18 ids Zen had
  // stopped serving were re-probed twice a day forever.
  const stale = ['gone-free', 'cat-jam-free']
  for (const id of stale) assert.equal(zenIds.includes(id), false, `${id} is no longer served`)
  assert.deepEqual(selectCandidates(zenIds, prices, null), [...zenIds].sort())
})

test('countsAsVerified treats a spent egress IP as proof the model is served and free', () => {
  // 2026-10-24: a blocked IP lasts long enough that calling 429 indeterminate
  // would freeze a ban forever, so 429 must clear pending/unavailable like 200.
  assert.equal(countsAsVerified(200), true)
  assert.equal(countsAsVerified(429), true)
  assert.equal(countsAsVerified(400), false, '400 is a real rejection')
  assert.equal(countsAsVerified(401), false, '401 means not in the free set')
  assert.equal(countsAsVerified(410), false, '410 means retired')
})

test('probeRequest builds the native endpoint per protocol', () => {
  const chat = probeRequest('x-free', 'chat')
  assert.equal(chat.url, 'https://opencode.ai/inference/v1/chat/completions')
  assert.equal(chat.headers.authorization, 'Bearer public')
  assert.deepEqual(chat.body.model, 'x-free')

  const responses = probeRequest('x-free', 'responses')
  assert.equal(responses.url, 'https://opencode.ai/inference/v1/responses')
  assert.equal(responses.body.input, 'hi')
  assert.equal(responses.body.stream, true)

  const messages = probeRequest('x-free', 'anthropic')
  assert.equal(messages.url, 'https://opencode.ai/inference/v1/messages')
  assert.equal(messages.headers['x-api-key'], 'public')
  assert.equal(messages.headers.authorization, undefined, 'anthropic auth is x-api-key, not Bearer')
  assert.deepEqual(messages.body.messages, [{ role: 'user', content: 'hi' }])

  const classifier = probeRequest('x-free', 'classifier')
  assert.equal(classifier.url, 'https://opencode.ai/inference/v1/systemone')
  assert.equal(classifier.body.state !== undefined, true, 'System One takes a state, not messages')
  assert.equal(classifier.body.questions.probe.type, 'noul', 'bool questions are noul on the wire')
})

// The free tier answers 403 FreeTierError unless the request carries streaming
// plus a genuinely-defined `read` tool, and any `x-opencode-request` header.
test('probeRequest sends agent-shaped bodies the free tier accepts', () => {
  assert.equal(probeRequest('x-free', 'chat').body.stream, true)
  assert.equal(probeRequest('x-free', 'anthropic').body.stream, true)

  const chat = probeRequest('x-free', 'chat')
  assert.deepEqual(chat.body.tools.map((t: { function: { name: string } }) => t.function.name), ['read'])
  assert.equal(chat.body.tools[0].type, 'function')
  assert.equal(chat.headers['x-opencode-request'], undefined, 'that header is itself a 403')
  assert.ok(Object.keys(chat.body.tools[0].function.parameters.properties).length > 0)

  const responses = probeRequest('x-free', 'responses').body.tools
  assert.deepEqual(responses.map((t: { name: string }) => t.name), ['read'])
  assert.equal(responses[0].type, 'function')

  const messages = probeRequest('x-free', 'anthropic').body.tools
  assert.deepEqual(messages.map((t: { name: string }) => t.name), ['read'])
  assert.deepEqual(messages[0].input_schema.required, ['path'])
})

// A probe that sends a different header set than the runtime cannot verify the
// lane: on 2026-10-15 it lacked the twin `x-opencode-session-id` and reported
// 403 for every model while real requests kept working.
test('the probe sends exactly the runtime header set', () => {
  const chat = probeRequest('x-free', 'chat')
  const runtime = disguiseHeaders({
    session: chat.headers['x-opencode-session'] as string,
    project: chat.headers['x-opencode-project'] as string,
  })
  for (const [name, value] of Object.entries(runtime)) {
    assert.equal(chat.headers[name], value, `probe must send ${name}=${value}`)
  }
})

