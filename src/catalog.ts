import { readFile, rename, rm, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import ledger from './free-models.json' with { type: 'json' }
import { opencodeUserAgent } from './ids.ts'

/**
 * Port of agent/internal/catalog (opencode2api models.go + model_metadata.go,
 * trimmed to the single anonymous Zen lane) plus the S3 static fallback:
 *
 *   S1  GET {zen}/v1/models            live catalog (in-sale ids, free or paid)
 *   S2  GET https://models.dev/api.json  pricing metadata -> free decision
 *   S3  compile-time verified ids       last-resort bootstrap list
 *
 * /v1/models-equivalent exposure = S1 ∩ S2-allowed (or S3 while S1 is pending).
 */

export const ZEN_BASE_URL = 'https://opencode.ai/zen'

/**
 * OpenCode's machine-readable provider catalog (models.opencode.ai/api.json):
 * per-model SDK choice, which is the upstream native protocol declaration.
 * Only chat-native models are safe for pi's openai-completions wire layer.
 */
export const CAPABILITIES_URL = 'https://models.opencode.ai/api.json'

/** Slow-moving data (capability catalog, models.dev prices): refresh daily. */
const DAILY_REFRESH_MS = 24 * 60 * 60 * 1000

export type ZenProtocol = 'chat' | 'responses' | 'anthropic'

export interface ZenCapabilities {
  /** model id -> native protocol (SDK-declared). */
  protocols: Map<string, ZenProtocol>
  /** models present on Zen but whose SDK is not one of the known protocols. */
  unsupported: Set<string>
}

/** protocolForSDK (models.go): SDK npm -> upstream native protocol. */
export function protocolForSdk(npm: string): ZenProtocol | undefined {
  const value = npm.toLowerCase().trim()
  if (value.includes('anthropic')) return 'anthropic'
  if (value === '@ai-sdk/openai' || value.endsWith('/openai')) return 'responses'
  if (value.includes('openai-compatible')) return 'chat'
  return undefined
}

/** isZenProvider (capabilityTier trimmed to the anonymous Zen lane). */
function isZenProvider(providerId: string, api: string): boolean {
  const value = `${providerId} ${api}`.toLowerCase()
  if (value.includes('opencode-go') || value.includes('/go/')) return false
  return value.includes('opencode') || value.includes('/zen/')
}

/**
 * decodeZenCapabilities: port of fetchProtocolCapabilities (models.go:431)
 * trimmed to the single anonymous Zen lane. Visits each Zen model exactly
 * once; per-model SDK overrides the provider default. Unknown SDK => flagged
 * as unsupported (distinguished from absent, which stays exposed).
 */
export function decodeZenCapabilities(data: unknown): ZenCapabilities {
  const protocols = new Map<string, ZenProtocol>()
  const unsupported = new Set<string>()
  if (!data || typeof data !== 'object') return { protocols, unsupported }
  const providers = data as Record<
    string,
    { id?: unknown; api?: unknown; npm?: unknown; models?: Record<string, { id?: unknown; provider?: { npm?: unknown } }> }
  >
  for (const [providerId, provider] of Object.entries(providers)) {
    if (!provider || typeof provider !== 'object') continue
    if (!isZenProvider(String(providerId), String(provider.api ?? ''))) continue
    const npm = typeof provider.npm === 'string' ? provider.npm : ''
    for (const [modelKey, model] of Object.entries(provider.models ?? {})) {
      if (!model || typeof model !== 'object') continue
      const modelId = typeof model.id === 'string' && model.id.length > 0 ? model.id : modelKey
      const sdk = typeof model.provider?.npm === 'string' ? model.provider.npm : npm
      const protocol = protocolForSdk(sdk)
      if (protocol) protocols.set(modelId, protocol)
      else unsupported.add(modelId)
    }
  }
  return { protocols, unsupported }
}

/** S2-catalog: fetchProtocolCapabilities with the CLI disguise headers. */
export async function fetchZenCapabilities(
  capabilitiesUrl: string,
  fetchImpl: typeof fetch,
  userAgent: string,
): Promise<ZenCapabilities> {
  const response = await withTimeout(fetchImpl(capabilitiesUrl, { headers: { accept: 'application/json', 'user-agent': userAgent } }))
  if (!response.ok) throw new Error(`capability endpoint returned HTTP ${response.status}`)
  const caps = decodeZenCapabilities(await response.json())
  if (caps.protocols.size === 0 && caps.unsupported.size === 0) {
    throw new Error('capability endpoint returned no Zen models')
  }
  return caps
}

/**
 * Verified/banned ids from the probe ledger (free-models.json), which the
 * daily workflow (scripts/probe-models.mjs) rewrites from real lane probes.
 * Mitigated externally never changed by hand except via the script.
 */
export const staticFreeModels: string[] = ledger.verified.map((entry) => entry.id)
export const staticUnavailable: string[] = ledger.unavailable.map((entry) => entry.id)

export function isFreeModel(model: string): boolean {
  return model.toLowerCase().includes('free')
}

export interface AnonymousDecision {
  allowed: boolean
  source: string
  known: boolean
}

interface ModelPrice {
  input?: number
  output?: number
  deprecated: boolean
}

/** Decide ports model_metadata.go Decide (192-237) line for line. */
export function decide(model: string, prices: Map<string, ModelPrice>, ready: boolean): AnonymousDecision {
  const nameFree = isFreeModel(model)
  const fallback = (source: string): AnonymousDecision => {
    if (nameFree) return { allowed: true, source: 'name_free', known: false }
    return { allowed: false, source, known: false }
  }
  if (!ready || prices.size === 0) return fallback('metadata_pending')
  const price = prices.get(model)
  if (!price) return fallback('metadata_model_missing')
  const metadataFree = !price.deprecated && price.input === 0 && price.output === 0
  if (nameFree || metadataFree) {
    const source = nameFree && metadataFree ? 'name_and_metadata_free' : nameFree ? 'name_free' : 'metadata_free'
    return { allowed: true, source, known: true }
  }
  if (price.deprecated) return { allowed: false, source: 'metadata_deprecated', known: true }
  if (price.input === undefined || price.output === undefined) {
    return { allowed: false, source: 'metadata_cost_unknown', known: false }
  }
  return { allowed: false, source: 'metadata_paid', known: true }
}

/**
 * Walk the OpenCode provider section of the models.dev payload
 * (model_metadata.go:253-335): prefer the exact `opencode`/`opencode-zen`
 * key, then any key containing "opencode" whose identity matches; visit each
 * model exactly once and stop after the first section that yielded one.
 */
export function forModelsDev(data: unknown, visit: (modelId: string, raw: Record<string, unknown>) => void): void {
  if (!data || typeof data !== 'object') return
  const providers = data as Record<string, { models?: Record<string, Record<string, unknown>>; id?: unknown; name?: unknown }>
  const rank = (key: string): number => {
    const lower = key.toLowerCase()
    if (lower === 'opencode' || lower === 'opencode-zen' || lower === 'opencode_zen') return 0
    if (lower.includes('opencode')) return 1
    return 2
  }
  const keys = Object.keys(providers).sort((left, right) => {
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
    let visited = 0
    for (const [modelKey, raw] of Object.entries(models)) {
      if (!raw || typeof raw !== 'object') continue
      const modelId = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : modelKey
      visit(modelId, raw)
      visited += 1
    }
    if (visited > 0) return
  }
}

/** decodeModelsDev (model_metadata.go:253-335): prices for the free decision. */
export function decodeModelsDev(data: unknown): Map<string, ModelPrice> {
  const result = new Map<string, ModelPrice>()
  forModelsDev(data, (modelId, raw) => {
    const cost = (raw.cost ?? {}) as Record<string, unknown>
    const num = (value: unknown): number | undefined =>
      typeof value === 'number' && Number.isFinite(value) ? value : undefined
    result.set(modelId, {
      input: num(cost.input),
      output: num(cost.output),
      deprecated: metadataDeprecated(raw),
    })
  })
  return result
}

function metadataDeprecated(model: Record<string, unknown>): boolean {
  if (model.deprecated === true) return true
  const status = String(model.status ?? model.lifecycle ?? '').toLowerCase()
  if (status === 'deprecated' || status === 'retired' || status === 'disabled') return true
  return model.deprecated_at != null || model.retirement_date != null
}

export interface CatalogSnapshot {
  status: 'pending' | 'ready' | 'stale' | 'error'
  total: number
  exposed: number
  lastRefresh?: string
}

export interface CatalogOptions {
  /** S1 refresh cadence. */
  refreshSeconds?: number
  /** Where the models.dev cache lives (data dir). */
  cachePath?: string
  /** Upstream override for tests. */
  zenBaseUrl?: string
  /** models.dev override for tests. */
  metadataUrl?: string
  /** OpenCode capability catalog override for tests. */
  capabilitiesUrl?: string
  fetchImpl?: typeof fetch
  now?: () => number
  /** Observability hook: fired after every refresh round (start + interval). */
  onRefresh?: (status: CatalogSnapshot, lastError: string) => void
  /** Fired when runtime feedback changed the exposure set (cooldown on/off). */
  onChange?: () => void
  /** Delay between startup retries while the live catalog is empty (default 15s). */
  startupRetryMs?: number
  /** Test seam: verified static ids (default: probe ledger). */
  staticIds?: string[]
  /** Test seam: banned ids (default: probe ledger). */
  bannedIds?: string[]
}

/** Runtime hard-failure codes: the model/report itself was rejected (probe policy, compressed to session scale). */
const RUNTIME_HARD_CODES = new Set([400, 401])
/** Cooldown after one hard failure; a later success clears it (pool.go feedback, compressed). */
const RUNTIME_COOLDOWN_MS = 10 * 60 * 1000

const FETCH_TIMEOUT_MS = 30_000

/**
 * Live model directory with the S1/S2/S3 fallback chain and the timer-driven
 * refresh loop. All state is in-memory; only the models.dev cache persists.
 */
export class ModelCatalog {
  #zen: Set<string> = new Set()
  #updatedAt = 0
  #prices: Map<string, ModelPrice> = new Map()
  #pricesReady = false
  #lastError = ''
  #refreshSeconds: number
  #cachePath?: string
  #zenBaseUrl: string
  #metadataUrl: string
  #capabilitiesUrl: string
  #fetch: typeof fetch
  #now: () => number
  #timer: NodeJS.Timeout | null = null
  #stopped = false
  #onRefresh?: (status: CatalogSnapshot, lastError: string) => void
  #onChange?: () => void
  #startupRetryMs: number
  #staticIds: string[]
  #bannedIds: string[]
  /** Raw models.dev provider payload, for full model metadata (src/models.ts). */
  #rawMetadata: unknown = null
  /** Native protocols from the OpenCode capability catalog; empty until it lands. */
  #capabilities: ZenCapabilities = { protocols: new Map(), unsupported: new Set() }
  #capsFetchedAt = 0
  /** Runtime cooldown: model id -> timestamp until which hard-failed ids are hidden. */
  #cooldownUntil: Map<string, number> = new Map()

  constructor(options: CatalogOptions = {}) {
    this.#refreshSeconds = options.refreshSeconds ?? 300
    this.#cachePath = options.cachePath
    this.#zenBaseUrl = options.zenBaseUrl ?? ZEN_BASE_URL
    this.#metadataUrl = options.metadataUrl ?? 'https://models.dev/api.json'
    this.#capabilitiesUrl = options.capabilitiesUrl ?? CAPABILITIES_URL
    this.#fetch = options.fetchImpl ?? fetch
    this.#now = options.now ?? Date.now
    this.#onRefresh = options.onRefresh
    this.#onChange = options.onChange
    this.#startupRetryMs = options.startupRetryMs ?? 15_000
    this.#staticIds = options.staticIds ?? staticFreeModels
    this.#bannedIds = options.bannedIds ?? staticUnavailable
  }

  /**
   * Start the refresh loop: immediate S1+S2, fast retries while the live
   * catalog is still empty (the first fetch often races the machine's network
   * coming up — VPN/TUN reconnect, DNS), then the normal cadence (S2 24h).
   */
  async start(): Promise<void> {
    await this.refreshOnce()
    let attempts = 0
    while (this.#zen.size === 0 && attempts < 4 && !this.#stopped) {
      attempts += 1
      await new Promise((resolve) => setTimeout(resolve, this.#startupRetryMs))
      if (this.#stopped) return
      await this.refreshOnce()
    }
    if (this.#stopped) return
    this.#timer = setInterval(() => {
      void this.refreshOnce()
    }, this.#refreshSeconds * 1000)
    this.#timer.unref?.()
  }

  stop(): void {
    this.#stopped = true
    if (this.#timer) {
      clearInterval(this.#timer)
      this.#timer = null
    }
  }

  async refreshOnce(): Promise<void> {
    await Promise.allSettled([this.refreshZen(), this.refreshMetadata(), this.refreshCapabilities()])
    if (this.#onRefresh) {
      try {
        this.#onRefresh(this.snapshot(), this.#lastError)
      } catch {
        // observers must never break the refresh loop
      }
    }
  }

  /** Native protocols refresh on their own 24h cadence (the SDK choice changes slowly). */
  async refreshCapabilities(): Promise<void> {
    if (this.#capsFetchedAt !== 0 && this.#now() - this.#capsFetchedAt < DAILY_REFRESH_MS) return
    try {
      this.#capabilities = await fetchZenCapabilities(this.#capabilitiesUrl, this.#fetch, opencodeUserAgent())
      this.#capsFetchedAt = this.#now()
    } catch {
      // unknown protocol states stay exposed: degrade to no-filter instead of hiding
    }
  }

  async refreshZen(): Promise<void> {
    try {
      const ids = await fetchZenModels(this.#zenBaseUrl, this.#fetch, opencodeUserAgent())
      this.#zen = new Set(ids)
      this.#updatedAt = this.#now()
      this.#lastError = ''
    } catch (err) {
      this.#lastError = err instanceof Error ? err.message : String(err)
    }
  }

  async refreshMetadata(): Promise<void> {
    try {
      const response = await withTimeout(this.#fetch(this.#metadataUrl, { headers: { accept: 'application/json' } }))
      if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`)
      const data = (await response.json()) as unknown
      const prices = decodeModelsDev(data)
      if (prices.size === 0) throw new Error('models.dev contains no OpenCode model metadata')
      this.#prices = prices
      this.#pricesReady = true
      this.#rawMetadata = data
      if (this.#cachePath) await saveMetadataCache(this.#cachePath, prices, this.#now())
    } catch (err) {
      // Network failure with a cached copy is not fatal: load the cache.
      if (this.#cachePath && !this.#pricesReady) {
        const cached = await loadMetadataCache(this.#cachePath).catch(() => null)
        if (cached && cached.size > 0) {
          this.#prices = cached
          this.#pricesReady = true
          return
        }
      }
      this.#lastError = err instanceof Error ? err.message : String(err)
    }
  }

  decision(model: string): AnonymousDecision {
    if (this.#bannedIds.includes(model)) {
      return { allowed: false, source: 'static_banned', known: true }
    }
    if ((this.#cooldownUntil.get(model) ?? 0) > this.#now()) {
      return { allowed: false, source: 'runtime_cooldown', known: true }
    }
    const metadata = decide(model, this.#prices, this.#pricesReady)
    if (!metadata.allowed && !metadata.known && this.#staticIds.includes(model)) {
      return { allowed: true, source: 'static_verified', known: false }
    }
    return metadata
  }

  /** Chat-native only: pi sends openai-completions, so responses/anthropic-native ids are not pickable. */
  capable(model: string): boolean {
    if (this.#capsFetchedAt === 0) return true
    if (this.#capabilities.unsupported.has(model)) return false
    const protocol = this.#capabilities.protocols.get(model)
    // unknown protocols degrade to exposed: only proven non-chat ids are hidden
    return protocol === undefined || protocol === 'chat'
  }

  /** ids exposed to the picker: free ∧ chat-native, or the static verified set while the live catalog is pending. */
  list(): string[] {
    const ids = this.#zen.size === 0 ? this.#staticIds : [...this.#zen]
    return ids.filter((model) => this.decision(model).allowed && this.capable(model)).sort()
  }

  /**
   * Runtime feedback from real requests (pool.go MarkFailure compressed to a
   * per-model cooldown): hard 400/401 hide the model for a fixed window;
   * flaky statuses are ignored (they are pi-ai's retry domain).
   */
  reportFailure(model: string, status: number | undefined): void {
    if (status === undefined || !RUNTIME_HARD_CODES.has(status)) return
    this.#cooldownUntil.set(model, this.#now() + RUNTIME_COOLDOWN_MS)
    if (this.#onChange) {
      try {
        this.#onChange()
      } catch {
        // observers must never break request handling
      }
    }
  }

  /** A later success clears any pending runtime cooldown (the model recovered). */
  reportSuccess(model: string): void {
    if (!this.#cooldownUntil.delete(model)) return
    if (this.#onChange) {
      try {
        this.#onChange()
      } catch {
        // observers must never break request handling
      }
    }
  }

  snapshot(): CatalogSnapshot {
    const age = this.#updatedAt === 0 ? Infinity : this.#now() - this.#updatedAt
    const stale = this.#updatedAt !== 0 && age > 10 * 60 * 1000
    return {
      status: this.#updatedAt === 0 ? 'pending' : stale ? 'stale' : 'ready',
      total: this.#zen.size,
      exposed: this.list().length,
      ...(this.#updatedAt !== 0 ? { lastRefresh: new Date(this.#updatedAt).toISOString() } : {}),
    }
  }

  get lastError(): string {
    return this.#lastError
  }

  /** The raw models.dev JSON from the last successful fetch (null while pending/restored-from-cache). */
  get rawMetadata(): unknown {
    return this.#rawMetadata
  }
}

async function withTimeout(promise: Promise<Response>, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await promise
  } finally {
    clearTimeout(timer)
  }
}

/** S1: fetchModels (models.go:587-618) with the CLI disguise headers. */
export async function fetchZenModels(
  zenBaseUrl: string,
  fetchImpl: typeof fetch,
  userAgent: string,
): Promise<string[]> {
  const response = await withTimeout(
    fetchImpl(`${zenBaseUrl.replace(/\/+$/, '')}/v1/models`, {
      headers: {
        authorization: 'Bearer public',
        'user-agent': userAgent,
        'x-opencode-client': 'cli',
        accept: 'application/json',
      },
    }),
  )
  if (!response.ok) throw new Error(`models endpoint returned HTTP ${response.status}`)
  const payload = (await response.json()) as { data?: Array<{ id?: unknown }> }
  const models: string[] = []
  for (const item of payload.data ?? []) {
    if (typeof item?.id === 'string' && item.id.length > 0) models.push(item.id)
  }
  if (models.length === 0) throw new Error('models endpoint returned an empty list')
  return models
}

interface MetadataCache {
  updatedAt: number
  prices: Array<[string, ModelPrice]>
}

async function saveMetadataCache(path: string, prices: Map<string, ModelPrice>, now: number): Promise<void> {
  const cache: MetadataCache = { updatedAt: now, prices: [...prices] }
  const tmp = `${path}.${process.pid}.tmp`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(tmp, JSON.stringify(cache), 'utf8')
  await rm(path, { force: true })
  await rename(tmp, path)
}

async function loadMetadataCache(path: string): Promise<Map<string, ModelPrice>> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as MetadataCache
  if (Date.now() - raw.updatedAt > 7 * DAILY_REFRESH_MS) {
    throw new Error('models.dev cache too old')
  }
  return new Map(raw.prices)
}

/** Default models.dev cache location in the data dir. */
export function defaultCachePath(dataDir: string): string {
  return join(dataDir, 'models-dev-cache.json')
}
