import test from 'node:test'
import assert from 'node:assert/strict'

import { agentShape, agentTool, readTool } from '../src/shape.ts'
import { OPENCODE_CLI_TOOLS } from '../src/opencode-tools.ts'

const READ = OPENCODE_CLI_TOOLS.read!

test('agentShape forces streaming and a genuine read tool onto a bare chat body', () => {
  const shaped = agentShape({ model: 'x', messages: [] }, 'chat')!

  assert.equal(shaped.stream, true)
  assert.deepEqual(shaped.stream_options, { include_usage: true }, 'a forced chat stream keeps usage available')
  assert.deepEqual(shaped.tools, [
    { type: 'function', function: { name: 'read', description: READ.description, parameters: READ.parameters } },
  ])
  assert.ok(Object.keys(READ.parameters.properties as object).length > 0, 'read carries a real parameter schema')
})

test('agentShape returns undefined when the body already satisfies the shape', () => {
  const body = { model: 'x', stream: true, stream_options: { include_usage: true }, tools: [readTool('chat')] }
  assert.equal(agentShape(body, 'chat'), undefined, 'an unchanged body is not rewritten')
})

test('agentShape replaces a recognised tool with the genuine definition and adds a missing read', () => {
  // pi's own tool set: the names line up with the CLI, the definitions do not.
  const stub = { type: 'function', function: { name: 'bash', description: 'd', parameters: { type: 'object', properties: {} } } }
  const write = { type: 'function', function: { name: 'write', description: 'mine', parameters: { type: 'object', properties: { path: {} } } } }
  const shaped = agentShape({ model: 'x', stream: true, tools: [stub, write] }, 'chat')!

  assert.deepEqual(
    (shaped.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name),
    ['bash', 'write', 'read'],
  )
  const [bash, genWrite] = shaped.tools as Array<{ type: string; function: Record<string, unknown> }>
  assert.deepEqual(bash, { type: 'function', function: { name: 'bash', description: OPENCODE_CLI_TOOLS.shell!.description, parameters: OPENCODE_CLI_TOOLS.shell!.parameters } }, 'a stub `bash` is a 403: the genuine shell definition under that name is accepted')
  assert.equal((genWrite!.function.parameters as Record<string, unknown>).required !== undefined, true, 'write is recognised: the genuine schema replaces the caller\u2019s')
})

test('agentShape replaces only the definitions it recognises', () => {
  const untouched = { type: 'function', function: { name: 'powershell', description: 'mine', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } }
  const shaped = agentShape({ stream: true, stream_options: { include_usage: true }, tools: [untouched, readTool('chat')] }, 'chat')
  assert.equal(shaped, undefined, 'the CLI does not know powershell: nothing to rewrite')
})

test('agentShape never leaves a recognised name with an empty schema', () => {
  const empty = (name: string) => ({ type: 'function', function: { name, parameters: { type: 'object', properties: {} } } })
  const shaped = agentShape({ stream: true, stream_options: { include_usage: true }, tools: [empty('read'), empty('glob'), empty('bash'), empty('todo')] }, 'chat')!
  const tools = shaped.tools as Array<{ function: { name: string; parameters: { properties: Record<string, unknown> } } }>
  for (const name of ['read', 'glob', 'bash']) {
    const tool = tools.find((t) => t.function.name === name)!
    assert.ok(Object.keys(tool.function.parameters.properties).length > 0, `${name} must carry a real schema`)
  }
  assert.deepEqual(tools[3]!.function.parameters, { type: 'object', properties: {} }, 'an unrecognised name keeps whatever the caller sent')
})

test('agentShape keeps other stream_options keys while forcing usage', () => {
  const shaped = agentShape({ stream: false, stream_options: { custom: 1 } }, 'chat')!
  assert.deepEqual(shaped.stream_options, { custom: 1, include_usage: true })
})

test('agentShape uses each protocol native tool shape', () => {
  const responses = agentShape({ input: 'hi' }, 'responses')!
  assert.deepEqual(responses.tools, [
    { type: 'function', name: 'read', description: READ.description, parameters: READ.parameters },
  ])
  assert.equal('stream_options' in responses, false, 'only chat carries stream_options')

  const messages = agentShape({ messages: [] }, 'anthropic')!
  assert.deepEqual(messages.tools, [
    { name: 'read', description: READ.description, input_schema: READ.parameters },
  ])
})

test('agentShape ignores payloads it cannot rewrite', () => {
  assert.equal(agentShape('not json', 'chat'), undefined)
  assert.equal(agentShape([1, 2], 'chat'), undefined)
  assert.equal(agentShape(null, 'chat'), undefined)
})

test('agentShape never rewrites a tools value it cannot read', () => {
  const shaped = agentShape({ stream: true, stream_options: { include_usage: true }, tools: 'bash,read' }, 'chat')
  assert.equal(shaped, undefined, 'an unreadable tools value is left for the lane to reject')
})

test('the vendored CLI tool map holds the genuine definitions', () => {
  assert.deepEqual(Object.keys(OPENCODE_CLI_TOOLS).sort(), [
    'edit', 'execute', 'glob', 'grep', 'question', 'read', 'shell', 'skill', 'subagent', 'webfetch', 'websearch', 'write',
  ])
  assert.equal(OPENCODE_CLI_TOOLS.bash, undefined, 'the CLI shell tool is `shell`, not `bash`')
  for (const [name, tool] of Object.entries(OPENCODE_CLI_TOOLS)) {
    assert.ok(tool.description.length > 0, `${name} has a description`)
    assert.ok(Object.keys(tool.parameters.properties as object).length > 0, `${name} has a real schema`)
    assert.equal(tool.parameters.additionalProperties, false, `${name} is closed`)
  }
  assert.deepEqual(agentTool('chat', 'read'), { type: 'function', function: { name: 'read', description: READ.description, parameters: READ.parameters } })
  assert.equal(agentTool('chat', 'bash'), undefined, 'an unknown name has no genuine definition')
})
