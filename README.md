<div align="center">

# opencode2pi

**Free OpenCode Zen models, natively inside [pi](https://pi.dev).**

No API key. No registration. No extra process.

[![license](https://img.shields.io/npm/l/opencode2pi)](./LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](https://nodejs.org)
[![pi](https://img.shields.io/badge/pi-package-blue)](https://pi.dev/packages)

English | [简体中文](README.zh-CN.md)

</div>

---

> **Note** — This project is ported and maintained by AI. It works for the
> maintainers' own setups, but upstream models, APIs and free-lane rules can
> change at any time — if something breaks or the model data goes stale, we
> may not get to it right away. Forking is warmly encouraged (MIT — please
> take it and make it yours); issues and PRs are very welcome too.

opencode2pi is a [pi package](https://pi.dev/packages) that registers a native
pi provider streaming directly from
[OpenCode Zen](https://opencode.ai/zen)'s **anonymous free lane** — the same
models OpenCode's own CLI uses without an account, served to your model picker
as a regular provider called `opencode2pi`.

Requests leave your machine looking exactly like traffic from the OpenCode
CLI (same user agent, same correlation headers), and the model catalog stays
fresh through a three-tier fallback chain. There is nothing to log into and
nothing to host.

## Highlights

- **Zero credential, zero setup** — the anonymous lane needs no key; install, restart, chat
- **Native provider, no sidecar** — one package, no child process, no binary, no local port
- **CLI-identical disguise** — requests carry the OpenCode CLI user agent and its session/request/project header set, derived per conversation
- **Live catalog with a fallback chain** — live upstream list ∩ free-by-metadata, falling back to offline cache and a verified static list
- **Real model metadata** — context windows, token limits, modalities and (zero) pricing come from models.dev, so pi's compaction and cost tracking are honest
- **Proper error surfaces** — upstream failures arrive as classified pi stream errors

## Install

Install with pi from this git repository (no npm package — the repo is the
release; releases are git tags):

```sh
pi install git:@github.com/olivezane/opencode2pi
```

To try it without installing:

```sh
pi -e git:@github.com/olivezane/opencode2pi
```

**Verify**: start `pi`, open the model picker (`/model`), and pick a model
from the **OpenCode Zen (free)** group.

Requires pi; Node.js ≥ 20 (already present if pi runs); outbound HTTPS to
`opencode.ai` and `models.dev`.

Update with `pi update --extensions`.

## Configuration

None. There are no options, no environment variables, no settings keys —
defaults work out of the box. The provider id is `opencode2pi`, the catalog
refreshes every 300 s, and that is all you can change anyway without editing
`src/`.

State lives in `~/.opencode2pi/`:

| File | Purpose |
| --- | --- |
| `models-dev-cache.json` | models.dev metadata cache (~7-day TTL) for the fallback chain |
| `adapter-status.json` | Health snapshot written after every refresh round |

## How it works

```
pi session
   │  pi-ai Context (native, no conversion)
   ▼
pi extension (src/index.ts) — registers provider "opencode2pi"
   │  pi-ai openai-completions stream
   │  + CLI-identical headers:
   │    user-agent: opencode/…
   │    x-opencode-client, x-opencode-session, x-session-affinity,
   │    X-Session-Id, x-opencode-request, x-opencode-project
   ▼
https://opencode.ai/zen/v1        ← Authorization: Bearer public
```

- **Session correlation** — session/project ids are SHA-256 derived from the
  conversation's first user turn (stable per conversation, non-reversible),
  and each request gets a fresh random id, mirroring the CLI.
- **Registration model** ([ADR 0001](docs/adr/0001-static-list-at-startup-background-catalog-refresh.md))
  — the extension registers the verified static list immediately, so the
  picker is never empty and startup never blocks on the network; the live
  catalog refreshes in the background and replaces the model list in place.
- **Catalog fallback chain** — S1: live `GET /v1/models`; S2: models.dev
  pricing metadata decides "free"; S3: a compile-time verified static list.
  A disk cache (~7-day TTL) covers upstream outages.
- **Model metadata** — context window, max output, reasoning, image input and
  pricing are parsed from the same models.dev payload used for the free
  decision; models without metadata keep conservative defaults.

## Health & troubleshooting

`~/.opencode2pi/adapter-status.json` is rewritten after every refresh round:

```json
{
  "status": "ready",
  "total": 63,
  "exposed": 8,
  "lastError": "",
  "writtenAt": "2026-08-31T15:26:58.409Z"
}
```

| Symptom | Likely cause & fix |
| --- | --- |
| Only 3 models | Startup fetch raced your network; retries land within ~1 min. Check `adapter-status.json` for `lastError`. |
| The list looks short | The anonymous lane only serves the free subset (paid models answer 401) — that is the whole catalog, not a bug. Ids the lane fails on are banned via the probe ledger (`staticUnavailable` in `src/catalog.ts`). |
| `lastError: "fetch failed"` persisting | Outbound HTTPS to `opencode.ai` blocked; check proxy/VPN rules. |
| Rate-limit errors in chat | The anonymous lane is quota-per-IP; switch network node or wait. |

## Security

- No secrets involved: the anonymous lane's key is the literal string `public`; nothing is stored, nothing telemetry.
- All requests go directly from your machine to `opencode.ai` / `models.dev`.
- Review the source before installing — pi packages run with full system access.

## Development

```sh
git clone https://github.com/olivezane/opencode2pi.git
cd opencode2pi
npm install
npm run typecheck && npm test
```

There is no build step: pi loads the TypeScript extension directly. The
fallback-chain logic (`src/catalog.ts`) and id derivation (`src/ids.ts`) are
unit-tested; the extension entry is verified by smoke-testing `pi -e .`.

The free-model ledger (`src/free-models.json`) is refreshed daily by
`.github/workflows/probe-models.yml`; run `node scripts/probe-models.mjs`
locally to re-probe the anonymous lane on demand.

Architecture decisions live in `docs/adr/`; project vocabulary in
`CONTEXT.md`.

## Acknowledgments

- [**opencode2dsh**](https://github.com/FishBottle7/opencode2dsh) by
  [@FishBottle7](https://github.com/FishBottle7) — this project is a fork of
  it, re-targeted from the DeepSeek Harness (DSH) plugin API to pi. The
  catalog fallback chain, the CLI disguise details and the verified static
  model list are inherited from that codebase.
- [**opencode2api**](https://github.com/jasonxu114514/opencode2api) by
  [@jasonxu114514](https://github.com/jasonxu114514) — the original
  anonymous-lane implementation the whole family derives from.
- [OpenCode](https://opencode.ai) — for running the free anonymous Zen lane.
- [@earendil-works/pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai) — the wire layer.

## License

[MIT](./LICENSE) © FishBottle7
