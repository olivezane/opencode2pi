import test from 'node:test'
import assert from 'node:assert/strict'

import { AGENT_TOOLS, agentShape, agentTools } from '../src/shape.ts'

test('agentShape forces streaming and the core agent tools onto a bare chat body', () => {
  const shaped = agentShape({ model: 'x', messages: [] }, 'chat')!

  assert.equal(shaped.stream, true)
  assert.deepEqual(shaped.stream_options, { include_usage: true }, 'a forced chat stream keeps usage available')
  assert.deepEqual(
    (shaped.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name),
    ['bash', 'read'],
  )
})

test('agentShape returns undefined when the body already satisfies the gate', () => {
  const body = {
    model: 'x',
    stream: true,
    stream_options: { include_usage: true },
    tools: agentTools('chat'),
  }
  assert.equal(agentShape(body, 'chat'), undefined, 'an unchanged body is not rewritten')
})

test('agentShape appends only the missing core tool', () => {
  const bash = { type: 'function', function: { name: 'bash', description: 'd', parameters: {} } }
  const shaped = agentShape({ model: 'x', stream: true, tools: [bash, { type: 'function', function: { name: 'write' } }] }, 'chat')!

  assert.deepEqual(
    (shaped.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name),
    ['bash', 'write', 'read'],
    'the declared tool survives and only read is added',
  )
})

test('agentShape leaves a body that already streams and declares the core tools unchanged', () => {
  const tools = agentTools('chat')
  const shaped = agentShape({ stream: true, tools, stream_options: { include_usage: true, other: 1 } }, 'chat')
  assert.equal(shaped, undefined)
})

test('agentShape keeps other stream_options keys while forcing usage', () => {
  const shaped = agentShape({ stream: false, stream_options: { custom: 1 } }, 'chat')!
  assert.deepEqual(shaped.stream_options, { custom: 1, include_usage: true })
})

test('agentShape uses each protocol native tool shape', () => {
  const responses = agentShape({ input: 'hi' }, 'responses')!
  assert.deepEqual(responses.tools, [
    { type: 'function', name: 'bash', description: 'Agent tool bash', parameters: { type: 'object', properties: {} } },
    { type: 'function', name: 'read', description: 'Agent tool read', parameters: { type: 'object', properties: {} } },
  ])
  assert.equal('stream_options' in responses, false, 'only chat carries stream_options')

  const messages = agentShape({ messages: [] }, 'anthropic')!
  assert.deepEqual(messages.tools, [
    { name: 'bash', description: 'Agent tool bash', input_schema: { type: 'object', properties: {} } },
    { name: 'read', description: 'Agent tool read', input_schema: { type: 'object', properties: {} } },
  ])
})

test('agentShape ignores payloads it cannot rewrite', () => {
  assert.equal(agentShape('not json', 'chat'), undefined)
  assert.equal(agentShape([1, 2], 'chat'), undefined)
  assert.equal(agentShape(null, 'chat'), undefined)
})

test('agentShape never rewrites a tools value it cannot read', () => {
  const shaped = agentShape({ stream: true, tools: 'bash,read' }, 'chat')
  assert.equal(shaped, undefined, 'an unreadable tools value is left for the lane to reject')
})

test('AGENT_TOOLS is the pair the free tier checks', () => {
  assert.deepEqual(AGENT_TOOLS, ['bash', 'read'])
})
