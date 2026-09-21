import type {
  AssistantMessageEventStream,
  Context,
  ProviderStreams,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai'

import { logWarn } from './logger.ts'

/**
 * Runtime feedback seam between the provider stream layer and the catalog:
 * pi-ai swallows upstream HTTP errors into a terminal `error` event carrying
 * only a display string, so the status must be recovered from that string.
 * pi consumes provider streams via async iteration (lazyStream forwards
 * events), so an async generator is the entire surface we need.
 */

export type StreamResult = { outcome: 'success' } | { outcome: 'error'; status: number | undefined }

/**
 * Observer bugs must never break the stream, but they must not be invisible
 * either: report them to the extension log instead of propagating.
 */
function reportSafely(onResult: (result: StreamResult) => void, result: StreamResult): void {
  try {
    onResult(result)
  } catch (err) {
    logWarn(`stream observer failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

interface GuardedEvent {
  type: string
  error?: { errorMessage?: string }
}

/**
 * Recover the HTTP status from pi-ai's provider error formats
 * (utils/error-body.ts): `"400: body"`, `"provider (401): body"`, or the raw
 * SDK message `"400 status code (no body)"`. Non-HTTP failures return
 * undefined so the caller treats them as flaky.
 */
export function statusFromErrorMessage(message: string | undefined): number | undefined {
  if (!message) return undefined
  const prefixed = /^[^()]*\((\d{3})\):/.exec(message) // "opencode (401): ...", "opencode2pi (401): ..."
  const leading = /^(\d{3})\b/.exec(message) // "400: ...", "400 status code ..."
  const status = Number(prefixed?.[1] ?? leading?.[1])
  return Number.isFinite(status) && status > 0 ? status : undefined
}

/**
 * Wire a provider API implementation into a guarded layer: inject the
 * per-request options, report the terminal outcome, keep the stream events
 * untouched. One layer per protocol (chat/responses/anthropic).
 */
export function wireLayer(
  implementation: ProviderStreams,
  inject: (context: Context, options?: SimpleStreamOptions) => SimpleStreamOptions,
  report: (modelId: string) => (result: StreamResult) => void,
): ProviderStreams {
  const wrap = (inner: AssistantMessageEventStream, modelId: string): AssistantMessageEventStream => {
    const onResult = report(modelId)
    // SAFETY: pi-ai's AssistantMessageEventStream yields AssistantMessageEvent,
    // and this layer only reads the two GuardedEvent fields (type, error
    // message) while passing every event through untouched; no runtime change.
    const generator = guardedStream(inner as unknown as AsyncIterable<GuardedEvent>, onResult)
    return new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === Symbol.asyncIterator) {
          return () => generator[Symbol.asyncIterator]()
        }
        if (prop === 'next') return generator.next.bind(generator)
        if (prop === 'return') return generator.return.bind(generator)
        if (prop === 'throw') return generator.throw.bind(generator)
        if (prop === 'result') {
          return async () => {
            try {
              const res = await target.result()
              reportSafely(onResult, { outcome: 'success' })
              return res
            } catch (err) {
              reportSafely(onResult, {
                outcome: 'error',
                status: statusFromErrorMessage(err instanceof Error ? err.message : String(err)),
              })
              throw err
            }
          }
        }
        const val = Reflect.get(target, prop, receiver)
        return typeof val === 'function' ? val.bind(target) : val
      },
    })
  }
  return {
    stream: (m, context, options) => wrap(implementation.stream(m, context, inject(context, options)), m.id),
    streamSimple: (m, context, options) => wrap(implementation.streamSimple(m, context, inject(context, options)), m.id),
  }
}

/**
 * Wrap a pi-ai assistant stream: report its terminal outcome to an observer
 * (the catalog's runtime feedback) while passing events through untouched.
 * An observer bug never breaks streaming.
 */
export async function* guardedStream<T extends GuardedEvent>(
  stream: AsyncIterable<T>,
  onResult: (result: StreamResult) => void,
): AsyncGenerator<T> {
  for await (const event of stream) {
    if (event.type === 'error' || event.type === 'done') {
      const outcome: StreamResult =
        event.type === 'error'
          ? { outcome: 'error', status: statusFromErrorMessage(event.error?.errorMessage) }
          : { outcome: 'success' }
      reportSafely(onResult, outcome)
    }
    yield event
  }
}
