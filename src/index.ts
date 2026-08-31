import { writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  createProvider,
  type Api,
  type Context,
  type Model,
  type Provider,
  type ProviderStreams,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai'
import * as openaiCompletions from '@earendil-works/pi-ai/api/openai-completions'
import type { OpenAICompletionsOptions } from '@earendil-works/pi-ai/api/openai-completions'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { ModelCatalog, defaultCachePath, type CatalogSnapshot } from './catalog.ts'
import { deriveRequestIDs, disguiseHeaders } from './ids.ts'
import { ANONYMOUS_KEY, PROVIDER_ID, PROVIDER_NAME, ZEN_V1, decodeModelsDevMeta, toPiModels } from './models.ts'

/**
 * opencode2pi pi extension entry.
 *
 * Registers a native pi provider streaming directly from the OpenCode Zen
 * anonymous lane. The wire layer is pi-ai's openai-completions implementation
 * (the same one pi uses for every OpenAI-compatible provider); this module
 * adds the CLI disguise headers, the derived session/request ids, and the
 * free-model catalog (see CONTEXT.md for the vocabulary).
 *
 * Registration model (docs/adr/0001): the factory is synchronous and registers
 * the S3 static list so the picker is never empty; the catalog refreshes in
 * the background and re-registers the provider as the live catalog lands.
 * pi forbids timers in the factory (it may run in invocations that never
 * start a session), so the refresh loop starts on the first session_start.
 */

// Module-level singleton: survives extension factory re-runs (/reload) so the
// refresh timer is never duplicated and the old provider is replaced in place.
// The constructor only assigns fields — no I/O, no timers — so eager creation
// at module load is safe. Timers start on the first session_start (ADR 0001).
const catalog = new ModelCatalog({
  cachePath: defaultCachePath(join(homedir(), '.opencode2pi')),
  onRefresh: (status, lastError) => {
    writeStatus(status, lastError)
    if (lastError) console.warn(`opencode2pi: catalog refresh issue: ${lastError}`)
    // Re-register a fresh provider: baseline models are rebuilt from the
    // catalog, and pi replaces the provider (and its models) in place.
    piRef?.registerProvider(buildProvider(catalog))
  },
})
let catalogStarted = false

export default function (pi: ExtensionAPI): void {
  // Register pi for the onRefresh hook; the singleton is reused on re-run.
  piRef = pi

  // t=0: S3 static list (catalog.list() while pending). The picker is never
  // empty and startup never blocks on the network.
  pi.registerProvider(buildProvider(catalog))
  console.info(`opencode2pi: provider "${PROVIDER_ID}" registered (${catalog.list().length} static models; catalog warms up in background)`)

  pi.on('session_start', async () => {
    if (!catalogStarted) {
      catalogStarted = true
      void catalog.start().catch((err) => {
        console.error(`opencode2pi: catalog start failed: ${err instanceof Error ? err.message : String(err)}`)
        catalogStarted = false
      })
    }
  })
}

// The catalog outlives any single extension instance; the latest instance is
// used to re-register the provider when the catalog refreshes.
let piRef: ExtensionAPI | null = null

function writeStatus(status: CatalogSnapshot, lastError: string): void {
  void writeFile(
    join(homedir(), '.opencode2pi', 'adapter-status.json'),
    JSON.stringify({ ...status, lastError, writtenAt: new Date().toISOString() }, null, 2),
    'utf8',
  ).catch(() => {})
}

function buildProvider(cat: ModelCatalog): Provider<Api> {
  return createProvider<Api>({
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    baseUrl: ZEN_V1,
    auth: {
      apiKey: {
        name: 'OpenCode Zen anonymous lane (no key)',
        resolve: async () => ({ auth: { apiKey: ANONYMOUS_KEY }, source: 'anonymous lane' }),
      },
    },
    models: toPiModels(cat.list(), decodeModelsDevMeta(cat.rawMetadata)),
    api: zenApi(),
  })
}

/**
 * The wire layer: pi-ai openai-completions with the per-request disguise
 * headers and derived ids injected into the stream options. pi hands us a
 * native pi-ai Context, so no request/response conversion is needed.
 */
function zenApi(): ProviderStreams {
  const inject = (context: Context, options?: SimpleStreamOptions): SimpleStreamOptions => {
    const ids = deriveRequestIDs(context.messages)
    return {
      ...options,
      apiKey: ANONYMOUS_KEY,
      sessionId: ids.session,
      headers: { ...options?.headers, ...disguiseHeaders(ids) },
    }
  }
  const model = (m: Model<Api>) => m as Model<'openai-completions'>
  return {
    stream: (m, context, options) =>
      openaiCompletions.stream(model(m), context, inject(context, options) as OpenAICompletionsOptions),
    streamSimple: (m, context, options) =>
      openaiCompletions.streamSimple(model(m), context, inject(context, options)),
  }
}
