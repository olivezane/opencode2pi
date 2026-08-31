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

**Fallback chain**:
Catalog resolution order: S1 live `GET /v1/models` ∩ free-by-metadata →
S2 offline disk cache (~7-day TTL) → S3 compile-time verified static list.
_Avoid_: tier system
