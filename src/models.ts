import type { Api, Model } from '@earendil-works/pi-ai'

import type { ZenProtocol } from './catalog.ts'
import { ZEN_BASE_URL, forModelsDev } from './catalog.ts'

/** Identity, used as the provider id in pi's model picker and the data dir name. */
export const PROVIDER_ID = 'opencode2pi'
export const PROVIDER_NAME = 'OpenCode Zen (free)'

/** Anonymous credential: the literal string the upstream accepts for the free lane. */
export const ANONYMOUS_KEY = 'public'

const DEFAULT_CONTEXT_WINDOW = 262144
const DEFAULT_MAX_TOKENS = 32768

/** Token counts: limits need a positive value, costs accept 0 (free). */
const num = (value: unknown, min: number): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= min ? value : undefined

export const ZEN_V1 = `${ZEN_BASE_URL.replace(/\/+$/, '')}/v1`

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

/** Full metadata for the picker, sharing forModelsDev's provider selection with the free decision. */
export function decodeModelsDevMeta(data: unknown): Map<string, ModelMeta> {
  const result = new Map<string, ModelMeta>()
  forModelsDev(data, (modelId, raw) => {
    const cost = (raw.cost ?? {}) as Record<string, unknown>
    const limit = (raw.limit ?? {}) as Record<string, unknown>
    const modalities = (raw.modalities ?? {}) as { input?: unknown }
    const inputs = Array.isArray(modalities.input) ? modalities.input : []
    result.set(modelId, {
      name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : undefined,
      reasoning: raw.reasoning === true,
      image: raw.attachment === true || inputs.includes('image'),
      contextWindow: num(limit.context, 1),
      maxTokens: num(limit.output, 1),
      costInput: num(cost.input, 0),
      costOutput: num(cost.output, 0),
      costCacheRead: num(cost.cache_read, 0),
    })
  })
  return result
}

/** Build the pi model list for the picker: ids already decided free by the catalog. */
export function toPiModels(ids: string[], meta: Map<string, ModelMeta>, protocols: Map<string, ZenProtocol> = new Map()): Array<Model<Api>> {
  return ids.map((id) => {
    const m = meta.get(id)
    const protocol = protocols.get(id)
    const api =
      protocol === 'responses' ? 'openai-responses' : protocol === 'anthropic' ? 'anthropic-messages' : 'openai-completions'
    return {
      id,
      name: m?.name ?? id,
      api,
      provider: PROVIDER_ID,
      // the Anthropic SDK appends /v1/messages itself; openai layers want /v1
      baseUrl: protocol === 'anthropic' ? ZEN_BASE_URL : ZEN_V1,
      reasoning: m?.reasoning ?? false,
      // pi-ai defaults reasoning-capable models to effort "none", which Zen
      // rejects; marking off unsupported skips the reasoning param instead.
      ...(protocol === 'responses' ? { thinkingLevelMap: { off: null } } : {}),
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
