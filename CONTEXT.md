# opencode2pi

Free OpenCode Zen models, natively inside pi. A pi package that registers the
Zen anonymous lane as a first-class provider — no API key, no registration,
no extra process.

## Language

**opencode2pi**:
This project. The pi package, its npm name, its provider ID, and its data
directory (`~/.opencode2pi/`) all share this one name.
_Avoid_: opencode2dsh, dsh-plugin

**Zen**:
OpenCode Zen (`https://opencode.ai/zen`) — OpenCode's model-serving endpoint.
_Avoid_: upstream, opencode API

**Anonymous lane**:
Zen's keyless free access path, authenticated with the literal string `public`.
_Avoid_: free tier, public mode

**Disguise headers**:
The per-request header set (`user-agent`, `x-opencode-*`, session affinity)
that makes requests look like native OpenCode CLI traffic.
_Avoid_: fake headers, spoofing

**Derived session ID / derived request ID**:
SHA-256 values computed from the conversation's first user turn (session,
stable per conversation) and per request (random-ish), mirroring CLI behavior.
Non-reversible. Colloquially "the ids".
_Avoid_: fake session id

**Catalog**:
The set of models this package exposes in pi's model picker. Decided by the
fallback chain below; lives in `ModelCatalog`.
_Avoid_: model list (except for the raw `/v1/models` response)

**Capability catalog**:
`https://models.opencode.ai/api.json` — OpenCode's machine-readable provider
catalog. Each model's npm SDK choice declares its native upstream protocol
(openai-compatible → chat, @ai-sdk/openai → responses, @ai-sdk/anthropic →
messages). pi only speaks openai-completions, so responses/anthropic-native
models are never exposed; unknown SDKs are marked unsupported. Refreshes on
the same 24h cadence as models.dev; while unavailable the catalog degrades
to no-filter (today's behavior) rather than hiding models on a guess.
_Avoid_: protocol list, native protocol (reserved context)

**Runtime cooldown**:
Per-session model feedback from real requests (pool.go pattern compressed to
one model): a hard 400/401 hides the model from the picker for an escalating
exponential window (base 10 min, ×8 cap); flaky statuses (429/5xx/timeout)
never hide — they are pi-ai's retry domain (maxRetries). The next successful
reply clears the cooldown. Reacts within the session, unlike the daily probe
ledger.
_Avoid_: runtime ban, blacklist

**Fallback chain**:
Catalog resolution order: S1 live `GET /v1/models` → S2 offline disk cache (~7-day TTL) → S3 compile-time verified static list. Currently two tiers: live-data + the probe ledger below.
_Avoid_: tier system

**Probe ledger** (`src/free-models.json`):
The single machine-maintained data file holding the two static id lists — `verified` (ids the anonymous lane answered 200 in a real probe, with date) and `unavailable` (ids that hard-failed 400/401 on two different probe days, with first-failure date). Consumed by the fallback chain (S3) and the picker exclusion.
_Avoid_: ban list, blacklist

**Verified / banned**:
A model is *verified* when a probe chat returns 200 — it may be exposed. A model is *banned* after two consecutive daily hard failures (400/401 only); flaky probes (timeout, 429, 5xx) never ban, and recovery moves an id back to verified at the next run.
_Avoid_: blocked (reserved: upstream 401s on paid models are not "banned", they are not free)

**Free-set rotation**:
OpenCode rotates the anonymous lane's free set on a day scale; the probe ledger refreshes twice daily via `.github/workflows/probe-models.yml` (00:00/12:00 UTC), keeping the picker aligned with what the lane actually serves.
_Avoid_: model churn
