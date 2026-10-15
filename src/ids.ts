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
 * is minted exactly like the real client (opencode packages/schema/src/
 * identifier.ts): a 48-bit descending timestamp (Date.now()<<12 | counter,
 * bitwise-NOT) as 12 hex chars, plus 14 CSPRNG bytes mapped to base62.
 *
 * Why not a deterministic hash anymore: since ~2026-10 the Zen free tier
 * decodes the 12 hex chars and checks their low 12 bits as a per-millisecond
 * counter, accepting only counter in [0, 63]; hash-derived prefixes land in
 * that window with probability ~1.5% and are rejected with 403 FreeTierError
 * (shape-valid but not genuine). A real client id (counter=1) always ends its
 * hex prefix with "ffe" (~1 & 0xFFF = 0xFFE), a structural byproduct of the
 * bitwise NOT. Mechanism verified by live probes:
 * https://github.com/FishBottle7/opencode2dsh/pull/68
 */
export function canonicalSessionID(signal: string): string {
  if (CANONICAL_SESSION_PATTERN.test(signal)) return signal
  const current = BigInt(Date.now()) * 0x1000n + 1n
  const value = ~current & 0xffffffffffffn
  const timePart = value.toString(16).padStart(12, '0')
  const bytes = randomBytes(14)
  let randomPart = ''
  for (let index = 0; index < 14; index += 1) {
    randomPart += BASE62_ALPHABET[bytes[index] % 62]
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
    // The free lane validates `x-opencode-project` against the real client's
    // default ("global"); arbitrary `prj_*` ids get 403 FreeTierError since
    // the 2026-10-15 /inference/v1 migration.
    project: 'global',
  }
  if (parent !== '') ids.parent = canonicalSessionID(parent)
  return ids
}

/** CLI-identical user agent (ids.go opencodeUserAgent, node runtime values). */
export function opencodeUserAgent(): string {
  return `opencode/1.18.31 (${process.platform} ${process.arch}; node${process.versions.node})`
}

/**
 * The CLI-identical header set (model-request.ts createRequestHeaders):
 * the real client sends no `x-opencode-request` — that header is added only
 * by the opencode2api gateway when forwarding to upstream, and the free lane
 * rejects requests carrying it with 403 FreeTierError since 2026-10-15
 * (verified live). Keep this list exactly matching the client.
 */
export function disguiseHeaders(ids: RequestIDs): Record<string, string> {
  return {
    'user-agent': opencodeUserAgent(),
    'x-opencode-client': 'cli',
    'x-opencode-session-id': ids.session,
    'x-opencode-session': ids.session,
    'x-session-affinity': ids.session,
    'X-Session-Id': ids.session,
    'x-opencode-project': ids.project,
    ...(ids.parent ? { 'x-parent-session-id': ids.parent } : {}),
  }
}
