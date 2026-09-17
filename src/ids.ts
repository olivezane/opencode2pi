import { createHash, randomBytes } from 'node:crypto'

/**
 * Port of agent/internal/ids + identity (opencode2api ids.go / request.go):
 * stable session/project ids derived from the conversation, a per-request
 * random id, and canonical session shaping. The upstream sees CLI-identical
 * correlation headers built from these (index.ts).
 */

export interface RequestIDs {
  session: string
  request: string
  project: string
  /** Parent conversation, when the caller declares one (subagent sessions). */
  parent?: string
}

/**
 * OpenCode's canonical session shape: "ses_" + 12 lowercase hex characters +
 * 14 Base62 characters. Since 2026-09-16 the Zen free tier rejects any other
 * shape with 403 FreeTierError ("OpenCode's free tier can only be used from
 * within OpenCode"), so every derived session must match this.
 */
const CANONICAL_SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/**
 * Canonicalize a session signal: an already-official OpenCode session passes
 * through untouched (preserving upstream prompt-cache affinity), anything else
 * is deterministically hashed into the canonical shape so one conversation
 * keeps one stable session.
 */
export function canonicalSessionID(signal: string): string {
  if (CANONICAL_SESSION_PATTERN.test(signal)) return signal
  const sum = createHash('sha256').update(`ses\x00${signal}`).digest()
  const timePart = sum.subarray(0, 6).toString('hex')
  let remainder = BigInt(`0x${sum.subarray(6, 16).toString('hex')}`)
  let randomPart = ''
  for (let index = 0; index < 14; index += 1) {
    randomPart = BASE62_ALPHABET.charAt(Number(remainder % 62n)) + randomPart
    remainder /= 62n
  }
  return `ses_${timePart}${randomPart}`
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
    request: randomID('req', 16),
    project: stableID('prj', 'opencode2pi:default-project'),
  }
  if (parent !== '') ids.parent = canonicalSessionID(parent)
  return ids
}

/** CLI-identical user agent (ids.go opencodeUserAgent, node runtime values). */
export function opencodeUserAgent(): string {
  return `opencode/1.18.31 (${process.platform} ${process.arch}; node${process.versions.node})`
}

/**
 * The full disguise header set sent with every upstream request
 * (gateway.go newUpstreamRequest:640-669).
 */
export function disguiseHeaders(ids: RequestIDs): Record<string, string> {
  return {
    'user-agent': opencodeUserAgent(),
    'x-opencode-client': 'cli',
    'x-opencode-session': ids.session,
    'x-session-affinity': ids.session,
    'X-Session-Id': ids.session,
    'x-opencode-request': ids.request,
    'x-opencode-project': ids.project,
    ...(ids.parent ? { 'x-parent-session-id': ids.parent } : {}),
  }
}
