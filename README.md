<div align="center">

# opencode2pi

**OpenCode Zen free models, natively in [pi](https://pi.dev).**

No API key. No signup. No sidecar.

[![license](https://img.shields.io/npm/l/opencode2pi)](./LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](https://nodejs.org)
[![pi](https://img.shields.io/badge/pi-package-blue)](https://pi.dev/packages)

English | [简体中文](README.zh-CN.md)

</div>

---

> **Note** — AI-ported and AI-maintained. Works on maintainers' setups only.
> Upstream models, APIs, free-lane rules change anytime. Breakage may sit
> unfixed. Fork warmly encouraged (MIT — take it). Issues/PRs welcome.

[pi package](https://pi.dev/packages) registering native pi provider streaming
from [OpenCode Zen](https://opencode.ai/zen)'s **anonymous free lane** — same
models the OpenCode CLI uses, no account, exposed to the model picker as
provider `opencode2pi`.

Traffic leaves the machine looking exactly like OpenCode CLI traffic (same user
agent, same correlation headers). Catalog stays fresh via 3-tier fallback.
Nothing to log into, nothing to host.

## Highlights

- **Zero credential, zero setup** — install, restart, chat
- **Native provider, no sidecar** — no child process, no binary, no local port
- **CLI-identical disguise** — CLI user agent + session/request/project headers, per conversation
- **Live catalog + fallback chain** — live upstream ∩ free-by-metadata → disk cache → verified static list
- **Real metadata** — context windows, token limits, modalities, (zero) pricing from models.dev; honest compaction + cost tracking
- **Proper errors** — upstream failures surface as classified pi stream errors
- **Classifier included** — Zen free classifier (`jev-1.13-free`) registered as pi classifier model; `models.classify()` works

## Install

Repo is the release (git tags, no npm package).

```sh
pi install git:@github.com/olivezane/opencode2pi
```

Try without installing:

```sh
pi -e git:@github.com/olivezane/opencode2pi
```

**Verify** — start `pi`, `/model`, pick from **OpenCode Zen (free)** group.

Needs: pi; Node ≥ 20; outbound HTTPS to `opencode.ai` + `models.dev`.

Update: `pi update --extensions`.

## Configuration

None. No options, no env vars, no settings keys. Defaults work. Provider id
`opencode2pi`, catalog refresh every 300 s.

State in `~/.opencode2pi/`:

| File | Purpose |
| --- | --- |
| `models-dev-cache.json` | models.dev metadata cache (~7-day TTL) for fallback chain |
| `opencode2pi.log` | Extension log (refresh failures, stream errors); truncated at 2 MB |
| `adapter-status.json` | Health snapshot, written after every refresh round |

## How it works

```
pi session
   │  pi-ai Context (native, no conversion)
   ▼
pi extension (src/index.ts) — registers provider "opencode2pi"
   │  pi-ai openai-completions stream
   │  + CLI-identical headers (applied after pi's own):
   │    user-agent: opencode/latest/<ver>/cli
   │    x-opencode-client, x-opencode-session, x-opencode-session-id,
   │    x-session-affinity, X-Session-Id, x-opencode-project
   ▼
https://opencode.ai/inference/v1   ← Authorization: Bearer public
```

- **Session correlation** — session must be canonical OpenCode shape (`ses_` +
  12 hex + 14 Base62); the 12 hex decode as CLI descending-ms timestamp. pi
  session hashed deterministically into that shape → one pi session, one
  upstream session. Project ids SHA-256 derived same way. pi attribution
  headers overridden. `x-opencode-request` and canonical `prj_*` project ids
  both answer `403 FreeTierError` → neither sent.
- **Agent shape** — body must request streaming and carry tool `read` with a
  real schema. Since 2026-10-14 free tier compares every recognised tool
  against official CLI definition: synthesized stub (empty `properties`) under
  a recognised name — `bash` included — poisons the request. Recognised names
  get genuine definitions; unknown names left as pi declared them.
- **Registration model** ([ADR 0001](docs/adr/0001-static-list-at-startup-background-catalog-refresh.md))
  — verified static list registered immediately: picker never empty, startup
  never blocks on network. Live catalog refreshes in background, replaces list
  in place.
- **Catalog fallback chain** — S1 live `GET /v1/models`; S2 models.dev pricing
  metadata decides "free"; S3 compile-time verified static list. Disk cache
  (~7-day TTL) covers outages.
- **Model metadata** — limits/reasoning/image input from OpenCode capability
  catalog → models.dev payload → conservative defaults. Pricing always from
  models.dev (zero here).
- **Classification** — classifier lane speaks TypeSafe System One at
  `/inference/v1/systemone`; free classifier registered as pi classifier model
  (not chat — picker hides it), reachable via `models.classify()`.

## Health & troubleshooting

`~/.opencode2pi/adapter-status.json` rewritten every refresh round. Diagnostics
→ `~/.opencode2pi/opencode2pi.log`, plus stderr in non-interactive modes
(print/JSON/RPC). Interactive TUI never sees stderr — a stray write scribbles
mid-frame.

```json
{
  "status": "ready",
  "total": 63,
  "exposed": 8,
  "lastError": "",
  "writtenAt": "2026-08-31T15:26:58.409Z"
}
```

| Symptom | Cause & fix |
| --- | --- |
| Only 3 models | Startup fetch raced network; retries land within ~1 min. Check `lastError`. |
| List looks short | Anonymous lane serves free subset only (paid → 401). That is the whole catalog. Failed ids banned via probe ledger (`staticUnavailable` in `src/catalog.ts`). |
| `lastError: "fetch failed"` persists | Outbound HTTPS to `opencode.ai` blocked; check proxy/VPN. Full sequence in `opencode2pi.log`. |
| Rate-limit errors | Anonymous lane is quota-per-IP; switch node or wait. |
| `403 FreeTierError` ("free tier can only be used from within OpenCode") | Request did not look like CLI traffic: host moved (use `https://opencode.ai/inference`), session hex not descending timestamp, `x-opencode-request` sent, `x-opencode-project` canonical `prj_*`, or recognised tool (`read`, `glob`, `bash`, …) with empty schema. Update package; if persists, another extension is stamping provider headers. |

## Security

- No secrets: anonymous lane key is the literal string `public`. Nothing stored, no telemetry.
- All requests machine → `opencode.ai` / `models.dev`.
- Review source before installing — pi packages run with full system access.

## Development

```sh
git clone https://github.com/olivezane/opencode2pi.git
cd opencode2pi
npm install
npm run typecheck && npm test
```

No build step: pi loads the TypeScript extension directly. Fallback chain
(`src/catalog.ts`) and id derivation (`src/ids.ts`) unit-tested; entry verified
by smoke-testing `pi -e .`.

Free-model ledger (`src/free-models.json`) refreshed twice daily (00:00/12:00
UTC) by `.github/workflows/probe-models.yml`; re-probe on demand with
`node scripts/probe-models.mjs`.

ADRs in `docs/adr/`; vocabulary in `CONTEXT.md`.

## Acknowledgments

- [**opencode2dsh**](https://github.com/FishBottle7/opencode2dsh) by [@FishBottle7](https://github.com/FishBottle7) — fork source, re-targeted from DSH plugin API to pi. Fallback chain, CLI disguise details, verified static list inherited.
- [**opencode2api**](https://github.com/jasonxu114514/opencode2api) by [@jasonxu114514](https://github.com/jasonxu114514) — original anonymous-lane implementation.
- [OpenCode](https://opencode.ai) — for running the free anonymous Zen lane.
- [@earendil-works/pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai) — wire layer.

## License

[MIT](./LICENSE) © FishBottle7
