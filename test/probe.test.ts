import test from 'node:test'
import assert from 'node:assert/strict'

import { decodeZenCapabilities } from '../src/catalog.ts'
// @ts-expect-error scripts are plain ESM with no .d.ts
import { selectCandidates } from '../scripts/probe-models.mjs'

const capabilityBody = {
  opencode: {
    id: 'opencode',
    api: 'https://opencode.ai/zen/v1',
    npm: '@ai-sdk/openai-compatible',
    models: {
      'qwen-free': { id: 'qwen-free', provider: { npm: '@ai-sdk/openai-compatible' } },
      'muse-free': { id: 'muse-free', provider: { npm: '@ai-sdk/openai' } },
    },
  },
}

const zenIds = ['qwen-free', 'muse-free', 'mystery-free']
const prices = new Set(['qwen-free', 'muse-free'])
const ledger = { verified: [{ id: 'old-verified' }], unavailable: [], pending: [] }

test('selectCandidates skips non-chat-native ids while the capability catalog is known', () => {
  const caps = decodeZenCapabilities(capabilityBody)
  assert.deepEqual(selectCandidates(zenIds, prices, ledger, caps), ['mystery-free', 'old-verified', 'qwen-free'])
})

test('selectCandidates degrades to probing every candidate when capabilities are unavailable', () => {
  assert.deepEqual(selectCandidates(zenIds, prices, ledger, null), ['muse-free', 'mystery-free', 'old-verified', 'qwen-free'])
})
