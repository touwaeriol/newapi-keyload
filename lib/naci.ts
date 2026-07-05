// naci new-api 兼容渠道端点客户端。
// 端点：GET/POST/PUT /api/channel/ ，Bearer token 鉴权。
import { getConfig } from "./store";
import { CHANNEL_TEMPLATE } from "./supplier";
import type { NaciChannel } from "./types";

interface NaciEnvelope<T> {
  success: boolean;
  message: string;
  data: T;
}

async function naciFetch<T>(
  method: string,
  pathAndQuery: string,
  body?: unknown
): Promise<T> {
  const cfg = await getConfig();
  if (!cfg.naciToken) throw new Error("尚未配置 naci 访问令牌（Bearer token）");
  const url = `${cfg.naciBaseUrl.replace(/\/$/, "")}${pathAndQuery}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.naciToken}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  let json: NaciEnvelope<T>;
  try {
    json = (await res.json()) as NaciEnvelope<T>;
  } catch {
    throw new Error(`naci 返回非 JSON（HTTP ${res.status}）`);
  }
  if (!json.success) {
    throw new Error(json.message || `naci 请求失败（HTTP ${res.status}）`);
  }
  return json.data;
}

/** 列表（单页） */
export async function listChannels(
  page = 1,
  pageSize = 100
): Promise<{ items: NaciChannel[]; total: number }> {
  const data = await naciFetch<{ items: NaciChannel[]; total: number }>(
    "GET",
    `/api/channel/?p=${page}&page_size=${pageSize}`
  );
  return { items: data.items ?? [], total: data.total ?? 0 };
}

/** 按名称精确查找渠道（翻页扫描），找不到返回 null */
export async function findChannelByName(
  name: string
): Promise<NaciChannel | null> {
  const target = name.trim();
  if (!target) return null;
  let page = 1;
  const pageSize = 100;
  // 最多扫 50 页，防御性上限
  for (let i = 0; i < 50; i++) {
    const { items, total } = await listChannels(page, pageSize);
    const hit = items.find((c) => c.name === target);
    if (hit) return hit;
    if (page * pageSize >= total || items.length === 0) break;
    page++;
  }
  return null;
}

/** 详情 */
export async function getChannel(id: number): Promise<NaciChannel> {
  return naciFetch<NaciChannel>("GET", `/api/channel/${id}`);
}

/** 创建渠道：wrapped 格式，渠道字段在 channel 内，返回本地模板 id */
export async function createChannel(params: {
  name: string;
  keyText: string; // 已用 \n 连接的多 key
}): Promise<{ id: number; ids: number[] }> {
  const body = {
    mode: "single",
    multi_key_mode: CHANNEL_TEMPLATE.multi_key_mode,
    channel: {
      ...CHANNEL_TEMPLATE,
      name: params.name,
      key: params.keyText,
    },
  };
  return naciFetch<{ id: number; ids: number[] }>("POST", "/api/channel/", body);
}

/** 更新渠道：扁平格式，id 顶层，key_mode=append 追加 key，返回更新后的渠道对象 */
export async function updateChannel(params: {
  id: number;
  name: string;
  keyText: string;
}): Promise<NaciChannel> {
  const body = {
    id: params.id,
    ...CHANNEL_TEMPLATE,
    name: params.name,
    key: params.keyText,
  };
  return naciFetch<NaciChannel>("PUT", "/api/channel/", body);
}

/** 轻量连通性测试：拉一页列表 */
export async function ping(): Promise<{ total: number }> {
  const { total } = await listChannels(1, 1);
  return { total };
}
