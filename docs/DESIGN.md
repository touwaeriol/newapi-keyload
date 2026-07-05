# 设计契约 —— 供应商 Key 上渠道系统 v2（团队共同基线）

> 本文件是 backend / frontend / QA 三个 agent 的共同契约。已由 lead 实测验证 naci 行为，实现时以本文件为准，不要回退到旧的 `architecture.md`（那是 v1 admin-hub+cookie 方案，已废弃）。

## 0. 已实测验证的 naci 行为（务必信任，不要再改端点）

- 端点：`GET/POST/PUT https://open.naci-tech.com/api/channel/`，`Authorization: Bearer <token>`。
- 生成 token：个人设置页「生成令牌」。token 通过环境变量 `NACI_TOKEN` 注入（见 `.env`，不入库），代码与文档不留明文。
- **POST 创建**：wrapped 格式 `{mode:"single", multi_key_mode:"random", channel:{...模板..., name, key}}` → 返回 `{id, ids:[id]}`，并**自动发布到 3 个供应商站点**（6 AC站 / 13 AGT站 / 21 61站）。实测新建 5798 成功且 site_amounts 三站齐全。
- **PUT 更新**：扁平格式 `{id, ...模板..., name, key}`，`key_mode:"append"` 追加 key；实测**不丢字段**（models/group/setting 均保留）。
- **GET 详情** `/api/channel/{id}`：返回完整字段 + `site_amounts`（含 used_quota/used_amount）+ 顶层 used_quota/used_amount；不返回 key。
- **GET 列表** `/api/channel/?p=1&page_size=100`：`data.items`（不含 key）+ total/page/page_size/type_counts。按名称精确匹配可翻页扫描。
- 模板固定字段见 `lib/supplier.ts`（type=14, provider_id=3, model_series=anthropic.claude, platform_channel_type=anthropic_claude, group=anthropic, priority=7, multi_key_mode=random, models 固定 9 个, settings, key_mode=append）。

## 1. 角色与鉴权

- 两种角色：`admin`、`user`。一个用户 = 一个访问密钥(accessKey) = 一个绑定渠道(channelName)。
- 所有 API 请求头带 `x-access-key: <accessKey>`（兼容 `Authorization: Bearer <accessKey>`）。后端按 key 匹配用户。
- admin 接口要求 admin 角色；user 只能操作自己（按 key）的数据；admin 可代任意用户操作。
- seed 默认管理员：username=`admin`，accessKey 由环境变量 `ADMIN_ACCESS_KEY` 注入；未配置则首次启动随机生成并打印到容器日志。
- 已实现的基础设施（**直接复用，不要重写**）：`lib/types.ts`、`lib/supplier.ts`、`lib/store.ts`、`lib/auth.ts`、`lib/naci.ts`。

## 2. 数据模型（见 lib/types.ts）

- `User { id, username, role, accessKey, channelName, channelId|null, createdAt, updatedAt }`
- `SystemConfig { naciBaseUrl, naciToken }`（持久化 data/config.json，token 只有 admin 能读写）
- `LogEntry { id, at, level, actor, channelName?, channelId?, message }`

## 3. 核心业务：上传 key（lib/channelService.ts —— 待实现）

`uploadKeys(user, keys: string[]) => UploadResult`：
1. 校验 `user.channelName` 非空；`keys` 去重去空（用 `parseKeys`）非空。
2. 解析 channelId：
   - 若 `user.channelId` 有值 → `getChannel(id)` 校验存在且名称一致；异常/不存在则视为未解析。
   - 未解析 → `findChannelByName(user.channelName)`；命中则记录 id。
3. 有 id → `updateChannel({id, name, keyText})`（append）→ action=`updated`。
   无 id → `createChannel({name, keyText})` → 取返回 id → action=`created`。
4. 回写 `user.channelId`（`upsertUser`）。
5. `getChannel(id)` 拉最新详情，取 `site_amounts`。
6. `addLog(...)` 记录；返回 `UploadResult { action, channelId, channelName, keyCount, siteAmounts }`。
   keyText = keys.join("\n")。

## 4. API 契约（app/api，全部要求 x-access-key；统一响应 {success,message,data}）

| 方法 路径 | 角色 | 说明 |
| --- | --- | --- |
| GET `/api/me` | any | 返回 `{user}`（SafeUser，不含 accessKey；含 role/username/channelName/channelId）。登录校验用 |
| GET `/api/ping` | admin | naci 连通性（listChannels(1,1)） |
| GET `/api/admin/config` | admin | 读 `{naciBaseUrl, naciToken}` |
| PUT `/api/admin/config` | admin | 存配置 |
| GET `/api/admin/users` | admin | 用户列表（含 accessKey，供管理员分发） |
| POST `/api/admin/users` | admin | 建用户 `{username, role, channelName}` → 自动生成 accessKey（genAccessKey） |
| PUT `/api/admin/users/[id]` | admin | 改 `{username?, role?, channelName?, regenerateKey?}` |
| DELETE `/api/admin/users/[id]` | admin | 删用户（禁止删除最后一个 admin / 自己，给出 400） |
| POST `/api/admin/users/[id]/upload` | admin | 代该用户上传 `{keys}` |
| GET `/api/my/channel` | any | 解析并返回调用者绑定渠道详情（name, channelId, models, priority, group, site_amounts, used_quota/amount）；未创建则返回 exists:false |
| POST `/api/my/upload` | any | 调用者为自己的渠道上传 `{keys:string或数组}` |
| GET `/api/logs` | any | admin 看全部；user 看自己 channelName 相关；最近若干条 |

错误统一走 `lib/auth.ts` 的 `errorResponse`；成功用 `ok(data)`；参数错误 `fail(msg)`。

## 5. 前端（app/page.tsx + components + lib/client.ts —— 待实现）

- **KeyGate**：应用加载时读取 localStorage(`akl.accessKey`)；调 `GET /api/me`；有效→进入并缓存；无效/无→弹窗输入 key + 「记住本地」勾选框（勾选则写 localStorage）。登录即校验，跳过独立登录页。
- **lib/client.ts**：`apiFetch(path, opts)` 注入 `x-access-key`；key 来自内存 + localStorage。
- **admin 视图**：
  - 系统配置卡：naciBaseUrl + naciToken 编辑、测试连接(/api/ping)。
  - 用户管理：表格（用户名/角色/绑定渠道名/accessKey 一键复制/channelId 状态）；新建/编辑/删除；每行「代传 key」。
  - 可选：日志面板。
- **user 视图**：
  - 「我的渠道」卡：显示绑定渠道名、是否已在平台创建、channelId、模型/优先级/分组、各站点发布状态与用量。
  - 上传 key：textarea（每行一个）→ 提交 `/api/my/upload` → 展示 created/updated + 站点发布结果 + 刷新渠道卡。
- UI：Tailwind，中文，简洁卡片式；toast 提示；面向本地单机。

## 6. 验收（QA）

1. `npm install` → `npm run build` 通过（无类型错误）。
2. `npm run dev` 起服务。
3. 以 seed admin key 调 `/api/me` 返回 admin。
4. admin 建一个 user（channelName 用一个新名字，如 `TEST-TEAM-<随机>`）。
5. 用该 user key 调 `/api/my/upload` 传 1~2 个测试 key → 期望 action=created、channelId 有值、site_amounts 三站。
6. 再次 upload → action=updated。
7. `/api/my/channel` 显示详情。
8. 越权校验：user key 调 admin 接口 → 403；无 key → 401。

测试 key：见本机 `docs/edit-channel-request.txt`（含 4 个真实 sk-ant key，已 gitignore，不入库）。
