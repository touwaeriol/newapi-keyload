// naci admin-hub 渠道端点客户端（session 鉴权）。
//
// 鉴权：POST /api/user/login {username,password} → Set-Cookie: session=...；
// 之后所有请求携带 Cookie: session=...。session 失效（401 / "用户信息无效"）时自动
// 重新登录并重试一次。账号密码只从环境变量读取（NACI_USERNAME / NACI_PASSWORD），
// 代码与文档不留明文。
//
// 渠道操作全部走 admin-hub：
//   GET  /api/admin-hub/channels/?page=&page_size=   列表（data 为数组）
//   GET  /api/admin-hub/channels/{id}                详情（data 为渠道对象）
//   POST /api/admin-hub/channels/                    创建
//   PUT  /api/admin-hub/channels/{id}                更新（key_mode=append 追加 key）
//   POST /api/admin-hub/channels/{id}/status         批量站点状态（重开 / 读 key 统计）
import { getConfig } from "./store";
import {
  CHANNEL_JSON_TEMPLATE,
  LAST_SELECTED_SITE_IDS_JSON,
  OWNER_USER_ID,
  SITE_GROUP_OVERRIDES,
} from "./supplier";
import type { KeyStats, NaciChannel } from "./types";

interface NaciEnvelope<T> {
  success: boolean;
  message: string;
  data: T;
}

// —— session 单例（挂 globalThis，兼容 Next dev 热重载） ——
// cookie/at 缓存已登录态；loginPromise 用于「单飞登录」：并发请求只触发一次
// POST /api/user/login，其余请求 await 同一个 promise。
interface SessionStore {
  cookie: string | null;
  at: number; // 上次登录成功的时间戳（ms），用于惰性保活
  loginPromise: Promise<string> | null;
}

/** session 惰性保活阈值：距上次登录超过此时长即主动重登（无后台定时器） */
const SESSION_MAX_AGE_MS = 20 * 60 * 1000;

function sessionStore(): SessionStore {
  const g = globalThis as unknown as { __naciSession?: SessionStore };
  if (!g.__naciSession) {
    g.__naciSession = { cookie: null, at: 0, loginPromise: null };
  }
  return g.__naciSession;
}

/** admin-hub 登录凭据：优先环境变量，其次配置表（不建议入库明文） */
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

/** 登录拿 session cookie，写入单例。 */
async function login(): Promise<string> {
  const { baseUrl, username, password } = await getCredentials();
  if (!baseUrl) throw new Error("尚未配置 naci 平台地址（naciBaseUrl）");
  if (!username || !password) {
    throw new Error(
      "缺少 naci 登录凭据（请设置环境变量 NACI_USERNAME / NACI_PASSWORD）"
    );
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

/** 确保有可用 session，没有则登录。 */
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
    m.includes("无权") ||
    m.includes("登录") ||
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

/** 从任意可能的响应结构里抽取 channel_info（含 multi_key_size / multi_key_status_list）。 */
function pickChannelInfo(
  data: unknown
): { multi_key_size?: number; multi_key_status_list?: number[] } | null {
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
          multi_key_status_list?: number[];
        };
      }
    }
  }
  return null;
}

function toKeyStats(info: {
  multi_key_size?: number;
  multi_key_status_list?: number[];
} | null): KeyStats {
  const statusList = Array.isArray(info?.multi_key_status_list)
    ? (info!.multi_key_status_list as number[])
    : [];
  const platformKeyCount =
    typeof info?.multi_key_size === "number"
      ? info!.multi_key_size!
      : statusList.length;
  const deadKeyCount = statusList.filter((s) => s === 3).length;
  return { platformKeyCount, deadKeyCount, statusList };
}

/**
 * 重开渠道在所有站点的状态（status=1），并返回 key 统计。
 * 实测响应含 channel.channel_info.multi_key_size 与 multi_key_status_list。
 */
export async function reenableAllSites(id: number): Promise<KeyStats> {
  const env = await naciFetch<unknown>(
    "POST",
    `/api/admin-hub/channels/${id}/status`,
    { all_sites: true, status: 1 }
  );
  return toKeyStats(pickChannelInfo(env.data));
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

/** 连通性测试：登录并校验 session（GET /api/user/self）。 */
export async function ping(): Promise<{ userId?: number; username?: string }> {
  const env = await naciFetch<{ id?: number; username?: string }>(
    "GET",
    "/api/user/self"
  );
  return { userId: env.data?.id, username: env.data?.username };
}
