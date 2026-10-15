<div align="center">

# opencode2pi

**在 [pi](https://pi.dev) 里原生使用 OpenCode Zen 免费模型。**

无需 API key。无需注册。无需额外进程。

[![license](https://img.shields.io/npm/l/opencode2pi)](./LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](https://nodejs.org)
[![pi](https://img.shields.io/badge/pi-package-blue)](https://pi.dev/packages)

[English](README.md) | 简体中文

</div>

---

> **注意** —— AI 移植、AI 维护。仅在维护者环境验证。上游模型、API、免费通道
> 规则随时可变；出问题未必第一时间处理。欢迎自行 fork（MIT，随意拿去改）；
> issue 与 PR 同样欢迎。

[pi package](https://pi.dev/packages)，注册原生 pi provider，直连
[OpenCode Zen](https://opencode.ai/zen) **匿名免费通道**——与 OpenCode 官方
CLI 免登录同批模型，在选择器里以 provider `opencode2pi` 出现。

请求出机器时与 OpenCode CLI 流量别无二致（相同 user agent、相同关联头）。
目录靠三级 fallback 链保鲜。无需登录，无需托管。

## 特性

- **零凭据、零配置**——装好、重启、开聊
- **原生 provider，无 sidecar**——无子进程、无二进制、无本地端口
- **CLI 同源伪装**——CLI user agent + session/request/project 关联头，按会话派生
- **实时目录 + fallback 链**——上游实时列表 ∩ 元数据免费判定 → 离线缓存 → 已验证静态清单
- **真实模型元数据**——上下文窗口、输出上限、模态、零价格来自 models.dev；compaction 与费用统计因而是准的
- **规范错误面**——上游故障以分类后的 pi 流错误呈现
- **分类器支持**——Zen 免费分类器（`jev-1.13-free`）注册为 pi 分类器模型，`models.classify()` 在匿名通道可用

## 安装

仓库即发布物，版本即 git tag，不发 npm 包。

```sh
pi install git:@github.com/olivezane/opencode2pi
```

免安装试用：

```sh
pi -e git:@github.com/olivezane/opencode2pi
```

**验证**——启动 `pi`，`/model`，从 **OpenCode Zen (free)** 分组挑一个。

依赖：pi；Node.js ≥ 20；到 `opencode.ai` 与 `models.dev` 的出站 HTTPS。

升级：`pi update --extensions`。

## 配置

没有配置。无选项、无环境变量、无设置键，默认即用。provider id `opencode2pi`，
目录每 300 秒刷新。

状态数据在 `~/.opencode2pi/`：

| 文件 | 用途 |
| --- | --- |
| `models-dev-cache.json` | models.dev 元数据缓存（约 7 天 TTL），供 fallback 链使用 |
| `adapter-status.json` | 每轮刷新后写入的健康快照 |
| `opencode2pi.log` | 扩展日志（刷新失败、stream observer 报错）；超过 2 MB 清空 |

## 工作原理

```
pi 会话
   │  pi-ai Context（原生，无转换）
   ▼
pi 扩展 (src/index.ts) —— 注册 provider "opencode2pi"
   │  pi-ai openai-completions 流
   │  + CLI 同源请求头（在 pi 自带归属头之后覆盖）：
   │    user-agent: opencode/…
   │    x-opencode-client, x-opencode-session, x-opencode-session-id,
   │    x-session-affinity, X-Session-Id, x-opencode-project
   ▼
https://opencode.ai/inference/v1   ← Authorization: Bearer public
```

- **会话关联**——session 采免费层要求的规范形状（`ses_` + 12 hex + 14 Base62）；
  pi 声明的 session 确定性哈希成该形状，一个 pi 会话对应一个上游会话。project id
  同样 SHA-256 派生，并覆盖 pi 自加的归属请求头。
- **注册模型**（[ADR 0001](docs/adr/0001-static-list-at-startup-background-catalog-refresh.md)）
  ——先注册已验证静态清单：选择器永不空，启动不因网络阻塞。实时目录后台刷新，
  原地替换模型列表。
- **目录 fallback 链**——S1 实时 `GET /v1/models`；S2 models.dev 价格元数据判定
  “免费”；S3 编译期验证过的静态清单。磁盘缓存（约 7 天 TTL）兜底上游故障。
- **模型元数据**——上下文窗口、输出上限、reasoning、图片输入取自 OpenCode
  capability catalog（与协议同源）→ 用于免费判定的 models.dev payload → 保守默认值。
  价格始终来自 models.dev（此处为 0）。
- **分类器**——分类通道走 TypeSafe System One 协议（`/inference/v1/systemone`）；免费
  分类器注册为 pi 分类器模型（非 chat，选择器不显示），经 `models.classify()` 调用。

## 健康与排障

`~/.opencode2pi/adapter-status.json` 每轮刷新后重写。诊断写入
`~/.opencode2pi/opencode2pi.log`，非交互模式（print、JSON、RPC）同时回显 stderr；
交互式 TUI 不写 stderr——写会落在渲染帧中间，把画面弄花：

```json
{
  "status": "ready",
  "total": 63,
  "exposed": 8,
  "lastError": "",
  "writtenAt": "2026-08-31T15:26:58.409Z"
}
```

| 症状 | 可能原因与处理 |
| --- | --- |
| 只有 3 个模型 | 启动拉取撞上网络未就绪；重试约 1 分钟内落地。看 `adapter-status.json` 的 `lastError`。 |
| 列表看起来很短 | 匿名通道只服务免费子集（付费一律 401）——这就是全部目录，不是 bug。带不动的 id 经探针台账（`src/catalog.ts` 的 `staticUnavailable`）禁用。 |
| `lastError: "fetch failed"` 持续 | 到 `opencode.ai` 的出站 HTTPS 被阻断；检查代理/VPN 规则。完整序列见 `opencode2pi.log`。 |
| 聊天中报限流错误 | 匿名通道按 IP 限额；换网络节点或稍等。 |
| `403 FreeTierError`（“free tier can only be used from within OpenCode”） | 请求不像 CLI 流量：host 换了（用 `https://opencode.ai/inference`）；session 的 12 位 hex 不是 CLI 的递减时间戳；发过 `x-opencode-request`；`x-opencode-project` 带了规范的 `prj_*` id；或已识别工具（`read`、`glob`、`bash`……）的 schema 为空。先更新本包；仍复现则是有别的扩展在改写 provider 请求头。 |

## 安全

- 无秘密：匿名通道的 key 就是字面量 `public`；不存储、不上报遥测。
- 所有请求从本机直达 `opencode.ai` / `models.dev`。
- 安装前审查源码——pi 包以完整系统权限运行。

## 开发

```sh
git clone https://github.com/olivezane/opencode2pi.git
cd opencode2pi
npm install
npm run typecheck && npm test
```

无构建步骤：pi 直接加载 TypeScript 扩展。fallback 链（`src/catalog.ts`）与 id
派生（`src/ids.ts`）有单元测试；入口用 `pi -e .` 冒烟验证。

免费模型台账（`src/free-models.json`）由 `.github/workflows/probe-models.yml`
每日两次刷新（00:00/12:00 UTC）；手动重探跑 `node scripts/probe-models.mjs`。

架构决策在 `docs/adr/`；术语表在 `CONTEXT.md`。

## 致谢

- [**opencode2dsh**](https://github.com/FishBottle7/opencode2dsh) by [@FishBottle7](https://github.com/FishBottle7)——fork 源，从 DSH 插件 API 改造为 pi。fallback 链、CLI 伪装细节、已验证静态清单继承自它。
- [**opencode2api**](https://github.com/jasonxu114514/opencode2api) by [@jasonxu114514](https://github.com/jasonxu114514)——整个家族的匿名通道实现源头。
- [OpenCode](https://opencode.ai)——运营免费的匿名 Zen 通道。
- [@earendil-works/pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai)——底层线材。

## 许可证

[MIT](./LICENSE) © FishBottle7
