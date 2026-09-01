#!/usr/bin/env node
/**
 * Probe the OpenCode Zen anonymous lane and refresh the free-model ledger
 * (src/free-models.json). Zero dependencies (global fetch). Designed to be
 * run by .github/workflows/probe-models.yml daily and manually at any time:
 *
 *   node scripts/probe-models.mjs
 *
 * Policy (grilled 2026-09-01, see CONTEXT.md "Probe ledger"):
 *   - verified:  probe answered 200 today -> exposed (static bootstrap + live)
 *   - pending:   hard-failed once (400/401/500/502/503) -> recorded, still
 *                exposed via live metadata; promoted to banned if it fails
 *                again on a later day
 *   - unavailable (banned): hard-failed on two consecutive days -> excluded
 *   - recovery:  any id answering 200 today is removed from pending/unavailable
 *   - indeterminate (timeout, 429, network error, other status): leave the
 *     entry exactly as it is — never ban on a flaky probe
 *   - an id in the ledger that is no longer in /v1/models is probed anyway
 *     (401/4xx confirms it left the free set)
 *
 * Hard exit (exit 1, no writes) if the upstream catalog or models.dev is
 * unreachable, so a network blip can never mass-rewrite the ledger.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const LEDGER_PATH = resolve(ROOT, 'src/free-models.json')
const ZEN_BASE = 'https://opencode.ai/zen'
const METADATA_URL = 'https://models.dev/api.json'
const ANONYMOUS = 'public'
const PROBE_SPACING_MS = 8000
const PROBE_TIMEOUT_MS = 30000
const MAX_TOKENS = 4
const HARD_CODES = new Set([400, 401, 500, 502, 503])

const today = () => new Date().toISOString().slice(0, 10)
const userAgent = () => `opencode/1.18.21 (${process.platform} ${process.arch}; node${process.versions.node})`
const headers = (extra = {}) => ({
  authorization: `Bearer ${ANONYMOUS}`,
  'user-agent': userAgent(),
  'x-opencode-client': 'cli',
  'x-session-affinity': 'ses_probe',
  'X-Session-Id': 'ses_probe',
  ...extra,
})

async function main() {
  const zenIds = await fetchZenIds()
  const prices = await fetchFreePrices()
  const ledger = JSON.parse(await readFile(LEDGER_PATH, 'utf8'))

  // Candidates: everything the lane might serve free (name or metadata says
  // free) plus every id already in the ledger (to track rotation/recovery).
  const currentIds = [...ledger.verified, ...ledger.unavailable, ...ledger.pending].map((e) => e.id)
  const candidateIds = [
    ...zenIds.filter((id) => id.toLowerCase().includes('free') || prices.has(id)),
    ...currentIds,
  ]
  const candidates = [...new Set(candidateIds)].sort()

  const verdicts = new Map()
  for (const id of candidates) {
    const status = await probe(id)
    verdicts.set(id, status)
    console.log(`${String(status).padEnd(8)} ${id}`)
    await new Promise((r) => setTimeout(r, PROBE_SPACING_MS))
  }

  const next = { verified: [], unavailable: [], pending: [] }
  const put = (section, entry) => next[section].push(entry)
  const byId = (a, b) => a.id.localeCompare(b.id)

  for (const id of candidates) {
    const status = verdicts.get(id)
    const inUnavailable = ledger.unavailable.find((e) => e.id === id)
    const inPending = ledger.pending.find((e) => e.id === id)
    if (status === 200) {
      const alreadyVerified = ledger.verified.find((e) => e.id === id)
      put('verified', { id, verified: alreadyVerified ? alreadyVerified.verified : today() })
    } else if (HARD_CODES.has(status)) {
      if (inUnavailable) {
        put('unavailable', { id, firstFailed: inUnavailable.firstFailed, lastCode: status })
      } else if (inPending && inPending.firstFailed < today()) {
        put('unavailable', { id, firstFailed: inPending.firstFailed, lastCode: status })
      } else {
        put('pending', { id, firstFailed: today(), lastCode: status })
      }
    } else {
      // indeterminate: keep the entry exactly where it was
      if (inUnavailable) put('unavailable', inUnavailable)
      else if (inPending) put('pending', inPending)
      else if (ledger.verified.some((e) => e.id === id)) put('verified', ledger.verified.find((e) => e.id === id))
    }
  }

  const out = {
    verified: next.verified.sort(byId),
    unavailable: next.unavailable.sort(byId),
    pending: next.pending.sort(byId),
  }
  await writeFile(LEDGER_PATH, `${JSON.stringify(out, null, 2)}\n`, 'utf8')
  console.log(
    `\nledger: verified=${out.verified.length} unavailable=${out.unavailable.length} pending=${out.pending.length}`,
  )
}

async function fetchZenIds() {
  const response = await fetch(`${ZEN_BASE}/v1/models`, { headers: headers({ accept: 'application/json' }) })
  if (!response.ok) throw new Error(`zen /v1/models returned HTTP ${response.status}`)
  const payload = await response.json()
  const ids = (payload.data ?? []).map((m) => m.id).filter((id) => typeof id === 'string' && id.length > 0)
  if (ids.length === 0) throw new Error('zen /v1/models returned an empty list')
  return ids
}

async function fetchFreePrices() {
  const response = await fetch(METADATA_URL, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`)
  const data = await response.json()
  if (!data || typeof data !== 'object') throw new Error('models.dev returned an empty payload')
  // Prefer the exact `opencode`/`opencode-zen` key, like the catalog decoder.
  const provider =
    data.opencode ??
    data['opencode-zen'] ??
    Object.entries(data).find(([, p]) => String(p?.id ?? p?.name ?? '').toLowerCase().includes('opencode'))?.[1]
  const free = new Set()
  for (const [key, raw] of Object.entries(provider?.models ?? {})) {
    if (!raw || typeof raw !== 'object') continue
    const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : key
    const deprecated = raw.deprecated === true || ['deprecated', 'retired', 'disabled'].includes(String(raw.status ?? '').toLowerCase())
    const cost = raw.cost ?? {}
    if (!deprecated && cost.input === 0 && cost.output === 0) free.add(id)
  }
  return free
}

async function probe(id) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(`${ZEN_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json', 'x-opencode-request': `req_${Math.random().toString(16).slice(2)}` }),
      body: JSON.stringify({ model: id, messages: [{ role: 'user', content: 'hi' }], max_tokens: MAX_TOKENS, stream: false }),
      signal: controller.signal,
    })
    await response.text()
    return response.status
  } catch {
    return 0 // network/abort: indeterminate
  } finally {
    clearTimeout(timer)
  }
}

main().catch((err) => {
  console.error(`probe failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
