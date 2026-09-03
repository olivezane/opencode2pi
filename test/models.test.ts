import test from 'node:test'
import assert from 'node:assert/strict'

import { PROVIDER_ID, ZEN_V1, decodeModelsDevMeta, toPiModels } from '../src/models.ts'

// Real models.dev api.json shape (opencode section), trimmed.
const payload = {
  openai: { models: { gpt: { limit: { context: 1 }, cost: { input: 5, output: 10 } } } },
  opencode: {
    models: {
      'qwen3-coder-next': {
        name: 'Qwen3 Coder Next',
        reasoning: true,
        attachment: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 262144, output: 65536 },
        cost: { input: 0, output: 0, cache_read: 0 },
      },
      'big-pickle': { limit: { context: 0, output: 0 }, cost: {} },
    },
  },
}

test('decodeModelsDevMeta prefers the opencode section and maps the metadata fields', () => {
  const meta = decodeModelsDevMeta(payload)
  assert.equal(meta.size, 2)
  const qwen = meta.get('qwen3-coder-next')
  assert.deepEqual(qwen, {
    name: 'Qwen3 Coder Next',
    reasoning: true,
    image: true,
    contextWindow: 262144,
    maxTokens: 65536,
    costInput: 0,
    costOutput: 0,
    costCacheRead: 0,
  })
  // non-positive limits fall back to undefined, not 0
  assert.equal(meta.get('big-pickle')?.contextWindow, undefined)
  assert.equal(decodeModelsDevMeta({ openai: {} }).size, 0)
  assert.equal(decodeModelsDevMeta(null).size, 0)
})

test('responses-native models mark off-thinking unsupported so pi-ai skips effort none', () => {
  const models = toPiModels(['r-free'], new Map(), new Map([['r-free', 'responses']]) as never)
  assert.deepEqual(models[0]?.thinkingLevelMap, { off: null })
})

test('toPiModels dispatches the pi api layer by native protocol', () => {
  const protocols = new Map<string, string>([
    ['r-free', 'responses'],
    ['a-free', 'anthropic'],
  ])
  const models = toPiModels(['r-free', 'a-free', 'c-free'], new Map(), protocols as never)
  assert.equal(models.find((m) => m.id === 'r-free')?.api, 'openai-responses')
  assert.equal(models.find((m) => m.id === 'a-free')?.api, 'anthropic-messages')
  assert.equal(models.find((m) => m.id === 'c-free')?.api, 'openai-completions', 'unknown protocol defaults to chat')
  // the Anthropic SDK appends /v1/messages itself, so its baseUrl is the host root
  assert.equal(models.find((m) => m.id === 'a-free')?.baseUrl, 'https://opencode.ai/zen')
  assert.equal(models.find((m) => m.id === 'c-free')?.baseUrl, 'https://opencode.ai/zen/v1')
})

test('toPiModels builds complete pi models, defaulting what metadata lacks', () => {
  const meta = decodeModelsDevMeta(payload)
  const models = toPiModels(['qwen3-coder-next', 'hy3-free'], meta)
  assert.equal(models.length, 2)

  const qwen = models[0]!
  assert.equal(qwen.id, 'qwen3-coder-next')
  assert.equal(qwen.name, 'Qwen3 Coder Next')
  assert.equal(qwen.api, 'openai-completions')
  assert.equal(qwen.provider, PROVIDER_ID)
  assert.equal(qwen.baseUrl, ZEN_V1)
  assert.equal(qwen.baseUrl, 'https://opencode.ai/zen/v1')
  assert.equal(qwen.reasoning, true)
  assert.deepEqual(qwen.input, ['text', 'image'])
  assert.deepEqual(qwen.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  assert.equal(qwen.contextWindow, 262144)
  assert.equal(qwen.maxTokens, 65536)

  // no metadata at all: id as name, text-only, zero cost, conservative defaults
  const bare = models[1]!
  assert.equal(bare.name, 'hy3-free')
  assert.deepEqual(bare.input, ['text'])
  assert.deepEqual(bare.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  assert.equal(bare.contextWindow, 262144)
  assert.equal(bare.maxTokens, 32768)
})
