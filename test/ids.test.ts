import test from 'node:test'
import assert from 'node:assert/strict'

import { conversationSeed, canonicalSessionID, deriveRequestIDs, disguiseHeaders, opencodeUserAgent, projectID, randomID } from '../src/ids.ts'

test('randomID differs per call with the requested size', () => {
  const a = randomID('req', 16)
  const b = randomID('req', 16)
  assert.notEqual(a, b)
  assert.ok(a.startsWith('req_'))
  assert.equal(a.slice('req_'.length).length, 32, '16 bytes hex')
})

test('projectID is a bare 40-hex id: a canonical prj_* one is a 403', () => {
  const id = projectID('opencode2pi:default-project')
  assert.ok(/^[0-9a-f]{40}$/.test(id))
  assert.equal(projectID('opencode2pi:default-project'), id)
  assert.notEqual(projectID('other'), id)
})

test('conversationSeed uses the first user turn and skips non-user messages', () => {
  const messages = [
    { role: 'system', content: 'sys prompt' },
    { role: 'assistant', content: 'hi' },
    { role: 'user', content: { text: 'first question' } },
    { role: 'user', content: 'second' },
  ]
  assert.equal(conversationSeed(messages), JSON.stringify({ text: 'first question' }))
  assert.equal(conversationSeed([]), '')
  assert.equal(conversationSeed([{ role: 'assistant', content: 'x' }]), '')
  assert.equal(conversationSeed([{ role: 'user', content: null }]), '', 'null content is skipped')
})

test('canonicalSessionID forces the descending-time shape the free tier requires', () => {
  const canonical = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
  // The 12 hex chars are ~(timestamp_ms << 12 | counter), counter in 1..63,
  // so a real session's time part ends in ffc0..ffff.
  const descending = /^[0-9a-f]{9}f[c-f][0-9a-f]$/

  const shaped = canonicalSessionID('hello')
  assert.ok(canonical.test(shaped), `${shaped} must match the canonical shape`)
  assert.ok(descending.test(shaped.slice(4, 16)), `${shaped} must carry the descending time part`)
  assert.equal(shaped.slice('ses_'.length + 12).length, 14, '14 base62 characters')
  assert.equal(canonicalSessionID(shaped), shaped, 'a genuine session passes through untouched')
  assert.equal(canonicalSessionID('hello'), shaped, 'the same signal yields the same session')
  assert.notEqual(canonicalSessionID('hello'), canonicalSessionID('world'))

  // Shape-correct but not a descending timestamp: the exact bug this fixes.
  const legacy = 'ses_00000000000000000000000001'
  assert.equal(canonicalSessionID(legacy).slice(0, 4), 'ses_')
  assert.ok(descending.test(canonicalSessionID(legacy).slice(4, 16)), 'it must be re-encoded, not passed on')
})

test('deriveRequestIDs keeps the session stable across turns', () => {
  const turnOne = [{ role: 'user', content: 'hello' }]
  const turnTwo = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi there' },
    { role: 'user', content: 'more' },
  ]
  const first = deriveRequestIDs(turnOne)
  const second = deriveRequestIDs(turnTwo)
  assert.equal(first.session, second.session)
  assert.ok(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(first.session), 'derived sessions are always canonical')
  assert.ok(/^[0-9a-f]{9}f[c-f][0-9a-f]$/.test(first.session.slice(4, 16)), 'derived sessions decode as a descending timestamp')
  assert.equal(first.project, second.project)
  assert.equal(first.parent, undefined, 'no declared parent means no parent header')
  // fallback: no user content at all still yields usable ids
  const empty = deriveRequestIDs([{ role: 'system', content: 'only system' }])
  assert.ok(empty.session.startsWith('ses_'))
  assert.notEqual(empty.session, deriveRequestIDs([{ role: 'system', content: 'only system' }]).session)
})

test('deriveRequestIDs prefers the caller-declared session and parent', () => {
  const messages = [{ role: 'user', content: 'hello' }]
  // A genuine client session: canonical shape AND a descending time part.
  const declared = deriveRequestIDs(messages).session
  const fromSession = deriveRequestIDs(messages, { sessionId: declared })
  assert.equal(fromSession.session, declared, 'a genuine declared session passes through')
  assert.notEqual(fromSession.session, deriveRequestIDs(messages, { sessionId: 'other' }).session)

  const named = deriveRequestIDs(messages, { metadata: { session_id: declared, parent_session_id: 'parent-uuid' } })
  assert.equal(named.session, declared)
  assert.ok(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(named.parent ?? ''), 'the parent is canonicalized too')
  assert.equal(disguiseHeaders(named)['x-parent-session-id'], named.parent)
  assert.equal(disguiseHeaders(deriveRequestIDs(messages))['x-parent-session-id'], undefined)
})

test('disguiseHeaders carries the CLI-identical correlation set', () => {
  const ids = deriveRequestIDs([{ role: 'user', content: 'hello' }])
  const headers = disguiseHeaders(ids)
  assert.equal(opencodeUserAgent(), 'opencode/latest/2.0.29/cli', 'the dated UA form is rejected with 403')
  assert.equal(headers['user-agent'], opencodeUserAgent())
  assert.equal(headers['x-opencode-client'], 'cli')
  assert.equal(headers['x-opencode-session'], ids.session)
  assert.equal(headers['x-opencode-session-id'], ids.session)
  assert.equal(headers['x-session-affinity'], ids.session)
  assert.equal(headers['X-Session-Id'], ids.session)
  assert.equal(headers['x-opencode-project'], ids.project)
  // both of these are themselves a 403 FreeTierError
  assert.equal(headers['x-opencode-request'], undefined, 'sending x-opencode-request is a 403')
  assert.ok(!ids.project.startsWith('prj_'), 'a canonical prj_* project id is a 403')
  assert.equal(headers['x-opencode-session'], deriveRequestIDs([{ role: 'user', content: 'hello' }]).session, 'stable across calls')
})
