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
  SITE_GROUP_OVERRIDES,
} from "./supplier";
import type { KeyStats, NaciChannel } from "./types";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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

/**
 * 带 session 的 admin-hub 请求。返回整个 envelope（部分接口需要 data 之外的字段）。
 * 遇到鉴权失败自动重新登录并重试一次。
 */
async function naciFetch<T>(
  method: string,
  pathAndQuery: string,
  body?: unknown,
  _retried = false
): Promise<NaciEnvelope<T>> {
  const { baseUrl } = await getCredentials();
  if (!baseUrl) throw new Error("尚未配置 naci 平台地址（naciBaseUrl）");
  const cookie = await ensureSession();
  const url = `${baseUrl}${pathAndQuery}`;

  const res = await fetch(url, {
    method,
    headers: {
      Cookie: `session=${cookie}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });

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
    return naciFetch<T>(method, pathAndQuery, body, true);
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

/** 按名称精确查找渠道（翻页扫描），找不到返回 null。 */
export async function findChannelByName(
  name: string
): Promise<NaciChannel | null> {
  const target = name.trim();
  if (!target) return null;
  const pageSize = 100;
  // 最多扫 50 页，防御性上限
  for (let page = 1; page <= 50; page++) {
    const { items } = await listChannels(page, pageSize);
    const hit = items.find((c) => c.name === target);
    if (hit) return hit;
    if (items.length < pageSize) break; // 最后一页
  }
  return null;
}

/** 详情。 */
export async function getChannel(id: number): Promise<NaciChannel> {
  const env = await naciFetch<AdminHubRawChannel>(
    "GET",
    `/api/admin-hub/channels/${id}`
  );
  return normalizeChannel(env.data);
}

// —— 创建 / 更新 ——

/**
 * 创建聚合渠道。channel_json = 供应商模板 + name + key；顶层携带站点发布配置。
 * 返回归一化后的渠道（含 id、publish_results 原样保留在 raw 字段上）。
 */
export async function createChannel(params: {
  name: string;
  keyText: string; // 已用 \n 连接的多 key
}): Promise<NaciChannel> {
  const channelObj: Record<string, unknown> = {
    ...CHANNEL_JSON_TEMPLATE,
    name: params.name,
    key: params.keyText,
    key_mode: "append",
  };
  const body = {
    name: params.name,
    description: "",
    channel_json: JSON.stringify(channelObj),
    last_selected_site_ids_json: LAST_SELECTED_SITE_IDS_JSON,
    site_group_overrides: SITE_GROUP_OVERRIDES,
    owner_user_id: OWNER_USER_ID,
  };
  const env = await naciFetch<AdminHubRawChannel>(
    "POST",
    "/api/admin-hub/channels/",
    body
  );
  return normalizeChannel(env.data);
}

/**
 * 更新渠道（追加 key）：先 GET 详情取现有 channel_json，仅把 key 设为本次内容、
 * key_mode=append，其余字段与 site_group_overrides / last_selected_site_ids_json 原样保留，
 * 避免用固定模板整体覆盖平台上已被修改的配置。
 */
export async function updateChannel(params: {
  id: number;
  name: string;
  keyText: string;
}): Promise<NaciChannel> {
  const detail = await getChannel(params.id);

  const channelObj: Record<string, unknown> = {
    ...(detail.channelJsonObj ?? {}),
    name: params.name,
    key: params.keyText,
    key_mode: "append",
  };

  const body: Record<string, unknown> = {
    id: params.id,
    name: params.name,
    description: (detail.description as string) ?? "",
    channel_json: JSON.stringify(channelObj),
    last_selected_site_ids_json:
      detail.lastSelectedSiteIdsJson ?? LAST_SELECTED_SITE_IDS_JSON,
    site_group_overrides: detail.siteGroupOverrides ?? SITE_GROUP_OVERRIDES,
    owner_user_id: detail.ownerUserId ?? OWNER_USER_ID,
  };
  const env = await naciFetch<AdminHubRawChannel>(
    "PUT",
    `/api/admin-hub/channels/${params.id}`,
    body
  );
  return normalizeChannel(env.data);
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
 * - key 统计：每站存活 = list 里 status!==3 的个数，aliveCount 取各站最大值；
 *   multiKeySize = 第一个 multi_key_size（缺则退回 list 最大长度）；deadCount = size-alive（≥0）。
 * data 无该渠道 / 无 sites 时返回 null。
 */
function parseStatusBatch(data: unknown, id: number): ParsedStatusBatch | null {
  if (!data || typeof data !== "object") return null;
  const map = data as Record<string, unknown>;
  // 按渠道 id 取；取不到则退回第一个条目（防御性）
  const entry = map[String(id)] ?? Object.values(map)[0];
  if (!entry || typeof entry !== "object") return null;

  const sites = (entry as { sites?: unknown }).sites;
  if (!Array.isArray(sites) || sites.length === 0) return null;

  const siteStatus = new Map<number, number>();
  let multiKeySize: number | null = null;
  let maxListLen = 0;
  let aliveCount = 0;
  let sawList = false;

  for (const site of sites) {
    if (!site || typeof site !== "object") continue;
    const s = site as Record<string, unknown>;

    if (typeof s.site_id === "number" && typeof s.status === "number") {
      siteStatus.set(s.site_id, s.status);
    }

    const info = s.channel_info as Record<string, unknown> | undefined;
    if (info && typeof info === "object") {
      if (multiKeySize === null && typeof info.multi_key_size === "number") {
        multiKeySize = info.multi_key_size;
      }
      const list = info.multi_key_status_list;
      if (list && typeof list === "object") {
        sawList = true;
        const statuses = Object.values(list as Record<string, unknown>);
        maxListLen = Math.max(maxListLen, statuses.length);
        const alive = statuses.filter((x) => Number(x) !== 3).length;
        if (alive > aliveCount) aliveCount = alive;
      }
    }
  }

  const size = multiKeySize ?? maxListLen;
  const deadCount = Math.max(0, size - aliveCount);
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
