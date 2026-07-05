# 供应商 Key 上渠道系统 v2

本地全栈 Next.js 14 应用：**密钥登录 + 双角色**，管理员为用户绑定渠道，用户上传 Anthropic Claude API Key，系统自动在 naci 平台（`open.naci-tech.com`）**创建或追加**对应渠道并发布到各站点。

> 设计契约与已验证的平台行为见 [`docs/DESIGN.md`](docs/DESIGN.md)。`docs/architecture.md` 是旧 v1 方案（admin-hub + cookie），已废弃。

## 快速开始

```bash
npm install
npm run dev        # http://localhost:3000
# 或
npm run build && npm start
```

首次运行自动在 `data/` 生成：
- 默认管理员（username `admin`，accessKey 由环境变量 `ADMIN_ACCESS_KEY` 注入；未配置则随机生成并打印到容器日志 `[seed] 生成默认管理员密钥: ...`）。
- naci 连接信息（`NACI_BASE_URL` + `NACI_TOKEN`）来自环境变量。

敏感值统一放在 `.env`（不入库，参考 `.env.example`）。打开页面会弹出**密钥登录框**，输入访问密钥即可（可勾选「在本机记住」，下次自动填充并跳过登录）。

## 角色与流程

- **管理员**：配置 naci 连接（Base URL / token / 测试连接）；管理用户（增删改、复制分发访问密钥）；为每个用户绑定一个**渠道名称**；可代用户上传 Key。
- **普通用户**：查看自己绑定的渠道（是否已创建、渠道 ID、模型/优先级/分组、各站点发布与用量）；粘贴 Key（每行一个）上传。

**上传逻辑**（`lib/channelService.ts`）：解析渠道 ID → 缓存 ID 先校验；否则按渠道名精确查找；仍无则按固定模板创建。有 ID 走 `PUT`（`key_mode=append` 追加），无 ID 走 `POST` 创建。创建/更新均自动发布到供应商站点（6 AC / 13 AGT / 21 61）。

## 鉴权

所有 API 请求头带 `x-access-key: <accessKey>`（兼容 `Authorization: Bearer`）。后端按密钥匹配用户与角色：管理员接口要求 admin，用户接口只能操作自己的数据，越权返回 403，无/错密钥返回 401。

## 固定渠道参数（Anthropic Claude）

`type=14` · `platform_channel_type=anthropic_claude` · `model_series=anthropic.claude` · `provider_id=3` · `group=anthropic` · `priority=7` · `multi_key_mode=random` · `key_mode=append` · 9 个固定模型。仅**渠道名**与 **Key** 随业务变化。详见 `lib/supplier.ts`。

## 目录结构

```
app/
  api/            # me, ping, admin/{config,users,users/[id],users/[id]/upload}, my/{channel,upload}, logs
  page.tsx        # 根页面：密钥门 + 按角色渲染面板
components/        # KeyGate / AdminPanel / UserPanel / Toast / ui / 各弹窗
lib/
  types.ts supplier.ts store.ts auth.ts naci.ts channelService.ts client.ts
data/             # 运行时生成的 users/config/logs（本地持久化）
docs/DESIGN.md    # 设计契约（权威）
```

## 验收

`npm run build` 通过；端到端 8 项用例全部 PASS（创建 created / 追加 updated / 渠道详情 / 越权 403·401 / 管理员代传 / 日志按角色隔离），实测在平台真实创建渠道并三站发布。详见 QA 记录。
