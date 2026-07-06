# 供应商 Key 上渠道系统

本地/自托管 Next.js 14 全栈应用：**访问密钥登录 + 双角色**，管理员配置用户与其绑定渠道，用户上传 Anthropic Claude API Key，后端**登录 naci 平台（session）**自动创建/追加聚合渠道、发布并重开各站点。

> 权威设计见 [`docs/DESIGN.md`](docs/DESIGN.md)。`docs/architecture.md`、`docs/naci-channel-api.md` 为已废弃的历史资料。

## 快速开始

```bash
docker compose up -d --build      # app + postgres，无需 .env
# 访问 http://localhost:3010
```

**不依赖任何 `.env` 文件**：所有运行配置直接写在 `docker-compose.yml`（DATABASE_URL、库密码仅用于内部网络、不暴露宿主）。

首次启动自动建表并 seed 一个管理员，**密钥随机生成并打印到容器日志**（`docker compose logs keyload | grep seed` → `[seed] 生成默认管理员密钥: …`），用它登录。

**naci 账号密码**：登录后进「配置」页填 naci 用户名+密码，保存到数据库（`config` 表）。之后后端用它登录 naci 维护 session。所有敏感值（管理员密钥、naci 账号密码）均在**数据库**里管理，代码与仓库不留明文。

## 两套鉴权

| 层 | 方式 |
| --- | --- |
| 浏览器 ↔ 本系统 | 访问密钥 `x-access-key`（每用户一把 `uk-…`） |
| 本系统 ↔ naci 平台 | naci 账号密码登录 → session cookie（存 DB，失效自动重登） |

## 角色与流程

- **管理员**：配置 naci 账号密码（`/api/admin/config`）；管理用户（增删改、分发访问密钥、代传 key、查看每个用户渠道状态）；每用户绑定一个**唯一渠道名**。
- **普通用户**：查看「我的渠道」（是否创建、状态、平台 key 数、禁用 key 数、各站点用量）；粘贴 key 上传（首次自动创建聚合渠道并发布三站，之后追加并重开站点）。

## 技术栈

- Next.js 14（App Router，standalone 输出）+ TypeScript + Tailwind
- PostgreSQL（node-postgres）持久化
- naci admin-hub 端点 + session 鉴权（见 DESIGN §3）
- Docker Compose 部署（app + postgres），Caddy 反代 HTTPS

## 目录

```
app/            页面 + api/*（me/ping/admin/*/my/* 等）
components/     KeyGate/AdminPanel/UserPanel/ChannelStatusView/…
lib/            naci(session+admin-hub) / store(PG) / channelService / auth / supplier / types / client
docs/DESIGN.md  权威设计
```

## 安全

- 仓库不留任何真实密钥/密码/token；`.env` 与 `docs/*.txt` 均 gitignore，且 `.env` 不进镜像层。
- naci 密码/token 不回传前端明文（仅回「是否已设置」）。
