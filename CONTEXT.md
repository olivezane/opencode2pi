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
OpenCode Zen (`https://opencode.ai/inference`) — the host serving OpenCode's
models. It moved off `https://opencode.ai/zen` in 2026-10-14, and the old host
now answers `403 FreeTierError` for the anonymous lane.
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

**Derived session ID**:
SHA-256 values computed from the conversation, stable per pi session or per
conversation, mirroring CLI behavior; the project id is derived the same way
but never changes. Non-reversible. Colloquially "the ids".
_Avoid_: fake session id

**Agent shape**:
The request body the free tier accepts since 2026-10-14: streaming enabled
(`stream: true`, plus `stream_options.include_usage` on chat) and a tool named
`read` carrying a real parameter schema. The definitions are what count now:
upstream compares every tool whose name it recognises against the official
CLI's own definition, so a synthesized stand-in — an empty `properties`, as
this package emitted until 2026-10-15 — is answered with the same
`403 FreeTierError` as a bad session. The CLI's shell tool is named `shell`,
not `bash`. Names upstream does not recognise are never checked.
_Avoid_: agent request, CLI shape

**Genuine CLI tool definitions**:
The `description` + `parameters` pairs the official OpenCode CLI declares for
the tools it knows (`shell`, `edit`, `glob`, `grep`, `question`, `read`,
`skill`, `subagent`, `webfetch`, `websearch`, `execute`, `write`), vendored in
`src/opencode-tools.ts`. A recognised name in the outgoing body is rewritten to
its genuine definition; `bash` is served the genuine `shell` definition under
its own name, because a caller that declared `bash` needs that name back.
_Avoid_: tool stubs, tool templates

**Canonical session**:
The session shape the free tier accepts since 2026-10-14: `ses_` + 12 lowercase
hex characters + 14 Base62 characters, where the 12 hex characters decode as
the CLI's descending millisecond timestamp (`~(ms << 12 | counter)`, counter
1..63, so they always end in `ffc0`..`ffff`). A signal that already carries a
genuine session passes through untouched (it keeps upstream prompt-cache
affinity); anything else — a pi session id, a UUID, a conversation seed — is
hashed into that shape deterministically. A shape-correct id whose time part
is not a descending timestamp is answered with `403 FreeTierError`("free tier
can only be used from within OpenCode"), which is why the raw-SHA-256 time
part this package emitted until 2026-10-15 failed every request.
_Avoid_: valid session, session format

**Session signal**:
What the session is derived from, in priority order: a declared session
(`metadata.session_id` / `metadata.conversation_id`, then pi's `sessionId`),
then the conversation's first user turn, then a random fallback. The declared
signal wins because it is the closest equivalent of the CLI's own session.
_Avoid_: session seed

**Catalog**:
The set of models this package exposes in pi's model picker. Decided by the
fallback chain below; lives in `ModelCatalog`. Classifier models ride along in
the same id list (see **Classifier lane**), but they are not chat models, so
they never reach the picker.
_Avoid_: model list (except for the raw `/v1/models` response)

**Classifier lane**:
Zen's second lane: classification models (`jev-1.13`, `jev-1.13-free`) served
over TypeSafe's System One protocol at `/inference/v1/systemone` — not chat
completions. They are also a second pi *model type* (`type: "classifier"`), so
they are registered as classifiers and never as chat models, reachable only
through pi's classifier API (`models.classify`, codemode) — the picker never
shows them. The wire implementation is pi's builtin `opencode` classifier,
borrowed through `providers/all` rather than reimplemented: pi's extension
loader does not alias `api/*` subpaths, so the System One factory is not
importable from a published package. Requests need no disguise headers (the
lane answers a bare `Bearer public` request), and the runtime cooldown hides
the classifier on a hard 400/401/403 like any other model.
_Avoid_: jev support, classifier model type

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
10-minute window; flaky statuses (429/5xx/timeout) never hide — 429 is the
lane's per-IP daily quota, so hiding a model for it would hide every model.
pi-ai's own retry is what handles 429, and a `retry-after` beyond
`maxRetryDelayMs` (30s; the lane sends ~15h) becomes a terminal error
otherwise. 403 belongs to the hard set because nothing
else owns it: pi-ai retries only 408/409/429/5xx, so a `FreeTierError` would
otherwise reach the user on every request instead of hiding the model. The
next successful reply clears the cooldown. Reacts within the session, unlike
the probe ledger.
_Avoid_: runtime ban, blacklist

**Fallback chain**:
Catalog resolution order: S1 live `GET /v1/models` → S2 models.dev pricing metadata → free decision (a disk cache, ~7-day TTL, stands in for S2 while models.dev is unreachable) → S3 compile-time verified static list. S3 is what the picker gets at startup; S1 ∩ S2 replaces it in place once the background refresh lands.
_Avoid_: tier system

**Probe ledger** (`src/free-models.json`):
The single machine-maintained data file holding the two static id lists — `verified` (ids the anonymous lane answered 200 or 429 in a real probe, with date) and `unavailable` (ids that hard-failed 400/401/410 on two different probe days, with first-failure date). Consumed by the fallback chain (S3) and the picker exclusion. The ledger describes exactly what `/v1/models` lists: only listed ids are probed, and an id the lane drops leaves the ledger on the next run. The list over-reports (names with no service behind them), but it never under-reports. Each candidate is probed on its native protocol (chat/responses/anthropic), so a model is only "verified" if its own interface actually answers; candidates with unknown SDKs are skipped (no known endpoint), and if the capability catalog is unreachable the probe degrades to probing every listed candidate rather than rewriting from an incomplete picture. Classifier ids carry no capability-catalog protocol, so they are probed on chat and, when that answers 400 (no such model on this endpoint), again on `/v1/systemone` — 400 is the only status that means "wrong endpoint", so the retry cannot mask a broken chat model (see **Classifier lane**).
_Avoid_: ban list, blacklist

**Verified / banned**:
A model is *verified* when a probe on its native protocol returns 200 — it may be exposed. 429 verifies identically: it comes back only after the model-exists-and-is-free check passes, so it proves the id is served and free while saying nothing about the egress IP's quota, and a blocked IP lasts long enough that treating 429 as indeterminate would freeze a ban forever (2026-10-24: three CI runs in a row recorded zero 200s and the ledger stopped meaning anything). A model is *banned* after two consecutive probe days of hard failures (400/401/410 only); flaky probes (timeout, 5xx) never ban and never clear a ban, and recovery moves an id back to verified at the next run. Every candidate is probed on every run: `/v1/models` names ids with no service behind them, so a 429 on one id says nothing about the next.
_Avoid_: blocked (reserved: upstream 401s on paid models are not "banned", they are not free)

**Free-set rotation**:
OpenCode rotates the anonymous lane's free set on a day scale; the probe ledger refreshes twice daily via `.github/workflows/probe-models.yml` (00:00/12:00 UTC). The S3 static list is a snapshot of that ledger taken at build time, so the live S1/S2 view is what keeps the picker aligned with what the lane actually serves.
_Avoid_: model churn
