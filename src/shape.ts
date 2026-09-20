/**
 * Agent-shape normalization for the anonymous lane.
 *
 * Since 2026-09-20 the free tier answers `403 FreeTierError` unless the request
 * body carries streaming plus the core agent tools (`bash` and `read`) in
 * `tools`. Only the names are checked; the definitions may be minimal. pi
 * declares its built-in tools on every normal run, so this fires for tool-free
 * invocations (`-nt`, `--no-builtin-tools` with no extension tools) — without
 * it those requests look like a broken lane and cool the model down.
 *
 * Only the two names the gate actually requires are synthesized, not the wider
 * CLI toolset opencode2api uses: an injected tool is a tool the model can call
 * but pi has not registered, so the footprint stays as small as the gate
 * allows. The daily probe re-checks the requirement and fails loudly if it
 * widens.
 */

/** Protocol whose native tool shape the payload carries. */
export type ShapeProtocol = 'chat' | 'responses' | 'anthropic'

/** Tool names the free tier requires on every request. */
export const AGENT_TOOLS: readonly string[] = ['bash', 'read']

const TOOL_PARAMETERS = { type: 'object', properties: {} }

/** The given tool names in the native tool shape of one protocol. */
export function agentTools(protocol: ShapeProtocol, names: readonly string[] = AGENT_TOOLS): Array<Record<string, unknown>> {
  return names.map((name) => {
    const description = `Agent tool ${name}`
    if (protocol === 'anthropic') return { name, description, input_schema: TOOL_PARAMETERS }
    if (protocol === 'responses') return { type: 'function', name, description, parameters: TOOL_PARAMETERS }
    return { type: 'function', function: { name, description, parameters: TOOL_PARAMETERS } }
  })
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
 * Force streaming on a chat payload and keep token usage available: the Chat
 * SSE path only reports usage when `stream_options.include_usage` is set, so a
 * caller that asked for a plain JSON reply would otherwise lose it.
 */
function forceStream(payload: Record<string, unknown>, protocol: ShapeProtocol): boolean {
  if (payload.stream === true) return false
  payload.stream = true
  if (protocol !== 'chat') return true
  const options = payload.stream_options
  if (isRecord(options)) {
    if (options.include_usage !== true) options.include_usage = true
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
    next.tools = agentTools(protocol)
    changed = true
  } else if (Array.isArray(tools)) {
    const present = new Set(tools.map((entry) => toolName(protocol, entry)))
    const missing = AGENT_TOOLS.filter((name) => !present.has(name))
    if (missing.length > 0) {
      next.tools = [...tools, ...agentTools(protocol, missing)]
      changed = true
    }
  }
  // A `tools` value of another type is left alone: the lane rejects it for
  // reasons this shape cannot fix, and rewriting it would hide that.

  return changed ? next : undefined
}
