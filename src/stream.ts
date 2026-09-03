/**
 * Runtime feedback seam between the provider stream layer and the catalog:
 * pi-ai swallows upstream HTTP errors into a terminal `error` event carrying
 * only a display string, so the status must be recovered from that string.
 * pi consumes provider streams via async iteration (lazyStream forwards
 * events), so an async generator is the entire surface we need.
 */

export type StreamResult = { outcome: 'success' } | { outcome: 'error'; status: number | undefined }

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
  const prefixed = /^[^()]*\((\d{3})\):/.exec(message) // "opencode2pi (401): ..."
  const leading = /^(\d{3})\b/.exec(message) // "400: ...", "400 status code ..."
  const status = Number(prefixed?.[1] ?? leading?.[1])
  return Number.isFinite(status) && status > 0 ? status : undefined
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
      try {
        onResult(outcome)
      } catch {
        // an observer bug must never break streaming
      }
    }
    yield event
  }
}
