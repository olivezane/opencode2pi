import type { Api, Model } from '@earendil-works/pi-ai'

import { ZEN_BASE_URL } from './catalog.ts'

/** Identity, used as the provider id in pi's model picker and the data dir name. */
export const PROVIDER_ID = 'opencode2pi'
export const PROVIDER_NAME = 'OpenCode Zen (free)'

/** Anonymous credential: the literal string the upstream accepts for the free lane. */
export const ANONYMOUS_KEY = 'public'

const DEFAULT_CONTEXT_WINDOW = 262144
const DEFAULT_MAX_TOKENS = 32768

export function zenBaseUrl(): string {
  return `${ZEN_BASE_URL.replace(/\/+$/, '')}/v1`
}

/**
 * Full per-model metadata as found in the OpenCode section of models.dev
 * (api.json). Only the fields the picker cares about are kept.
 */
export interface ModelMeta {
  name?: string
  reasoning: boolean
  image: boolean
  contextWindow?: number
  maxTokens?: number
  costInput?: number
  costOutput?: number
  costCacheRead?: number
}

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined

/**
 * Parse the OpenCode provider section of the models.dev payload into full
 * model metadata. Mirrors decodeModelsDev's provider selection (prefer the
 * exact `opencode`/`opencode-zen` key) so both maps describe the same models.
 */
export function decodeModelsDevMeta(data: unknown): Map<string, ModelMeta> {
  const result = new Map<string, ModelMeta>()
  if (!data || typeof data !== 'object') return result
  const providers = data as Record<string, { models?: Record<string, Record<string, unknown>>; id?: unknown; name?: unknown }>
  const keys = Object.keys(providers)
  const rank = (key: string): number => {
    const lower = key.toLowerCase()
    if (lower === 'opencode' || lower === 'opencode-zen' || lower === 'opencode_zen') return 0
    if (lower.includes('opencode')) return 1
    return 2
  }
  keys.sort((left, right) => {
    const leftRank = rank(left)
    const rightRank = rank(right)
    if (leftRank !== rightRank) return leftRank - rightRank
    return left.localeCompare(right)
  })
  for (const key of keys) {
    if (rank(key) > 1) continue
    const provider = providers[key]
    if (!provider || typeof provider !== 'object') continue
    if (rank(key) === 1) {
      const identity = `${provider.id ?? ''} ${provider.name ?? ''}`.toLowerCase().trim()
      if (!identity.includes('opencode')) continue
    }
    const models = provider.models
    if (!models || typeof models !== 'object') continue
    for (const [modelKey, raw] of Object.entries(models)) {
      if (!raw || typeof raw !== 'object') continue
      const modelId = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : modelKey
      const cost = (raw.cost ?? {}) as Record<string, unknown>
      const limit = (raw.limit ?? {}) as Record<string, unknown>
      const modalities = (raw.modalities ?? {}) as { input?: unknown }
      const inputs = Array.isArray(modalities.input) ? modalities.input : []
      result.set(modelId, {
        name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : undefined,
        reasoning: raw.reasoning === true,
        image: raw.attachment === true || inputs.includes('image'),
        contextWindow: num(limit.context),
        maxTokens: num(limit.output),
        costInput: numNonNegative(cost.input),
        costOutput: numNonNegative(cost.output),
        costCacheRead: numNonNegative(cost.cache_read),
      })
    }
    if (result.size > 0) return result
  }
  return result
}

const numNonNegative = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined

/** Build the pi model list for the picker: ids already decided free by the catalog. */
export function toPiModels(ids: string[], meta: Map<string, ModelMeta>): Array<Model<Api>> {
  return ids.map((id) => {
    const m = meta.get(id)
    return {
      id,
      name: m?.name ?? id,
      api: 'openai-completions' as const,
      provider: PROVIDER_ID,
      baseUrl: zenBaseUrl(),
      reasoning: m?.reasoning ?? false,
      input: m?.image ? ['text', 'image'] : ['text'],
      cost: {
        input: m?.costInput ?? 0,
        output: m?.costOutput ?? 0,
        cacheRead: m?.costCacheRead ?? 0,
        cacheWrite: 0,
      },
      contextWindow: m?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: m?.maxTokens ?? DEFAULT_MAX_TOKENS,
    }
  })
}
