import type { Api, ClassifierApi, ClassifierModel, Model } from '@earendil-works/pi-ai'
import { getBuiltinClassifierModel, getBuiltinModel } from '@earendil-works/pi-ai/providers/all'

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

/**
 * The lane's protocol hosts. Since pi-ai 1.5 (upstream #11434) Zen serves each
 * wire protocol on its own host instead of the shared `/inference/v1`; the
 * shared paths still answer, but these are the ones upstream declares.
 */
export const ZEN_OPENAI = `${ZEN_BASE_URL.replace(/\/+$/, '')}/openai/v1`
export const ZEN_ANTHROPIC = `${ZEN_BASE_URL.replace(/\/+$/, '')}/anthropic`

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

/** The host a model speaks: the Anthropic SDK appends /v1/messages itself. */
function hostFor(api: Api): string {
  return api === 'anthropic-messages' ? ZEN_ANTHROPIC : ZEN_OPENAI
}

/**
 * The builtin opencode classifier entry for an id, if the id names one. Only a
 * guard: Zen's catalogs list no classifier id, so nothing is registered as a
 * classifier — this just keeps a stray classifier id out of the chat list.
 */
function builtinClassifier(id: string): ClassifierModel<ClassifierApi> | undefined {
  const get = getBuiltinClassifierModel as (
    provider: string,
    modelId: string,
  ) => ClassifierModel<ClassifierApi> | undefined
  return get('opencode', id)
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
  // A classifier id only speaks System One, never chat completions.
  return ids.filter((id) => builtinClassifier(id) === undefined).map((id) => {
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
        // pi's builtin opencode entries still pin the retired /zen host, which
        // now answers 403 for the anonymous lane: re-home them to the live one.
        baseUrl: hostFor(builtin.api),
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
      baseUrl: hostFor(api),
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
