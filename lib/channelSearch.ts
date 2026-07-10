// 渠道搜索路由的共享层：给搜索结果批量补实时用量/站点状态并组装行，以及 CSV 报表生成。
// admin/my × search/download 四个路由共用，naci 访问全部走 lib/naci.ts 客户端
//（session 复用 + 401 重登 + 429 退避），不在路由里裸写登录。
import {
  getChannelsStatusBatch,
  getChannelsUsedQuota,
  QUOTA_PER_USD,
  type ChannelSearchItem,
} from "./naci";
import { SITES } from "./supplier";

/** 管理员搜索/下载的全量拉取上限（超过要求细化关键词，保护 naci 与响应体积）。 */
export const MAX_ADMIN_SEARCH_RESULTS = 5000;
/** 用户前缀查询的全量拉取上限（单前缀渠道数的合理上界）。 */
export const MAX_USER_SEARCH_RESULTS = 5000;

/** 返回给前端/写入报表的渠道行。 */
export interface ChannelSearchRow {
  id: number;
  name: string;
  priority: number | null;
  used_quota: number;
  used_amount: number;
  created_at: string;
  updated_at: string;
  sites: { site_id: number; site_name: string; status: number }[];
  multiKeySize: number;
  aliveCount: number | null;
  deadCount: number | null;
  hasStatus: boolean;
}

/**
 * 用户前缀 → 只匹配**自己**渠道的精确过滤。
 * naci 的 keyword 是子串匹配：前缀 LIU 会命中 LIU-B 的渠道（07-10-LIU-B-1 含 "LIU"），
 * 造成跨用户可见。渠道名只有两种格式：`MM-DD-前缀-序号`（现行）和 `前缀-0001`（加日期标签前的存量），
 * 按整名正则匹配，别人的渠道一律滤掉。
 */
export function ownChannelNameFilter(prefix: string): (name: string) => boolean {
  const esc = prefix.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^(\\d{2}-\\d{2}-)?${esc}-\\d+$`);
  return (name) => re.test(name);
}

/** used-quota / status-batch 补数据的分块与节流（与后台用量任务同参）。 */
const ENRICH_CHUNK = 40;
const ENRICH_DELAY_MS = 300;

const SITE_NAME_BY_ID = new Map(SITES.map((s) => [s.site_id, s.site_name]));

/**
 * 给搜索结果批量补实时数据并组装行。分块 40、块间 300ms，每块内 used-quota 与
 * status-batch 并行、各自 best-effort：某块读失败不影响其余块，用量兜底列表自带值，
 * 状态缺失该渠道显示为「无状态」。withStatus=false 时只补用量（CSV 报表不需要站点状态）。
 */
type StatusEntry = {
  sites: { site_id: number; status: number }[];
  multiKeySize: number;
  aliveCount: number;
  deadCount: number;
  hasKeyInfo: boolean;
};

export async function enrichChannelRows(
  items: ChannelSearchItem[],
  opts: { withStatus?: boolean } = {}
): Promise<ChannelSearchRow[]> {
  const withStatus = opts.withStatus !== false;
  const ids = items.map((i) => i.id);

  const usageMap = new Map<number, number>();
  const statusMap = new Map<number, StatusEntry>();

  for (let i = 0; i < ids.length; i += ENRICH_CHUNK) {
    const chunk = ids.slice(i, i + ENRICH_CHUNK);
    const empty: Map<number, StatusEntry> = new Map();
    const [uRes, sRes] = await Promise.allSettled([
      getChannelsUsedQuota(chunk),
      withStatus ? getChannelsStatusBatch(chunk) : Promise.resolve(empty),
    ]);
    if (uRes.status === "fulfilled") {
      for (const [id, u] of uRes.value) usageMap.set(id, u.usedQuota);
    }
    if (sRes.status === "fulfilled") {
      for (const [id, st] of sRes.value) statusMap.set(id, st);
    }
    if (i + ENRICH_CHUNK < ids.length) {
      await new Promise((r) => setTimeout(r, ENRICH_DELAY_MS));
    }
  }

  return items.map((item) => {
    const usedQuota = usageMap.get(item.id) ?? item.usedQuota;
    const st = statusMap.get(item.id);
    return {
      id: item.id,
      name: item.name,
      priority: item.priority,
      used_quota: usedQuota,
      used_amount: Math.round((usedQuota / QUOTA_PER_USD) * 100) / 100,
      created_at: item.createdAt,
      updated_at: item.updatedAt,
      sites: (st?.sites ?? []).map((s) => ({
        site_id: s.site_id,
        site_name: SITE_NAME_BY_ID.get(s.site_id) ?? String(s.site_id),
        status: s.status,
      })),
      multiKeySize: st?.multiKeySize ?? 0,
      aliveCount: st?.aliveCount ?? null,
      deadCount: st?.deadCount ?? null,
      hasStatus: !!st,
    };
  });
}

function escapeCsvField(v: string | number | null): string {
  if (v == null) return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** 渠道行 → CSV 报表（UTF-8 BOM，Excel 直接打开不乱码）。 */
export function channelRowsToCsv(rows: ChannelSearchRow[]): string {
  const lines: string[] = ["naci_id,渠道名,优先级,used_quota,金额USD,创建时间"];
  for (const r of rows) {
    lines.push(
      [
        r.id,
        escapeCsvField(r.name),
        r.priority ?? "",
        r.used_quota,
        (r.used_quota / QUOTA_PER_USD).toFixed(2),
        escapeCsvField(r.created_at),
      ].join(",")
    );
  }
  return "﻿" + lines.join("\n");
}

/** CSV 下载响应（Content-Disposition 带 UTF-8 文件名）。 */
export function csvResponse(csv: string, filename: string): Response {
  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
    },
  });
}
