import type { Api, Model } from '@earendil-works/pi-ai'
import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all'

import type { CapabilityMeta, ZenProtocol } from './catalog.ts'
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

const API_BY_PROTOCOL: Partial<Record<ZenProtocol, string>> = {
  responses: 'openai-responses',
  anthropic: 'anthropic-messages',
  chat: 'openai-completions',
}

/**
 * Protocol-specific pi-ai compat flags: the responses API needs the thinking
 * level map and no session affinity, plain chat needs the store/role/token
 * field overrides, and the anthropic path takes pi-ai's defaults.
 */
function apiCompat(protocol: ZenProtocol | undefined, api: Api) {
  if (protocol === 'responses') {
    return {
      thinkingLevelMap: { off: null },
      compat: { sessionAffinityFormat: 'openai-nosession' as const },
    }
  }
  if (api === 'openai-completions') {
    return {
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        maxTokensField: 'max_tokens' as const,
      },
    }
  }
  return {}
}

/**
 * Build the pi model list for the picker: ids already decided free by the
 * catalog. Limits and modalities prefer the capability catalog (the same
 * source that declares the protocol) and fall back to models.dev, then to the
 * builtin pi model, then to a conservative default.
 */
export function toPiModels(
  ids: string[],
  meta: Map<string, ModelMeta>,
  protocols: Map<string, ZenProtocol> = new Map(),
  capabilityMeta: Map<string, CapabilityMeta> = new Map(),
): Array<Model<Api>> {
  return ids.map((id) => {
    const builtin = (getBuiltinModel as (provider: string, modelId: string) => Model<Api> | undefined)('opencode', id)
    const m = meta.get(id)
    const caps = capabilityMeta.get(id)
    const contextWindow = caps?.contextWindow ?? m?.contextWindow
    const maxTokens = caps?.maxTokens ?? m?.maxTokens
    const reasoning = caps?.reasoning ?? m?.reasoning ?? false
    const image = caps?.image ?? m?.image ?? false
    if (builtin) {
      return {
        ...builtin,
        provider: PROVIDER_ID,
        ...(m?.name ? { name: m.name } : {}),
        ...(contextWindow ? { contextWindow } : {}),
        ...(maxTokens ? { maxTokens } : {}),
        ...(image && !builtin.input.includes('image') ? { input: [...builtin.input, 'image'] } : {}),
      }
    }
    const protocol = protocols.get(id)
    const api = ((protocol && API_BY_PROTOCOL[protocol]) || 'openai-completions') as Api
    return {
      id,
      name: m?.name ?? id,
      api,
      provider: PROVIDER_ID,
      // the Anthropic SDK appends /v1/messages itself; openai layers want /v1
      baseUrl: protocol === 'anthropic' ? ZEN_BASE_URL : ZEN_V1,
      reasoning,
      ...apiCompat(protocol, api),
      input: image ? ['text', 'image'] : ['text'],
      cost: {
        input: m?.costInput ?? 0,
        output: m?.costOutput ?? 0,
        cacheRead: m?.costCacheRead ?? 0,
        cacheWrite: 0,
      },
      contextWindow: contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: maxTokens ?? DEFAULT_MAX_TOKENS,
    } as Model<Api>
  })
}
