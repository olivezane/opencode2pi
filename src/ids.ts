import { createHash, randomBytes } from 'node:crypto'

/**
 * Port of agent/internal/ids + identity (opencode2api ids.go / request.go):
 * a stable project id plus a session derived from the conversation and shaped
 * canonically. The upstream sees CLI-identical correlation headers built from
 * these (index.ts).
 */

export interface RequestIDs {
  session: string
  project: string
  /** Parent conversation, when the caller declares one (subagent sessions). */
  parent?: string
}

/**
 * OpenCode's canonical session shape: "ses_" + 12 lowercase hex characters +
 * 14 Base62 characters.
 */
const CANONICAL_SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/

/**
 * The 12 hex characters encode `~(timestamp_ms << 12 | counter)` with the
 * counter in 1..63, so a real OpenCode session's time part always ends in ffe
 * (range ffc0..ffff). Since 2026-10-14 the free tier decodes those bits and
 * rejects anything else with 403 FreeTierError ("OpenCode's free tier can only
 * be used from within OpenCode"); a raw sha256 prefix passes the shape check
 * but lands in the accepted window only ~1.5% of the time.
 */
const DESCENDING_TIME_PART_PATTERN = /^[0-9a-f]{9}f[c-f][0-9a-f]$/
const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** 36 hash bits -> the descending-time encoding upstream expects (request.go). */
function descendingTimePart(sum: Buffer): string {
  const bits = (BigInt(`0x${sum.subarray(0, 4).toString('hex')}`) << 4n) | BigInt(sum[4]! >> 4)
  return ((~(bits << 12n | 1n)) & 0xffffffffffffn).toString(16).padStart(12, '0')
}

/**
 * Canonicalize a session signal: an already-official OpenCode session (both
 * the shape and the descending time part) passes through untouched
 * (preserving upstream prompt-cache affinity and quota grouping), anything
 * else is deterministically hashed into the canonical shape so one
 * conversation keeps one stable session.
 */
export function canonicalSessionID(signal: string): string {
  if (CANONICAL_SESSION_PATTERN.test(signal) && DESCENDING_TIME_PART_PATTERN.test(signal.slice(4, 16))) return signal
  const sum = createHash('sha256').update(`ses\x00${signal}`).digest()
  let remainder = BigInt(`0x${sum.subarray(6, 16).toString('hex')}`)
  let randomPart = ''
  for (let index = 0; index < 14; index += 1) {
    randomPart = BASE62_ALPHABET.charAt(Number(remainder % 62n)) + randomPart
    remainder /= 62n
  }
  return `ses_${descendingTimePart(sum)}${randomPart}`
}

/**
 * The value of `x-opencode-project`. A canonical `prj_*` id is rejected with
 * 403 since 2026-10-14; upstream mints a bare 40-character lowercase hex
 * digest instead (the value itself is never read, only its shape).
 */
export function projectID(value: string): string {
  return createHash('sha256').update(`opencode-project\x00${value}`).digest().subarray(0, 20).toString('hex')
}

/** sha256("prefix\0value") truncated to 12 bytes: stable, non-reversible. */
export function stableID(prefix: string, value: string): string {
  const sum = createHash('sha256').update(prefix + '\x00' + value).digest()
  return `${prefix}_${sum.subarray(0, 12).toString('hex')}`
}

export function randomID(prefix: string, size: number): string {
  return `${prefix}_${randomBytes(size).toString('hex')}`
}

/**
 * The conversation signal: JSON of the first user message's content. Using the
 * first user turn keeps a multi-turn conversation stable as its history grows
 * while separating conversations with different beginnings (ids.go:59-76).
 */
export function conversationSeed(messages: Array<{ role: string; content: unknown }>): string {
  for (const message of messages) {
    if (message.role !== 'user') continue
    const encoded = JSON.stringify(message.content ?? null)
    if (encoded !== 'null' && encoded.length > 0) return encoded
  }
  return ''
}

/** Caller-supplied session context (pi's stream options). */
export interface SessionContext {
  sessionId?: string
  metadata?: Record<string, unknown>
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string {
  const value = metadata?.[key]
  return typeof value === 'string' ? value : ''
}

/**
 * Session signal priority (request.go DeriveRequestIDs): an explicit session
 * declared by the caller wins — it is the closest equivalent of the CLI's own
 * session — then an explicit conversation id, then the first user turn, then a
 * random fallback for content-free requests.
 */
export function sessionSignal(
  messages: Array<{ role: string; content: unknown }>,
  options: SessionContext = {},
): string {
  const declared =
    metadataString(options.metadata, 'session_id') ||
    metadataString(options.metadata, 'conversation_id') ||
    (options.sessionId ?? '')
  if (declared !== '') return declared
  const seed = conversationSeed(messages)
  return seed !== '' && seed !== '{}' ? seed : randomID('fallback', 16)
}

/** Derive the correlation ids for one upstream request. */
export function deriveRequestIDs(
  messages: Array<{ role: string; content: unknown }>,
  options: SessionContext = {},
): RequestIDs {
  const parent = metadataString(options.metadata, 'parent_session_id')
  const ids: RequestIDs = {
    session: canonicalSessionID(sessionSignal(messages, options)),
    project: projectID('opencode2pi:default-project'),
  }
  if (parent !== '') ids.parent = canonicalSessionID(parent)
  return ids
}

/**
 * CLI-identical user agent (httpx/client.go UserAgent). The dated
 * `opencode/<version> (<os> <arch>; <runtime>)` form this replaced is
 * rejected with 403 FreeTierError once the rest of the request matches.
 */
export function opencodeUserAgent(): string {
  return 'opencode/latest/2.0.29/cli'
}

/**
 * The disguise header set sent with every upstream request (upstream.go
 * newUpstreamRequest). Two omissions are load-bearing: no `x-opencode-request`
 * (any value -> 403) and a non-`prj_*` project id.
 */
export function disguiseHeaders(ids: RequestIDs): Record<string, string> {
  return {
    'user-agent': opencodeUserAgent(),
    'x-opencode-client': 'cli',
    'x-opencode-session': ids.session,
    'x-opencode-session-id': ids.session,
    'x-session-affinity': ids.session,
    'X-Session-Id': ids.session,
    'x-opencode-project': ids.project,
    ...(ids.parent ? { 'x-parent-session-id': ids.parent } : {}),
  }
}
