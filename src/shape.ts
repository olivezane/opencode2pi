/**
 * Agent-shape normalization for the anonymous lane.
 *
 * Since 2026-10-14 the free tier answers `403 FreeTierError` unless the request
 * body carries streaming plus a tool named `read` whose parameter schema is a
 * real object, and it compares every tool it recognises against the official
 * CLI's definition. A synthesized stub (`{ type: 'object', properties: {} }`)
 * under a recognised name — `bash` included — poisons the request.
 *
 * So: keep whatever the caller declared, replace the definition of recognised
 * names with the genuine one, and make sure `read` is there. Tool order is
 * irrelevant and unknown names are not checked. The daily probe re-checks the
 * requirement and fails loudly if it widens.
 */

import { isDeepStrictEqual } from 'node:util'

import { OPENCODE_CLI_TOOLS, type CliToolDefinition } from './opencode-tools.ts'

/** Protocol whose native tool shape the payload carries. */
export type ShapeProtocol = 'chat' | 'responses' | 'anthropic'

/** The genuine definition of one CLI tool in a protocol's native tool shape. */
export function agentTool(
  protocol: ShapeProtocol,
  name: string,
  definition: CliToolDefinition | undefined = OPENCODE_CLI_TOOLS[name],
): Record<string, unknown> | undefined {
  if (!definition) return undefined
  if (protocol === 'anthropic') return { name, description: definition.description, input_schema: definition.parameters }
  if (protocol === 'responses') return { type: 'function', name, description: definition.description, parameters: definition.parameters }
  return { type: 'function', function: { name, description: definition.description, parameters: definition.parameters } }
}

/** The genuine `read` definition: the one name the gate insists on. */
export function readTool(protocol: ShapeProtocol): Record<string, unknown> {
  return agentTool(protocol, 'read')!
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The tool name a wire entry declares, in the shape of the given protocol. */
function toolName(protocol: ShapeProtocol, entry: unknown): string {
  if (!isRecord(entry)) return ''
  if (protocol === 'chat') {
    const fn = entry.function
    return isRecord(fn) && typeof fn.name === 'string' ? fn.name : ''
  }
  return typeof entry.name === 'string' ? entry.name : ''
}

/**
 * Names a client uses for a CLI tool under a different name. The CLI's shell
 * tool is `shell`; declaring `bash` with an empty schema is rejected outright,
 * while the genuine `shell` definition under the name `bash` is accepted — and
 * the caller needs the name it declared to route the result back.
 */
const TOOL_ALIASES: Record<string, string> = { bash: 'shell' }

/** Replace a recognised tool's definition with the genuine one in place. */
function genuineTool(protocol: ShapeProtocol, entry: unknown): Record<string, unknown> | undefined {
  const name = toolName(protocol, entry)
  if (name === '') return undefined
  const source = name in OPENCODE_CLI_TOOLS ? name : TOOL_ALIASES[name]
  if (!source) return undefined
  // Same name, genuine body: keep every extra key the caller attached.
  const next = { ...(isRecord(entry) ? entry : {}), ...agentTool(protocol, name, OPENCODE_CLI_TOOLS[source]) }
  return isDeepStrictEqual(next, entry) ? undefined : next
}

/**
 * Force streaming on a chat payload and keep token usage available: the Chat
 * SSE path only reports usage when `stream_options.include_usage` is set, so a
 * caller that asked for a plain JSON reply would otherwise lose it.
 */
function forceStream(payload: Record<string, unknown>, protocol: ShapeProtocol): boolean {
  if (payload.stream === true && (protocol !== 'chat' || isRecord(payload.stream_options) && payload.stream_options.include_usage === true)) {
    return false
  }
  payload.stream = true
  if (protocol !== 'chat') return true
  const options = payload.stream_options
  if (isRecord(options)) {
    options.include_usage = true
  } else {
    payload.stream_options = { include_usage: true }
  }
  return true
}

/**
 * Return a copy of `payload` that satisfies the free tier's agent shape, or
 * `undefined` when it already does (or is not a JSON object, which the lane
 * would reject for other reasons).
 */
export function agentShape(payload: unknown, protocol: ShapeProtocol): Record<string, unknown> | undefined {
  if (!isRecord(payload)) return undefined
  const next = { ...payload }
  let changed = forceStream(next, protocol)

  const tools = next.tools
  if (tools === undefined) {
    next.tools = [readTool(protocol)]
    changed = true
  } else if (Array.isArray(tools)) {
    let hasRead = false
    const shaped = tools.map((entry) => {
      const name = toolName(protocol, entry)
      if (name === 'read') hasRead = true
      const genuine = genuineTool(protocol, entry)
      if (!genuine) return entry
      changed = true
      return genuine
    })
    if (!hasRead) {
      shaped.push(readTool(protocol))
      changed = true
    }
    if (changed) next.tools = shaped
  }
  // A `tools` value of another type is left alone: the lane rejects it for
  // reasons this shape cannot fix, and rewriting it would hide that.

  return changed ? next : undefined
}
