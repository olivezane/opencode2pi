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

opencode2pi 是一个 [pi package](https://pi.dev/packages)，它注册一个原生 pi
provider，直连 [OpenCode Zen](https://opencode.ai/zen) 的**匿名免费通道**——
与 OpenCode 官方 CLI 免登录使用的同一批模型，在你的模型选择器里以
`opencode2pi` 这个普通 provider 出现。

请求离开你的机器时与 OpenCode CLI 的流量别无二致（相同的 user agent、相同的
关联头），模型目录通过三级 fallback 链保持新鲜。无需登录任何东西，也无需
托管任何东西。

## 特性

- **零凭据、零配置**——匿名通道无需 key；装好、重启、开聊
- **原生 provider，无 sidecar**——单包搞定，无子进程、无二进制、无本地端口
- **CLI 同源伪装**——请求携带 OpenCode CLI 的 user agent 与 session/request/project 关联头，按会话派生
- **实时目录 + fallback 链**——上游实时列表 ∩ 元数据免费判定，退化为离线缓存与已验证静态清单
- **真实模型元数据**——上下文窗口、输出上限、模态与（为零的）价格来自 models.dev，pi 的 compaction 与费用统计因而是准的
- **规范的错误面**——上游故障以分类后的 pi 流错误呈现

## 安装

通过 pi 从本 git 仓库安装（不发布 npm 包——仓库即发布物，版本即 git tag）：

```sh
pi install git:github.com/olivezane/opencode2pi
```

免安装试用：

```sh
pi -e git:github.com/olivezane/opencode2pi
```

**验证**：启动 `pi`，打开模型选择器（`/model`），从 **OpenCode Zen (free)**
分组里挑一个模型。

依赖 pi；Node.js ≥ 20（pi 能跑就一定有）；到 `opencode.ai` 与 `models.dev`
的出站 HTTPS。

升级用 `pi update --extensions`。

## 配置

没有配置。没有选项、没有环境变量、没有设置键——默认即开即用。provider id
是 `opencode2pi`，目录每 300 秒刷新一次，不改 `src/` 你也就只能这样。

状态数据在 `~/.opencode2pi/`：

| 文件 | 用途 |
| --- | --- |
| `models-dev-cache.json` | models.dev 元数据缓存（约 7 天 TTL），供 fallback 链使用 |
| `adapter-status.json` | 每轮刷新后写入的健康快照 |

## 工作原理

```
pi 会话
   │  pi-ai Context（原生，无转换）
   ▼
pi 扩展 (src/index.ts) —— 注册 provider "opencode2pi"
   │  pi-ai openai-completions 流
   │  + CLI 同源请求头：
   │    user-agent: opencode/…
   │    x-opencode-client, x-opencode-session, x-session-affinity,
   │    X-Session-Id, x-opencode-request, x-opencode-project
   ▼
https://opencode.ai/zen/v1        ← Authorization: Bearer public
```

- **会话关联**——session/project id 由会话首条用户消息 SHA-256 派生（会话内
  稳定、不可逆），每个请求另带新鲜随机 id，与 CLI 行为一致。
- **注册模型**（[ADR 0001](docs/adr/0001-static-list-at-startup-background-catalog-refresh.md)）
  ——扩展先注册已验证的静态清单，选择器永不空、启动永不因网络阻塞；实时目录
  后台刷新并原地替换模型列表。
- **目录 fallback 链**——S1：实时 `GET /v1/models`；S2：models.dev 价格元数据
  判定"免费"；S3：编译期验证过的静态清单。磁盘缓存（约 7 天 TTL）兜底上游故障。
- **模型元数据**——上下文窗口、输出上限、reasoning、图片输入与价格从同一份
  models.dev payload 解析（免费判定也用它）；无元数据的模型保持保守默认值。

## 健康与排障

`~/.opencode2pi/adapter-status.json` 每轮刷新后重写：

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
| `lastError: "fetch failed"` 持续 | 到 `opencode.ai` 的出站 HTTPS 被阻断；检查代理/VPN 规则。 |
| 聊天中报限流错误 | 匿名通道按 IP 限额；换网络节点或稍等。 |

## 安全

- 不涉及任何秘密：匿名通道的 key 就是字面量 `public`；不存储、不上报遥测。
- 所有请求从你的机器直达 `opencode.ai` / `models.dev`。
- 安装前请审查源码——pi 包以完整系统权限运行。

## 开发

```sh
git clone https://github.com/olivezane/opencode2pi.git
cd opencode2pi
npm install
npm run typecheck && npm test
```

没有构建步骤：pi 直接加载 TypeScript 扩展。fallback 链逻辑（`src/catalog.ts`）
与 id 派生（`src/ids.ts`）有单元测试；扩展入口用 `pi -e .` 冒烟验证。

架构决策在 `docs/adr/`；项目术语表在 `CONTEXT.md`。

## 致谢

- [**opencode2dsh**](https://github.com/FishBottle7/opencode2dsh) by
  [@FishBottle7](https://github.com/FishBottle7)——本项目 fork 自它，从
  DeepSeek Harness (DSH) 插件 API 改造为 pi。目录 fallback 链、CLI 伪装细节
  与已验证静态模型清单均继承自该项目。
- [**opencode2api**](https://github.com/jasonxu114514/opencode2api) by
  [@jasonxu114514](https://github.com/jasonxu114514)——整个家族的匿名通道
  实现源头。
- [OpenCode](https://opencode.ai)——运营免费的匿名 Zen 通道。
- [@earendil-works/pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai)——底层线材。

## 许可证

[MIT](./LICENSE) © FishBottle7
