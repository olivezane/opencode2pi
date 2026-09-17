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
that makes requests look like native OpenCode CLI traffic. It is applied
*last*, overriding any header pi stamped on the request — pi adds its own
attribution (`x-opencode-session: <pi session id>`, `x-opencode-client: pi`)
to every model whose provider is `opencode*` or whose baseUrl host is
`opencode.ai`, and that raw session id is exactly what the free tier rejects.
_Avoid_: fake headers, spoofing

**Derived session ID / derived request ID**:
SHA-256 values computed from the conversation (session, stable per pi session
or per conversation) and per request (random-ish), mirroring CLI behavior.
Non-reversible. Colloquially "the ids".
_Avoid_: fake session id

**Canonical session**:
The only session shape the free tier accepts since 2026-09-16:
`ses_` + 12 lowercase hex characters + 14 Base62 characters. A signal that
already carries an official OpenCode session passes through untouched (it
keeps upstream prompt-cache affinity); anything else — a pi session id, a
UUID, a conversation seed — is hashed into that shape deterministically. Any
other shape is answered with `403 FreeTierError` ("free tier can only be used
from within OpenCode").
_Avoid_: valid session, session format

**Session signal**:
What the session is derived from, in priority order: a declared session
(`metadata.session_id` / `metadata.conversation_id`, then pi's `sessionId`),
then the conversation's first user turn, then a random fallback. The declared
signal wins because it is the closest equivalent of the CLI's own session.
_Avoid_: session seed

**Catalog**:
The set of models this package exposes in pi's model picker. Decided by the
fallback chain below; lives in `ModelCatalog`.
_Avoid_: model list (except for the raw `/v1/models` response)

**Capability catalog**:
`https://models.opencode.ai/api.json` — OpenCode's machine-readable provider
catalog. Each model's npm SDK choice declares its native upstream protocol
(openai-compatible → chat, @ai-sdk/openai → responses, @ai-sdk/anthropic →
messages). Every known protocol is routeable: exposed and served through the
matching pi-ai layer (openai-completions / openai-responses /
anthropic-messages), and probed on that native endpoint. It also carries the
real per-model limits (`limit.context`/`limit.output`), reasoning flag and
input modalities, which the picker uses in preference to models.dev — the
source that declares the protocol also declares the limits, so the two can
never disagree. Unknown SDKs are marked unsupported and excluded — no endpoint
mapping exists; the endpoint documentation below may still resolve them.
Probing decides whether the lane actually serves a model; a routeable model
the lane rejects (400/401/403) is hidden by the runtime cooldown, then banned
by the probe ledger. Refreshes on the same 24h cadence as models.dev; while
unavailable the catalog degrades to no-filter (today's behavior) rather than
hiding models on a guess.
_Avoid_: protocol list, native protocol (reserved context)

**Endpoint documentation**:
OpenCode's published endpoint table (`zen.mdx`). Each row names a model and
the `/v1/...` endpoint it is served on, which is the ground truth when the
capability catalog's SDK choice is missing or too generic. Documented models
become routeable; rows whose endpoint has no pi-ai layer (the Gemini
`/v1/models/<id>` route) are ignored. Fetched alongside the capability
catalog, best effort.
_Avoid_: docs protocol, endpoint list

**Runtime cooldown**:
Per-session model feedback from real requests (pool.go pattern compressed to
one model): a hard 400/401/403 hides the model from the picker for a fixed
10-minute window; flaky statuses (429/5xx/timeout) never hide — they are
pi-ai's retry domain (maxRetries). 403 belongs to the hard set because nothing
else owns it: pi-ai retries only 408/409/429/5xx, so a `FreeTierError` would
otherwise reach the user on every request instead of hiding the model. The
next successful reply clears the cooldown. Reacts within the session, unlike
the daily probe ledger.
_Avoid_: runtime ban, blacklist

**Fallback chain**:
Catalog resolution order: S1 live `GET /v1/models` → S2 offline disk cache (~7-day TTL) → S3 compile-time verified static list. Currently two tiers: live-data + the probe ledger below.
_Avoid_: tier system

**Probe ledger** (`src/free-models.json`):
The single machine-maintained data file holding the two static id lists — `verified` (ids the anonymous lane answered 200 in a real probe, with date) and `unavailable` (ids that hard-failed 400/401 on two different probe days, with first-failure date). Consumed by the fallback chain (S3) and the picker exclusion. Each candidate is probed on its native protocol (chat/responses/anthropic), so a model is only "verified" if its own interface actually answers; candidates with unknown SDKs are skipped (no known endpoint), and if the capability catalog is unreachable the probe degrades to probing every candidate rather than rewriting from an incomplete picture.
_Avoid_: ban list, blacklist

**Verified / banned**:
A model is *verified* when a probe chat returns 200 — it may be exposed. A model is *banned* after two consecutive daily hard failures (400/401 only); flaky probes (timeout, 429, 5xx) never ban, and recovery moves an id back to verified at the next run.
_Avoid_: blocked (reserved: upstream 401s on paid models are not "banned", they are not free)

**Free-set rotation**:
OpenCode rotates the anonymous lane's free set on a day scale; the probe ledger refreshes twice daily via `.github/workflows/probe-models.yml` (00:00/12:00 UTC), keeping the picker aligned with what the lane actually serves.
_Avoid_: model churn
