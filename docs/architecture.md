# 架构说明

本文档说明「供应商渠道自动上 Key 系统」的整体架构、数据流、定时引擎工作流程、鉴权模型，以及为何选用平台 admin-hub 接口而非 new-api 兼容端点。

---

## 1. 总览

系统是一个 Next.js 14（App Router）全栈应用，前后端一体运行在本地。前端页面负责配置与展示，`app/api/*` 路由承接请求，`lib/*` 承载核心逻辑，最终通过 `lib/naci.ts` 调用平台 `open.naci-tech.com` 的 admin-hub API 完成渠道的创建、更新、状态检查与站点发布。所有状态本地持久化在 `data/` 下的 JSON 文件。

```
┌─────────────┐    HTTP     ┌──────────────┐    调用     ┌──────────────┐    HTTPS    ┌─────────────────────┐
│   前端页面   │ ─────────▶ │  app/api/*   │ ────────▶ │  lib/naci.ts  │ ─────────▶ │  open.naci-tech.com │
│ (React/App) │            │  (路由处理)   │           │ (平台客户端)  │  session   │   admin-hub API     │
└─────────────┘            └──────┬───────┘           └──────────────┘   cookie    └─────────────────────┘
                                  │
                                  │ 读写
                            ┌─────▼──────┐
                            │  lib/store │  ──▶  data/{config,tasks,logs}.json
                            └────────────┘
                                  ▲
                                  │ 周期驱动
                            ┌─────┴──────┐
                            │ lib/engine │  (instrumentation.ts 启动的单例定时引擎)
                            └────────────┘
```

---

## 2. 模块职责

| 模块 | 职责 |
| --- | --- |
| `app/api/*` | HTTP 路由：config、meta、ping、logs、channels、tasks 及 `tasks/[id]/{toggle,create-channel,bind,upload,check}` |
| `lib/supplier.ts` | 供应商固定参数（type=14 等）与站点定义（6/13/21）|
| `lib/types.ts` | 全局类型定义 |
| `lib/store.ts` | `data/*.json` 的读写与持久化 |
| `lib/naci.ts` | 平台 admin-hub API 客户端：构造 `channel_json`、create / update / status-batch |
| `lib/keys.ts` | key 源解析（文件 / 粘贴文本 → 有序 key 列表），维护取用游标 |
| `lib/engine.ts` | 定时引擎单例：周期检查、判定、补 key、发布、记日志 |
| `lib/taskFactory.ts` | 依据供应商参数与用户输入构造任务与渠道载荷 |
| `instrumentation.ts` | 在 Node 运行时启动定时引擎 |

---

## 3. 数据流

1. **前端 → app/api 路由**：用户在页面操作（保存配置、新建任务、创建渠道、立即检查等），触发对 `app/api/*` 的请求。
2. **app/api → lib**：路由校验入参后调用 `lib` 逻辑。涉及平台的操作交由 `lib/naci.ts`；状态读写交由 `lib/store.ts`。
3. **lib/naci → 平台 admin-hub**：`lib/naci.ts` 携带 session cookie，调用平台端点：
   - `GET/POST /api/admin-hub/channels/` —— 查询 / 创建渠道
   - `PUT /api/admin-hub/channels/{id}` —— 更新渠道（含 append 上 key 与站点发布）
   - `POST /api/admin-hub/channels/status-batch` —— 批量查询渠道在各站点的状态
4. **持久化**：任务、配置、日志经 `lib/store.ts` 写入 `data/*.json`。

---

## 4. 定时引擎工作流程

`lib/engine.ts` 是一个进程内单例，由 `instrumentation.ts` 在 Node 运行时启动。它按每个已启用任务各自的检查间隔循环执行：

```
                     ┌──────────────────────────┐
                     │  按任务间隔到点触发检查    │
                     └────────────┬─────────────┘
                                  ▼
                 POST status-batch  查询渠道在各站点状态
                                  │
                     ┌────────────┴─────────────┐
                     │  是否存在 status=3         │
                     │  （自动禁用）站点？        │
                     └───────┬───────────┬───────┘
                        否   │           │  是
                             ▼           ▼
                        记录状态日志   从 key 源按顺序取 N 个新 key
                                          │
                                          ▼
                             PUT /channels/{id}  key_mode=append
                             （追加 key + 站点分组覆盖，发布到各站点）
                                          │
                                          ▼
                                   推进 key 游标 + 记录补 key 日志
                                          │
                                          ▼
                             key 是否已耗尽？── 是 ─▶ 记录耗尽提示，停止该任务自动补 key
```

要点：

- **判定条件**：仅 `status=3`（AUTO_DISABLED，如 "All keys are disabled"）触发补 key；`status=2`（手动禁用）视为人工干预，跳过。
- **顺序取用**：key 从源按顺序取用并推进游标，避免重复使用；取满 N 个后一次性提交。
- **非破坏性**：更新使用 `key_mode=append`，只追加不覆盖。
- **多任务并行**：各任务独立计时与执行，互不阻塞。
- **可观测**：每次检查、补 key、发布、耗尽都写入 `data/logs.json`。

---

## 5. 鉴权模型

系统本地无鉴权（面向单机使用者），对平台的鉴权完全依赖登录后的 **`session` cookie**：

- 用户从浏览器手动复制 `open.naci-tech.com` 的 `session` cookie，保存到本系统「设置」（持久化于 `data/config.json`）。
- `lib/naci.ts` 每次请求平台时携带该 cookie。
- cookie 失效后所有平台调用会失败，需重新登录复制更新。「测试连接」（`app/api/ping`）用于快速校验 cookie 是否有效。

---

## 6. 为何用 admin-hub 而非 new-api 兼容端点

平台同时暴露了 new-api 风格的兼容端点与 admin-hub 端点。本系统**只使用 admin-hub**，原因如下：

- **兼容端点的扁平 PUT 会丢字段**：new-api 兼容端点的扁平化 `PUT` 会用请求体整体覆盖渠道记录，**未提交的字段会被清空**，容易破坏渠道已有配置（分组、模型、设置等）。
- **兼容端点不向站点发布 key**：即便通过兼容端点写入了 key，也**不会触发向各站点的发布**，渠道无法真正恢复。
- **admin-hub 的 PUT 才是正确路径**：`PUT /api/admin-hub/channels/{id}` 支持 `key_mode=append` **追加** key（保留已有 key 与配置），并携带站点分组覆盖，**将变更发布到所选各站点**，正是自动补 key 场景所需。

因此，创建、更新（补 key）、状态检查统一走 admin-hub 端点，保证补 key 既不破坏已有配置，又能真正在各站点生效。

---

## 7. 供应商固定参数（约束来源）

平台对该类渠道有严格校验，`lib/supplier.ts` 固定了：`type=14`、`platform_channel_type=anthropic_claude`、`provider_id=3`、`priority=7`、`group=anthropic`、`multi_key_mode=random`、`create_mode=multi_to_single`（聚合渠道）、`key_mode=append`。站点定义：`6` AC 站（anthropic, default）、`13` AGT 站（anthropic）、`21` 61 站（anthropic）。详见 [README](../README.md#供应商固定参数)。
