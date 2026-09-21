import assert from 'node:assert/strict'
import test from 'node:test'

import extension from '../src/index.ts'
import { ANONYMOUS_KEY, PROVIDER_ID } from '../src/models.ts'

test('factory seeds configured auth before the native registration', () => {
  const calls: unknown[][] = []
  const pi = {
    registerProvider: (...args: unknown[]): void => {
      calls.push(args)
    },
    on: (): void => {},
  }
  extension(pi as never)

  assert.equal(calls.length, 2)
  // 1. config form: string id + apiKey marks the provider configured synchronously
  assert.equal(calls[0]![0], PROVIDER_ID)
  assert.deepEqual(calls[0]![1], { apiKey: ANONYMOUS_KEY })
  // 2. native Provider object carries the models and the wire layer
  assert.equal(typeof calls[1]![0], 'object')
  assert.equal((calls[1]![0] as { id: string }).id, PROVIDER_ID)
})
