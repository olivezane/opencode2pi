import test from 'node:test'
import assert from 'node:assert/strict'

import type { Api, Context, Model, ProviderStreams, SimpleStreamOptions } from '@earendil-works/pi-ai'

import { guardedStream, statusFromErrorMessage, wireLayer, type StreamResult } from '../src/stream.ts'

test('statusFromErrorMessage reads pi-ai\u2019s provider error formats', () => {
  assert.equal(statusFromErrorMessage('400: Invalid model'), 400)
  assert.equal(statusFromErrorMessage('opencode2pi (401): Incorrect API key'), 401)
  assert.equal(statusFromErrorMessage('404 status code (no body)'), 404)
  assert.equal(statusFromErrorMessage('429 Too Many Requests'), 429)
  assert.equal(statusFromErrorMessage('Stream ended without finish_reason'), undefined)
  assert.equal(statusFromErrorMessage('Request was aborted'), undefined)
  assert.equal(statusFromErrorMessage(undefined), undefined)
})

function events(events: unknown[]) {
  return (async function* () {
    for (const event of events) yield event
  })() as AsyncGenerator<{ type: string }>
}

test('guardedStream reports done as success and passes events through', async () => {
  const results: StreamResult[] = []
  const seen = []
  for await (const event of guardedStream(events([{ type: 'start' }, { type: 'done' }]), (r) => results.push(r))) {
    seen.push(event.type)
  }
  assert.deepEqual(seen, ['start', 'done'])
  assert.deepEqual(results, [{ outcome: 'success' }])
})

test('guardedStream reports error with the parsed status', async () => {
  const results: StreamResult[] = []
  for await (const _ of guardedStream(
    events([{ type: 'error', error: { errorMessage: '400: Invalid model' } }]),
    (r) => results.push(r),
  )) {
    // consumed fully
  }
  assert.deepEqual(results, [{ outcome: 'error', status: 400 }])
})

test('wireLayer delegates to the implementation, applies inject and reports through the guard', async () => {
  const results: StreamResult[] = []
  const seen: string[] = []
  const fakeSource = () =>
    (async function* () {
      yield { type: 'start' }
      yield { type: 'done' }
    })() as AsyncIterable<unknown>
  const implementation = {
    stream: (_m: unknown, _c: unknown, options: unknown) => {
      seen.push('stream')
      assert.equal((options as { apiKey?: string }).apiKey, 'public', 'inject is applied')
      return fakeSource()
    },
    streamSimple: (_m: unknown, _c: unknown, options: unknown) => {
      seen.push('streamSimple')
      assert.equal((options as { apiKey?: string }).apiKey, 'public', 'inject is applied')
      return fakeSource()
    },
  } as unknown as ProviderStreams
  const inject = (_context: Context, options?: SimpleStreamOptions): SimpleStreamOptions => ({ ...options, apiKey: 'public' })
  const report = (_modelId: string) => (result: StreamResult) => results.push(result)
  const layer = wireLayer(implementation, inject, report)

  for await (const _ of layer.stream({ id: 'm', provider: 'p' } as unknown as Model<Api>, {} as Context, {})) {
    // consumed
  }
  for await (const _ of layer.streamSimple({ id: 'm', provider: 'p' } as unknown as Model<Api>, {} as Context, {})) {
    // consumed
  }
  assert.deepEqual(seen, ['stream', 'streamSimple'])
  assert.deepEqual(results, [{ outcome: 'success' }, { outcome: 'success' }])
})

test('guardedStream never lets an observer throw break the stream', async () => {
  const seen = []
  for await (const event of guardedStream(events([{ type: 'done' }]), () => {
    throw new Error('observer bug')
  })) {
    seen.push(event.type)
  }
  assert.deepEqual(seen, ['done'])
})
