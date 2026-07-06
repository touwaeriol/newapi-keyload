# 设计文档 —— 供应商 Key 上渠道系统（权威）

> 本文件是唯一权威设计基线。`docs/architecture.md`（v1 引擎/任务系统）与 `docs/naci-channel-api.md`（new-api 兼容 Bearer 端点）均为**历史资料，已废弃**，勿据其实现。

## 1. 一句话

本系统是一个本地/自托管的 Next.js 14 全栈应用：管理员配置用户与其绑定的渠道，用户上传 Anthropic Claude API Key，后端登录 naci 平台（`open.naci-tech.com`）自动**创建或追加**对应的聚合渠道并发布到各站点、必要时重开站点调度。

## 2. 两套鉴权（务必分清）

| 层 | 鉴权方式 | 说明 |
| --- | --- | --- |
| **本系统自身**（浏览器 ↔ 我们的后端） | **访问密钥** `x-access-key: <accessKey>`（兼容 `Authorization: Bearer <accessKey>`） | 每个用户一把 `uk-…` 密钥，管理员一把。后端按密钥匹配用户与角色（admin/user） |
| **后端 ↔ naci 平台** | **账号密码登录 → session cookie** | 后端用 naci 账号（用户名+密码，存数据库）`POST /api/user/login` 拿 `session` cookie，之后所有 naci 调用带 `Cookie: session=…`；失效自动重登 |

> naci 侧**不再使用** new-api 兼容端点的 Bearer token；渠道操作全部走 **admin-hub** 端点。

## 3. naci admin-hub 端点（session 鉴权，已实测）

- `POST /api/user/login` `{username,password}` → `Set-Cookie: session=…`（校验：`GET /api/user/self`）
- `GET  /api/admin-hub/channels/?page=&page_size=` → `data` 为渠道数组（每项含 `channel_json` 字符串）
- `GET  /api/admin-hub/channels/{id}` → 单渠道详情
- `POST /api/admin-hub/channels/` → 创建（顶层 `name/channel_json/last_selected_site_ids_json/site_group_overrides/owner_user_id`）
- `PUT  /api/admin-hub/channels/{id}` → 更新（`channel_json` 内 `key_mode:"append"` 追加 key）
- `POST /api/admin-hub/channels/{id}/status` `{all_sites:true,status:1}` → 重开所有站点；响应 `channel.channel_info.multi_key_size`（真实 key 数）与 `multi_key_status_list`（每 key 状态，3=禁用）

## 4. 固定参数（供应商聚合渠道）

见 `lib/supplier.ts`：`type=14` · `platform_channel_type=anthropic_claude` · `model_series=anthropic.claude` · `provider_id=3` · `group=anthropic` · `priority=7` · `create_mode=multi_to_single`（聚合）· `multi_key_mode=random`（轮询）· `key_mode=append` · 9 个固定模型。站点：6 AC（分组 anthropic+default）/13 AGT（anthropic）/21 61（anthropic），`owner_user_id=18`。只有**渠道名**与 **key** 随业务变化。

## 5. 持久化：PostgreSQL

`lib/store.ts` 用 node-postgres（`DATABASE_URL`）。表：

- `users(id, username, role, access_key, channel_name, channel_id, platform_key_count, dead_key_count, created_at, updated_at)`
- `config(id=1, naci_base_url, naci_token(遗留), naci_username, naci_password)` —— **naci 登录凭据只存这里**，由管理员在系统配置页维护，不走环境变量。
- `logs(...)`、`uploaded_keys(channel_name, key_hash)`（sha256，仅计数）

首次启动自动建表 + seed（admin 用户，密钥取 `ADMIN_ACCESS_KEY` 或随机生成打印到日志）。建表用 `ALTER … ADD COLUMN IF NOT EXISTS` 兼容线上数据卷。

## 6. 核心业务：上传 key（lib/channelService.ts）

`uploadKeys(user, keys)`：
1. 校验 `user.channelName` 与 keys（`parseKeys` 去重去空）。
2. 解析渠道 id：缓存 `channelId` 命中则用；否则 `findChannelByName` 按名精确查找。
3. 有 id → `updateChannel`（GET 详情保留现有配置 + append key + PUT）；无 id → `createChannel`（模板 + key）。
4. `reenableAllSites(id)` 重开所有站点，取回 `multi_key_size`/`dead` 统计，写入 `users.platform_key_count/dead_key_count`。
5. `recordUploadedKeys` 记 sha256 计数；`addLog`。返回 `{action, channelId, channelName, keyCount, uploadedKeyCount, platformKeyCount, deadKeyCount, siteAmounts}`。

`resolveMyChannel(user)`（供 GET /api/my/channel）：解析渠道详情，`platformKeyCount/deadKeyCount` 读用户表缓存（GET 不做重开等写操作）。

## 7. API 契约（app/api，全部要求 x-access-key；响应 `{success,message,data}`）

| 方法 路径 | 角色 | 说明 |
| --- | --- | --- |
| GET `/api/me` | any | 当前用户（SafeUser，不含 accessKey） |
| GET `/api/ping` | admin | 登录 naci 校验 → `{userId,username}` |
| GET/PUT `/api/admin/config` | admin | naci 连接配置：GET 返回 `{naciBaseUrl, naciUsername, hasNaciPassword, hasNaciToken}`（不回明文密码/token）；PUT `{naciBaseUrl, naciUsername, naciPassword?}`（密码留空=不改） |
| GET/POST `/api/admin/users` | admin | 用户列表（含 accessKey 供分发）/ 建用户（自动生成 accessKey；channelName 全局唯一） |
| PUT/DELETE `/api/admin/users/[id]` | admin | 改（含重置密钥）/ 删（禁删最后 admin/自己） |
| POST `/api/admin/users/[id]/upload` | admin | 代该用户上传 key |
| GET `/api/admin/users/[id]/channel` | admin | 查看某用户渠道状态 |
| GET `/api/my/channel` | any | 调用者绑定渠道详情（exists/status/type/models/priority/group/usedQuota/usedAmount/siteAmounts/uploadedKeyCount/platformKeyCount/deadKeyCount） |
| POST `/api/my/upload` | any | 调用者上传 key |
| GET `/api/logs` | any | admin 全部；user 仅自己 channelName |

## 8. 前端

密钥登录弹窗（KeyGate，可本机记住）→ 按角色渲染 AdminPanel/UserPanel。`lib/client.ts` 的 `apiFetch` 注入 `x-access-key`，401 时清 key 触发回登录门。管理员配置页维护 naci 账号密码；用户/管理员均可查看渠道状态（含平台 key 数、禁用 key 数）。

## 9. 部署

Docker Compose：`app`（Next.js standalone）+ `db`（postgres:16-alpine，数据卷 `keyload-pgdata`）。**不依赖 `.env` 文件**：`DATABASE_URL`、库密码等直接写在 `docker-compose.yml`（db 仅内部网络、不暴露宿主端口）。管理员密钥首次随机生成并打印到日志；**naci 账号密码存数据库**。OVH 上 Caddy 反代 HTTPS。

## 10. 安全约束

- 代码/文档/仓库不留任何真实密钥、token、密码、session。
- `.env` 与 `docs/*.txt`（抓包/样例）均 gitignore，且 `.env` 不进镜像层。
- naci 密码、naciToken 不回传前端明文（只回布尔「是否已设置」）。
- 500 错误不外泄内部细节。
