#!/usr/bin/env node
/**
 * Probe the OpenCode Zen anonymous lane and refresh the free-model ledger
 * (src/free-models.json). Zero dependencies (global fetch). Designed to be
 * run by .github/workflows/probe-models.yml twice daily and manually at any
 * time:
 *
 *   node scripts/probe-models.mjs
 *
 * Policy (grilled 2026-09-01, see CONTEXT.md "Probe ledger"):
 *   - verified:  probe answered 200 (or 429 — see below) today -> exposed
 *                (static bootstrap + live)
 *   - pending:   hard-failed once (400/401/410) -> recorded, still exposed via
 *                live metadata; promoted to banned if it fails again on a
 *                later day
 *   - unavailable (banned): hard-failed on two consecutive days -> excluded
 *   - recovery:  an id answering 200 today is removed from pending/unavailable
 *   - indeterminate (timeout, network error, other status): leave the entry
 *     exactly as it is — never ban on a flaky probe
 *   - 429 (lane quota spent, per egress IP): verified, exactly like 200 —
 *     the ledger answers "is this model free on the lane", not "does this IP
 *     have quota today", and a spent IP lasts long enough that treating 429 as
 *     indeterminate would freeze a ban forever.
 *     Zen rations the anonymous lane per egress IP and pins retry-after to the
 *     next UTC midnight, so a spent CI IP would otherwise hold the whole
 *     served set unverified indefinitely (2026-10-24: three consecutive runs
 *     recorded zero 200s and the ledger stopped meaning anything)
 *   - every candidate is probed, every run: /v1/models lists ids the lane does
 *     not actually serve, so a 429 on one id says nothing about the next one
 *   - the probe set is exactly /v1/models: an id Zen stops listing leaves the
 *     ledger on the next run, because the list never under-reports even though
 *     it does name ids with no service behind them (2026-10-24: 18 ledger ids
 *     were being re-probed twice a day forever after Zen dropped them)
 *
 * Hard exit (exit 1, no writes) if the upstream catalog or models.dev is
 * unreachable, so a network blip can never mass-rewrite the ledger.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { CAPABILITIES_URL, fetchZenCapabilities, isRouteable } from '../src/catalog.ts'
import { canonicalSessionID, disguiseHeaders, opencodeUserAgent, projectID } from '../src/ids.ts'
// The lane-wide agent shape, shared with the runtime payload hook so a probe
// and a real request can never disagree about what the free tier accepts.
import { readTool } from '../src/shape.ts'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const LEDGER_PATH = resolve(ROOT, 'src/free-models.json')
// Keyless inference moved off /zen onto its own host on 2026-10-14.
const ZEN_BASE = 'https://opencode.ai/inference'
const METADATA_URL = 'https://models.dev/api.json'
const ANONYMOUS = 'public'
const PROBE_SPACING_MS = 8000
const PROBE_TIMEOUT_MS = 30000
const MAX_TOKENS = 4
// Only 4xx semantics (id rejected / not in the free set / model retired) count
// as "hard". 5xx are transient (edge node, load, maintenance) and must never
// ban. 410 ModelDeprecated is the definitive "this model is gone" answer: at
// the 2026-10-23 audit seven ledger-verified ids had left /v1/models and were
// answering 410, but 410 was treated as indeterminate, so they stayed verified
// (and therefore in the S3 static picker) forever.
const HARD_CODES = new Set([400, 401, 410])

const today = () => new Date().toISOString().slice(0, 10)
// Canonical session shape: the free tier rejects anything else with 403.
const PROBE_SESSION = canonicalSessionID('opencode2pi:probe')
// The runtime's own header set, not a hand-rolled copy: a probe that sends a
// subset can pass while a real request fails (2026-10-15: the missing twin
// `x-opencode-session-id` was a 403 here and in every CI run).
const headers = (extra = {}) => ({
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  authorization: `Bearer ${ANONYMOUS}`,
  ...disguiseHeaders({ session: PROBE_SESSION, project: projectID('opencode2pi:probe') }),
  ...extra,
})

async function main() {
  const zenIds = await fetchZenIds()
  const prices = await fetchFreePrices()
  const ledger = JSON.parse(await readFile(LEDGER_PATH, 'utf8'))

  // Capability catalog: skip ids whose SDK is unknown (no known endpoint —
  // nothing to probe); every known protocol is probed on its native endpoint
  // (chat/responses/anthropic), so responses- or messages-native free models
  // are still verified. Unavailable -> degrade to probing every candidate
  // rather than rewrite the ledger from an incomplete picture.
  let caps = null
  try {
    caps = await fetchZenCapabilities(CAPABILITIES_URL, fetch, opencodeUserAgent())
  } catch (err) {
    console.warn(`capability catalog unavailable (${err instanceof Error ? err.message : String(err)}); probing every candidate`)
  }
  const candidates = selectCandidates(zenIds, prices, caps)

  const verdicts = new Map()
  let gateFailures = 0
  for (const id of candidates) {
    // The capability catalog names a protocol for most ids; the rest degrade
    // to chat, which is the common case (see the classifier fallback below).
    const protocol = caps?.protocols.get(id) ?? 'chat'
    let { status, gate } = await probe(id, protocol)
    // 400 is "no such model on this endpoint", and the classifier lane is the
    // only endpoint /v1/models names but never classifies. Retrying a 400 here
    // cannot hide a broken chat model: a chat id that answers 400 on chat is
    // not served on chat either way.
    if (protocol === 'chat' && status === 400) {
      const retry = await probe(id, 'classifier')
      if (retry.status !== 400) ({ status, gate } = retry)
    }
    if (gate) gateFailures++
    verdicts.set(id, status)
    console.log(`${String(status).padEnd(8)} ${id}${gate ? '  <- FreeTierError: probe request shape rejected' : ''}`)
    await new Promise((r) => setTimeout(r, PROBE_SPACING_MS))
  }

  // A lane-wide shape rejection is not a per-model verdict. Writing the
  // ledger here would freeze every entry as indeterminate and hide the
  // breakage, so refuse to write and fail loudly instead.
  if (gateFailures > 0 && gateFailures === verdicts.size) {
    throw new Error(
      `${gateFailures} probes answered 403 FreeTierError: the free tier stopped accepting the probe request shape (readTool)`,
    )
  }

  const next = { verified: [], unavailable: [], pending: [] }
  const put = (section, entry) => next[section].push(entry)
  const byId = (a, b) => a.id.localeCompare(b.id)

  // The ledger describes what /v1/models lists and nothing else: an id Zen
  // stopped listing is dropped on the next run. The list over-reports (it names
  // ids with no service behind them) but it never under-reports, so a name it
  // drops is gone.
  for (const id of candidates) {
    const status = verdicts.get(id)
    const inUnavailable = ledger.unavailable.find((e) => e.id === id)
    const inPending = ledger.pending.find((e) => e.id === id)
    if (countsAsVerified(status)) {
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

/** A 429 is a spent egress IP, not a verdict on the model: the id is served and free. */
export function countsAsVerified(status) {
  return status === 200 || status === 429
}

