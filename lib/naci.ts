// naci admin-hub 渠道端点客户端（session 鉴权）。
//
// 鉴权：POST /api/user/login {username,password} → Set-Cookie: session=...；
// 之后所有请求携带 Cookie: session=...。session 失效（401 / "用户信息无效"）时自动
// 重新登录并重试一次。账号密码只从数据库系统配置读取（不走环境变量），
// 代码与文档不留明文。
//
// 渠道操作全部走 admin-hub：
//   GET  /api/admin-hub/channels/?page=&page_size=   列表（data 为数组）
//   GET  /api/admin-hub/channels/{id}                详情（data 为渠道对象）
//   POST /api/admin-hub/channels/                    创建
//   PUT  /api/admin-hub/channels/{id}                更新（key_mode=append 追加 key）
//   POST /api/admin-hub/channels/{id}/status         一次性重开全部三站（{all_sites:true,status:1}）
//   POST /api/admin-hub/channels/status-batch        只读每站 status + key 统计（{ids:[id]}）
import { addLog, getConfig } from "./store";
import {
  CHANNEL_JSON_TEMPLATE,
  LAST_SELECTED_SITE_IDS_JSON,
  OWNER_USER_ID,
} from "./supplier";
import type { KeyStats, NaciChannel } from "./types";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 单次 naci 请求超时（毫秒）。必须远小于引擎 CLAIM_STALE_MINUTES(10min) 以封死重复上传窗口。 */
const NACI_TIMEOUT_MS = 60_000;

interface NaciEnvelope<T> {
  success: boolean;
  message: string;
  data: T;
}

// —— session 单例（挂 globalThis，兼容 Next dev 热重载） ——
// cookie 缓存已登录态；loginPromise 用于「单飞登录」：并发请求只触发一次
// POST /api/user/login，其余请求 await 同一个 promise。
interface SessionStore {
  cookie: string | null;
  loginPromise: Promise<string> | null;
}

function sessionStore(): SessionStore {
  const g = globalThis as unknown as { __naciSession?: SessionStore };
  if (!g.__naciSession) {
    g.__naciSession = { cookie: null, loginPromise: null };
  }
  return g.__naciSession;
}

/** admin-hub 登录凭据：只从数据库系统配置读取（naciBaseUrl 允许 env 兜底，凭据不走 env） */
async function getCredentials(): Promise<{
  baseUrl: string;
  username: string;
  password: string;
}> {
  const cfg = await getConfig();
  const baseUrl = (cfg.naciBaseUrl || process.env.NACI_BASE_URL || "").replace(
    /\/$/,
    ""
  );
  // naci 登录凭据只从数据库配置读取（不走环境变量兜底）
  const username = (cfg.naciUsername || "").trim();
  const password = cfg.naciPassword || "";
  return { baseUrl, username, password };
}