/**
 * The probe set: ids /v1/models lists right now, free by name or by catalog
 * price, minus those on an SDK with no endpoint mapping. The ledger never
 * widens it: the list over-reports (names with no service behind them) but
 * never under-reports, so an id it drops is gone.
 */
export function selectCandidates(zenIds, prices, caps) {
  const ids = zenIds.filter((id) => id.toLowerCase().includes('free') || prices.has(id))
  if (!caps) return [...new Set(ids)].sort()
  return [...new Set(ids)].filter((id) => isRouteable(caps, id)).sort()
}

/** Native endpoint + auth per protocol (opencode2api protocolPath + lanu auth shapes). */
export function probeRequest(id, protocol) {
  const base = headers()
  // The gate only reads the genuine `read` entry; nothing else is compared.
  const tools = [readTool(protocol)]
  if (protocol === 'responses') {
    return {
      url: `${ZEN_BASE}/v1/responses`,
      headers: base,
      body: { model: id, input: 'hi', stream: true, tools },
    }
  }
  if (protocol === 'classifier') {
    // Zen's System One lane. Its own endpoint, and a body shape of its own:
    // `state` plus questions, with the bool type spelled `noul` on the wire.
    return {
      url: `${ZEN_BASE}/v1/systemone`,
      headers: base,
      body: {
        model: id,
        state: { text: 'hi' },
        questions: {
          probe: {
            type: 'noul',
            instructions: 'Is the text a greeting?',
            criteria: { true: 'a greeting', false: 'not a greeting' },
          },
        },
      },
    }
  }
  if (protocol === 'anthropic') {
    // The lane authenticates anthropic requests via x-api-key, not Bearer
    const { authorization: _auth, ...rest } = base
    return {
      url: `${ZEN_BASE}/v1/messages`,
      headers: { ...rest, 'x-api-key': ANONYMOUS },
      body: {
        model: id,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: MAX_TOKENS,
        stream: true,
        tools,
      },
    }
  }
  return {
    url: `${ZEN_BASE}/v1/chat/completions`,
    headers: base,
    body: {
      model: id,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: MAX_TOKENS,
      stream: true,
      tools,
    },
  }
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

async function probe(id, protocol = 'chat') {
  const request = probeRequest(id, protocol)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: controller.signal,
    })
    const text = await response.text()
    // FreeTierError means the lane rejected the request shape, not the model.
    const gate = response.status === 403 && text.includes('FreeTierError')
    return { status: response.status, gate }
  } catch {
    return { status: 0, gate: false } // network/abort: indeterminate
  } finally {
    clearTimeout(timer)
  }
}

// Entry guard: importing this module (tests) must not run the probe.
const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false
if (isMain) {
  main().catch((err) => {
    console.error(`probe failed: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