/** 实际执行登录：拿 session cookie 并写入单例。 */
async function doLogin(): Promise<string> {
  const { baseUrl, username, password } = await getCredentials();
  if (!baseUrl) throw new Error("尚未配置 naci 平台地址（naciBaseUrl）");
  if (!username || !password) {
    throw new Error("缺少 naci 登录凭据（请在系统配置中设置 naci 账号密码）");
  }

  const res = await fetch(`${baseUrl}/api/user/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
    cache: "no-store",
  });

  let json: NaciEnvelope<unknown> | null = null;
  try {
    json = (await res.json()) as NaciEnvelope<unknown>;
  } catch {
    // 忽略非 JSON，仅凭 Set-Cookie 判断
  }
  if (!res.ok || (json && json.success === false)) {
    throw new Error(
      (json && json.message) || `naci 登录失败（HTTP ${res.status}）`
    );
  }

  const setCookie = res.headers.get("set-cookie") || "";
  const m = setCookie.match(/session=([^;]+)/);
  if (!m) {
    throw new Error("naci 登录未下发 session cookie（请检查账号密码）");
  }
  const cookie = m[1];
  sessionStore().cookie = cookie;
  return cookie;
}

/**
 * 单飞登录：并发调用只触发一次 POST /api/user/login，其余复用同一个 in-flight promise，
 * 避免多次登录互相覆盖 cookie。settle 后清空 loginPromise，允许下次重新登录。
 */
async function login(): Promise<string> {
  const store = sessionStore();
  if (store.loginPromise) return store.loginPromise;
  const p = doLogin().finally(() => {
    store.loginPromise = null;
  });
  store.loginPromise = p;
  return p;
}

/** 确保有可用 session，没有则登录（复用单飞）。 */
async function ensureSession(): Promise<string> {
  const store = sessionStore();
  if (store.cookie) return store.cookie;
  return login();
}

function isAuthFailure(status: number, message: string): boolean {
  if (status === 401 || status === 403) return true;
  const m = message || "";
  return (
    m.includes("用户信息无效") ||
    m.includes("未登录") ||
    m.includes("登录已过期") ||
    m.toLowerCase().includes("unauthorized")
  );
}

/** 429 限流的退避重试：次数与各次等待（毫秒）。naci 限流窗口短，几秒退避通常就能过。 */
const RATE_LIMIT_BACKOFF_MS = [2000, 5000, 10000];

/**
 * 带 session 的 admin-hub 请求。返回整个 envelope（部分接口需要 data 之外的字段）。
 * 遇到鉴权失败自动重新登录并重试一次；遇 429 限流按 RATE_LIMIT_BACKOFF_MS 退避重试。
 */
async function naciFetch<T>(
  method: string,
  pathAndQuery: string,
  body?: unknown,
  _retried = false,
  _rateRetry = 0
): Promise<NaciEnvelope<T>> {
  const { baseUrl } = await getCredentials();
  if (!baseUrl) throw new Error("尚未配置 naci 平台地址（naciBaseUrl）");
  const cookie = await ensureSession();
  const url = `${baseUrl}${pathAndQuery}`;

  // 显式超时（远小于引擎 reclaimStaleClaimed 的 10 分钟阈值）：避免单次请求长时间阻塞，
  // 否则「认领 key 后请求悬挂 > 10 分钟 → key 被回收重建 → 原请求随后又标记上传」会造成重复上传。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NACI_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Cookie: `session=${cookie}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(
        `naci 请求超时（${Math.round(NACI_TIMEOUT_MS / 1000)}s）：${method} ${pathAndQuery}`
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  let json: NaciEnvelope<T> | null = null;
  let parseErr = false;
  try {
    json = (await res.json()) as NaciEnvelope<T>;
  } catch {
    parseErr = true;
  }

  const message = json?.message ?? "";
  const failed = !res.ok || (json != null && json.success === false);

  // 鉴权失败：清 cookie，重新登录并重试一次
  if (failed && !_retried && isAuthFailure(res.status, message)) {
    sessionStore().cookie = null;
    await login();
    return naciFetch<T>(method, pathAndQuery, body, true, _rateRetry);
  }

  // 429 限流：退避后重试（naci 高峰期常态限流，一次 429 不应让降级/回退等操作直接失败）
  if (res.status === 429 && _rateRetry < RATE_LIMIT_BACKOFF_MS.length) {
    await new Promise((r) =>
      setTimeout(r, RATE_LIMIT_BACKOFF_MS[_rateRetry])
    );
    return naciFetch<T>(method, pathAndQuery, body, _retried, _rateRetry + 1);
  }

  if (parseErr) {
    throw new Error(`naci 返回非 JSON（HTTP ${res.status}）`);
  }
  if (!json || json.success === false) {
    throw new Error(message || `naci 请求失败（HTTP ${res.status}）`);
  }
  return json;
}

// —— 渠道对象归一化 ——
interface AdminHubRawChannel {
  id: number;
  name: string;
  description?: string;
  channel_json?: string;
  last_selected_site_ids_json?: string;
  site_group_overrides?: Record<string, string[]>;
  owner_user_id?: number;
  used_quota?: number;
  [k: string]: unknown;
}

/** 把 admin-hub 渠道对象展开为消费方友好的 NaciChannel（channel_json 内部字段提到顶层）。 */
function normalizeChannel(raw: AdminHubRawChannel): NaciChannel {
  let inner: Record<string, unknown> = {};
  if (typeof raw.channel_json === "string" && raw.channel_json) {
    try {
      inner = JSON.parse(raw.channel_json) as Record<string, unknown>;
    } catch {
      // 保底：解析失败则内部字段为空
    }
  }
  const merged: Record<string, unknown> = {
    ...inner, // models/group/priority/type/status/multi_key_mode 等
    ...raw, // admin-hub 顶层（id/name/used_quota/channel_json…）优先
    id: raw.id,
    name: raw.name ?? (inner.name as string) ?? "",
    channelJson: raw.channel_json,
    channelJsonObj: inner,
    lastSelectedSiteIdsJson: raw.last_selected_site_ids_json,
    siteGroupOverrides: raw.site_group_overrides,
    ownerUserId: raw.owner_user_id,
  };
  return merged as NaciChannel;
}

// —— 列表 / 查找 / 详情 ——

/** 列表（单页）。admin-hub 的 data 为渠道数组。 */
export async function listChannels(
  page = 1,
  pageSize = 100
): Promise<{ items: NaciChannel[]; pageSize: number }> {
  const env = await naciFetch<AdminHubRawChannel[]>(
    "GET",
    `/api/admin-hub/channels/?page=${page}&page_size=${pageSize}`
  );
  const arr = Array.isArray(env.data) ? env.data : [];
  return { items: arr.map(normalizeChannel), pageSize };
}

/** 详情。 */
export async function getChannel(id: number): Promise<NaciChannel> {
  const env = await naciFetch<AdminHubRawChannel>(
    "GET",
    `/api/admin-hub/channels/${id}`
  );
  return normalizeChannel(env.data);
}

// —— 创建 ——

/** naci 创建渠道响应里单个站点的发布结果（publish_results 元素归一化）。 */
export interface PublishResult {
  site_id: number;
  remote_channel_id: number;
  remote_channel_name: string;
  status: string;
  success: boolean;
}

/** 从创建响应的 publish_results（数组，字段有 snake/camel 两种拼写）解析每站远程渠道 id。 */
function parsePublishResults(raw: unknown): PublishResult[] {
  if (!Array.isArray(raw)) return [];
  const out: PublishResult[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const siteId = Number(r.site_id ?? r.siteId);
    if (!Number.isFinite(siteId)) continue;
    const remoteId = Number(r.remote_channel_id ?? r.remoteChannelId);
    out.push({
      site_id: siteId,
      remote_channel_id: Number.isFinite(remoteId) ? remoteId : 0,
      remote_channel_name:
        typeof r.remote_channel_name === "string" ? r.remote_channel_name : "",
      status: typeof r.status === "string" ? r.status : "",
      success: Boolean(r.success),
    });
  }
  return out;
}

/**
 * 创建聚合渠道。channel_json = 供应商模板 + name + key；顶层携带站点发布配置。
 * 返回归一化后的渠道，并显式带上解析后的 publishResults（各站 remote_channel_id）。
 */
export async function createChannel(params: {
  name: string;
  keyText: string; // 已用 \n 连接的多 key
  models?: string; // 模型列表（管理员可配）；缺省用模板默认
  priority?: number; // 优先级；缺省用模板默认（FIXED_PRIORITY）
}): Promise<NaciChannel & { publishResults: PublishResult[] }> {
  const channelObj: Record<string, unknown> = {
    ...CHANNEL_JSON_TEMPLATE,
    name: params.name,
    key: params.keyText,
    key_mode: "append",
    ...(params.models && params.models.trim()
      ? { models: params.models.trim() }
      : {}),
    ...(typeof params.priority === "number"
      ? { priority: params.priority }
      : {}),
  };
  // 注意：受限供应商账号（channel_site_config:false）无权自定义站点分组，
  // 带 site_group_overrides 会被 naci 拒（"无权选择不可见站点"）。对齐用户成功样例：
  // 只传 last_selected_site_ids_json 选站，不传 site_group_overrides。
  const body = {
    name: params.name,
    description: "",
    channel_json: JSON.stringify(channelObj),
    last_selected_site_ids_json: LAST_SELECTED_SITE_IDS_JSON,
    owner_user_id: OWNER_USER_ID,
  };
  const env = await naciFetch<AdminHubRawChannel>(
    "POST",
    "/api/admin-hub/channels/",
    body
  );
  const channel = normalizeChannel(env.data);
  const publishResults = parsePublishResults(
    (env.data as { publish_results?: unknown }).publish_results
  );
  return { ...channel, publishResults };
}

/**
 * 更新渠道优先级（退化降级用）：按用户要求 **先 GET 渠道详情 → 改 priority → PUT**。
 * PUT 不传 key（naci 保留原密钥），不传 site_group_overrides（受限账号无权自配站点分组）。
 */
export async function setChannelPriority(
  id: number,
  priority: number
): Promise<void> {
  const detail = await getChannel(id);
  const inner: Record<string, unknown> = { ...(detail.channelJsonObj ?? {}) };
  delete inner.key; // 不带 key，PUT 时保留原密钥
  inner.priority = priority;
  const body: Record<string, unknown> = {
    id,
    name: detail.name,
    description: (detail.description as string) ?? "",
    channel_json: JSON.stringify(inner),
    last_selected_site_ids_json:
      detail.lastSelectedSiteIdsJson ?? LAST_SELECTED_SITE_IDS_JSON,
    owner_user_id: detail.ownerUserId ?? OWNER_USER_ID,
  };
  await naciFetch("PUT", `/api/admin-hub/channels/${id}`, body);
}

// —— 站点状态 / key 统计 ——

// multi_key_status_list 可能是数组（下标即 key 序）或对象（"下标"→状态），两者都要能解析。
type StatusList = number[] | Record<string, number>;

/** 从任意可能的响应结构里抽取 channel_info（含 multi_key_size / multi_key_status_list）。 */
function pickChannelInfo(
  data: unknown
): { multi_key_size?: number; multi_key_status_list?: StatusList } | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const candidates: unknown[] = [
    d.channel_info,
    (d.channel as Record<string, unknown> | undefined)?.channel_info,
    d, // status 响应有时直接把 multi_key_* 放在顶层
  ];
  for (const c of candidates) {
    if (c && typeof c === "object") {
      const info = c as Record<string, unknown>;
      if ("multi_key_size" in info || "multi_key_status_list" in info) {
        return info as {
          multi_key_size?: number;
          multi_key_status_list?: StatusList;
        };
      }
    }
  }
  return null;
}

/** 把 multi_key_status_list（数组或「下标→状态」对象）归一为状态数组。 */
function normalizeStatusList(raw: StatusList | undefined): number[] {
  if (Array.isArray(raw)) return raw.map((v) => Number(v));
  if (raw && typeof raw === "object") {
    return Object.values(raw).map((v) => Number(v));
  }
  return [];
}

function toKeyStats(info: {
  multi_key_size?: number;
  multi_key_status_list?: StatusList;
} | null): KeyStats {
  const statusList = normalizeStatusList(info?.multi_key_status_list);
  const platformKeyCount =
    typeof info?.multi_key_size === "number"
      ? info!.multi_key_size!
      : statusList.length;
  const deadKeyCount = statusList.filter((s) => s === 3).length;
  return { platformKeyCount, deadKeyCount, statusList };
}

// status-batch 单渠道条目的解析结果：每站 status + 聚合 key 统计。
interface ParsedStatusBatch {
  /** site_id → 站点级 status（1=已打开，3=未打开/自动禁用）。 */
  siteStatus: Map<number, number>;
  /** 平台真实 key 数（第一个 channel_info.multi_key_size，缺则退回 list 长度最大值）。 */
  multiKeySize: number;
  /** 各站点存活数（status!==3）的最大值。 */
  aliveCount: number;
  /** multiKeySize - aliveCount（下限 0）。 */
  deadCount: number;
  /** 是否至少读到一份 multi_key_status_list（用于判断 key 统计是否可信）。 */
  hasKeyInfo: boolean;
}

/**
 * 解析 status-batch 响应里某渠道的条目（纯函数，不发请求）。
 * 结构：data[id].sites[*] = { site_id, status, channel_info:{multi_key_size, multi_key_status_list} }。
 * - siteStatus：逐站的 site 级 status（1=已打开，非 1=未打开）。
 * - key 统计（关键）：**只信「已打开站(status===1)」的 key 状态**。naci 对**未打开的站**会把
 *   该站所有 key 标成 status=3（因为站是关的，并非 key 真死）；而已打开且健康的站返回**空列表**
 *   （=没有被禁用的 key）。因此：每个已打开站的死键数 = 其 list 里 status===3 的个数（空/无 list → 0）；
 *   取**已打开站的最小死键数**作为真实死键数（deadCount），aliveCount = size - deadCount。
 *   无任何已打开站时退回「所有站的最小死键数」；都无信息则按全活。
 * - multiKeySize = 第一个 multi_key_size（缺则退回 list 最大长度）。data 无该渠道 / 无 sites 返回 null。
 */
function parseStatusBatch(data: unknown, id: number): ParsedStatusBatch | null {
  if (!data || typeof data !== "object") return null;
  const map = data as Record<string, unknown>;
  // 严格按渠道 id 取：naci 对某渠道返回显式 null / 缺失时**不得**兜底到别的条目，
  // 否则会把别的渠道的 key 统计错配给缺失渠道（M-6）。
  const entry = map[String(id)];
  if (!entry || typeof entry !== "object") return null;

  const sites = (entry as { sites?: unknown }).sites;
  if (!Array.isArray(sites) || sites.length === 0) return null;

  const siteStatus = new Map<number, number>();
  let multiKeySize: number | null = null;
  let maxListLen = 0;
  let sawList = false;
  // 各站死键数：已打开站单独统计（可信），所有站汇总作兜底
  let minDeadOpen: number | null = null;
  let minDeadAny: number | null = null;

  for (const site of sites) {
    if (!site || typeof site !== "object") continue;
    const s = site as Record<string, unknown>;

    const st = typeof s.status === "number" ? s.status : null;
    if (typeof s.site_id === "number" && st !== null) {
      siteStatus.set(s.site_id, st);
    }

    const info = s.channel_info as Record<string, unknown> | undefined;
    if (!info || typeof info !== "object") continue;
    if (multiKeySize === null && typeof info.multi_key_size === "number") {
      multiKeySize = info.multi_key_size;
    }

    // 计算该站死键数：有 list → 数 status===3；无 list 但有 size → 视为 0 死（该站无禁用信息）
    const list = info.multi_key_status_list;
    let deadOnSite: number | null = null;
    if (list && typeof list === "object") {
      sawList = true;
      const statuses = Object.values(list as Record<string, unknown>).map((x) =>
        Number(x)
      );
      maxListLen = Math.max(maxListLen, statuses.length);
      deadOnSite = statuses.filter((x) => x === 3).length;
    } else if (typeof info.multi_key_size === "number") {
      deadOnSite = 0;
    }

    if (deadOnSite !== null) {
      minDeadAny =
        minDeadAny === null ? deadOnSite : Math.min(minDeadAny, deadOnSite);
      if (st === 1) {
        minDeadOpen =
          minDeadOpen === null ? deadOnSite : Math.min(minDeadOpen, deadOnSite);
      }
    }
  }

  const size = multiKeySize ?? maxListLen;
  // 真实死键数：优先取已打开站的最小值；无已打开站退回所有站最小值；都无则 0（全活）。
  const dead = minDeadOpen ?? minDeadAny ?? 0;
  const deadCount = Math.max(0, Math.min(size, dead));
  const aliveCount = size - deadCount;
  return { siteStatus, multiKeySize: size, aliveCount, deadCount, hasKeyInfo: sawList };
}

/**
 * 补 key 后一次性打开渠道全部三站的调度：单次
 * POST /api/admin-hub/channels/{id}/status body `{all_sites:true, status:1}`。
 *
 * **整个调用带重试**：最多 3 次、间隔 ~800ms、任一次成功即停。3 次都失败记 error 日志
 * 「补 key 后未能打开站点调度，已重试 3 次仍失败：<原因>」但**不抛**（保证 tick 不 crash）。
 *
 * key 统计从该响应的 channel_info（pickChannelInfo 覆盖 data.channel_info /
 * data.channel.channel_info / 顶层）解析 multi_key_size / multi_key_status_list（3=禁用）；
 * 解析不到返回 null（pushBatchToChannel 已有 null 兜底）。
 */
export async function reenableAllSites(id: number): Promise<KeyStats | null> {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const env = await naciFetch<unknown>(
        "POST",
        `/api/admin-hub/channels/${id}/status`,
        { all_sites: true, status: 1 }
      );
      const info = pickChannelInfo(env.data);
      return info ? toKeyStats(info) : null;
    } catch (err) {
      lastErr = err;
      if (attempt < 3) await sleep(800);
    }
  }

  // 3 次都失败：记 error，不抛（引擎不 crash，key 保持 pending 下轮重试）
  await addLog({
    level: "error",
    actor: "engine",
    channelId: id,
    message: `补 key 后未能打开站点调度，已重试 3 次仍失败：${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  });
  return null;
}

/**
 * 读取渠道 key 统计。优先从渠道详情的 channel_info 解析；
 * 若详情未带（channel_info 为空），返回 null 由调用方决定是否回退到 reenableAllSites。
 */
export async function getKeyStats(id: number): Promise<KeyStats | null> {
  const detail = await getChannel(id);
  const info =
    pickChannelInfo(detail.channelJsonObj) ?? pickChannelInfo(detail);
  if (!info) return null;
  return toKeyStats(info);
}

/**
 * 只读检测渠道 key 存活情况（不写平台）：POST /api/admin-hub/channels/status-batch {ids:[id]}。
 * 响应结构：data[id].sites[*].channel_info.{multi_key_size, multi_key_status_list}，
 * 其中 multi_key_status_list 为「key 下标 → 状态」对象（3 = 禁用/死，非 3 = 存活）；
 * 多站点各有一份 list（key 共享）。
 *
 * 计算：每站点存活数 = 该站点 list 里 status!==3 的个数；aliveCount = 各站点存活数的最大值；
 * multiKeySize = 取到的第一个 channel_info.multi_key_size（缺则退回 list 长度最大值）；
 * deadCount = multiKeySize - aliveCount（下限 0）。
 * 拿不到（data 空 / 无 sites / 无 status list）返回 null，由调用方决定跳过。
 */
export async function getChannelKeyStatus(id: number): Promise<{
  multiKeySize: number;
  aliveCount: number;
  deadCount: number;
} | null> {
  const env = await naciFetch<Record<string, unknown>>(
    "POST",
    "/api/admin-hub/channels/status-batch",
    { ids: [id] }
  );
  const parsed = parseStatusBatch(env.data, id);
  // 未读到任何 multi_key_status_list（无从判断存活）→ null，调用方按「本轮跳过」处理
  if (!parsed || !parsed.hasKeyInfo) return null;
  return {
    multiKeySize: parsed.multiKeySize,
    aliveCount: parsed.aliveCount,
    deadCount: parsed.deadCount,
  };
}

/**
 * 一次 status-batch 只读同时拿到「每站调度状态」与「真实 key 统计」（不写平台）：
 * POST status-batch {ids:[id]} → 用 parseStatusBatch 解析。
 * - sites：data[id].sites[*] 的 {site_id, status}（1=已打开、3=未打开/自动禁用等）。
 * - multiKeySize / aliveCount / deadCount：真实 key 存活统计（供「可用=platform-dead」实时展示）。
 * - hasKeyInfo：是否至少读到一份 multi_key_status_list（false 时统计不可信）。
 * 数据不可解析（data 空/无 sites）返回 null；naci 读失败会**抛出**（由调用方兜底）。
 */
export async function getChannelStatusFull(id: number): Promise<{
  sites: { site_id: number; status: number }[];
  multiKeySize: number;
  aliveCount: number;
  deadCount: number;
  hasKeyInfo: boolean;
} | null> {
  const env = await naciFetch<Record<string, unknown>>(
    "POST",
    "/api/admin-hub/channels/status-batch",
    { ids: [id] }
  );
  const parsed = parseStatusBatch(env.data, id);
  if (!parsed) return null;
  return {
    sites: Array.from(parsed.siteStatus.entries()).map(([site_id, status]) => ({
      site_id,
      status,
    })),
    multiKeySize: parsed.multiKeySize,
    aliveCount: parsed.aliveCount,
    deadCount: parsed.deadCount,
    hasKeyInfo: parsed.hasKeyInfo,
  };
}

/**
 * 一次 status-batch 读取**多个**渠道的每站状态 + key 统计（新模型：一个前缀有多个已建渠道）。
 * 只对响应里确有该 id 的条目解析（避免 parseStatusBatch 的单 id 兜底把别的条目错配给缺失 id）。
 * naci 读失败会抛出，由调用方兜底。
 */
export async function getChannelsStatusBatch(ids: number[]): Promise<
  Map<
    number,
    {
      sites: { site_id: number; status: number }[];
      multiKeySize: number;
      aliveCount: number;
      deadCount: number;
      hasKeyInfo: boolean;
    }
  >
> {
  const out = new Map<
    number,
    {
      sites: { site_id: number; status: number }[];
      multiKeySize: number;
      aliveCount: number;
      deadCount: number;
      hasKeyInfo: boolean;
    }
  >();
  if (ids.length === 0) return out;
  const env = await naciFetch<Record<string, unknown>>(
    "POST",
    "/api/admin-hub/channels/status-batch",
    { ids }
  );
  const data = (env.data ?? {}) as Record<string, unknown>;
  for (const id of ids) {
    if (!(String(id) in data)) continue;
    const parsed = parseStatusBatch(data, id);
    if (!parsed) continue;
    out.set(id, {
      sites: Array.from(parsed.siteStatus.entries()).map(
        ([site_id, status]) => ({ site_id, status })
      ),
      multiKeySize: parsed.multiKeySize,
      aliveCount: parsed.aliveCount,
      deadCount: parsed.deadCount,
      hasKeyInfo: parsed.hasKeyInfo,
    });
  }
  return out;
}

/** naci 额度换算美元的除数（new-api quota_per_unit，实测 400176361→$800.35）。 */
export const QUOTA_PER_USD = 500000;

/** 单站点用量（used-quota 端点返回）。used_amount = used_quota / QUOTA_PER_USD。 */
export interface SiteUsedQuota {
  site_id: number;
  site_name: string;
  remote_channel_id: number;
  used_quota: number;
  used_amount: number;
}

/** 解析 used-quota 响应里单个渠道条目 { sites:[...], used_quota } → 归一化用量。无效返回 null。 */
function parseUsedQuotaEntry(entry: unknown): {
  usedQuota: number;
  usedAmount: number;
  sites: SiteUsedQuota[];
} | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as { sites?: unknown; used_quota?: unknown };
  const rawSites = Array.isArray(e.sites) ? e.sites : [];
  const sites: SiteUsedQuota[] = rawSites
    .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
    .map((s) => {
      const usedQuota = Number(s.used_quota) || 0;
      return {
        site_id: Number(s.site_id) || 0,
        site_name: typeof s.site_name === "string" ? s.site_name : "",
        remote_channel_id: Number(s.remote_channel_id) || 0,
        used_quota: usedQuota,
        used_amount: usedQuota / QUOTA_PER_USD,
      };
    });
  const totalQuota = Number(e.used_quota) || 0;
  return { usedQuota: totalQuota, usedAmount: totalQuota / QUOTA_PER_USD, sites };
}

/** 一次 used-quota 读取**多个**渠道的用量（供已建渠道列表聚合）。读失败抛出。 */
export async function getChannelsUsedQuota(ids: number[]): Promise<
  Map<number, { usedQuota: number; usedAmount: number; sites: SiteUsedQuota[] }>
> {
  const out = new Map<
    number,
    { usedQuota: number; usedAmount: number; sites: SiteUsedQuota[] }
  >();
  if (ids.length === 0) return out;
  const env = await naciFetch<Record<string, unknown>>(
    "POST",
    "/api/admin-hub/channels/used-quota",
    { ids }
  );
  const data = (env.data ?? {}) as Record<string, unknown>;
  for (const id of ids) {
    const parsed = parseUsedQuotaEntry(data[String(id)]);
    if (parsed) out.set(id, parsed);
  }
  return out;
}

/**
 * 只读读取渠道各站点的调度状态（不写平台）。基于 getChannelStatusFull，
 * 读失败 / 无数据一律返回 []（调用方自行用 SITES 补全站名与缺省状态）。
 */
export async function getChannelSites(
  id: number
): Promise<{ site_id: number; status: number }[]> {
  try {
    const full = await getChannelStatusFull(id);
    return full ? full.sites : [];
  } catch {
    return [];
  }
}

/**
 * 设置渠道单个站点的调度状态：POST /api/admin-hub/channels/{id}/status
 * body `{site_id, status, all_sites:false}`。status 透传（1=开、3/0/2 等由调用方决定）。
 * naci 失败时抛出，由调用方兜底（不在此吞异常）。
 */
export async function setSiteStatus(
  id: number,
  siteId: number,
  status: number
): Promise<void> {
  await naciFetch<unknown>("POST", `/api/admin-hub/channels/${id}/status`, {
    site_id: siteId,
    status,
    all_sites: false,
  });
}

/** 连通性测试：登录并校验 session（GET /api/user/self）。 */
export async function ping(): Promise<{ userId?: number; username?: string }> {
  const env = await naciFetch<{ id?: number; username?: string }>(
    "GET",
    "/api/user/self"
  );
  return { userId: env.data?.id, username: env.data?.username };
}
