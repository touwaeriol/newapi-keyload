// 渠道搜索路由的共享层：给搜索结果批量补实时用量/站点状态并组装行，以及 CSV 报表生成。
// admin/my × search/download 四个路由共用，naci 访问全部走 lib/naci.ts 客户端
//（session 复用 + 401 重登 + 429 退避），不在路由里裸写登录。
import {
  getChannelsStatusBatch,
  getChannelsUsedQuota,
  QUOTA_PER_USD,
  type ChannelSearchItem,
} from "./naci";
import {
  bucketRetryAfterMs,
  releaseBucket,
  reserveBucketMs,
} from "./rateLimit";
import { SITES } from "./supplier";
import ExcelJS from "exceljs";

/** 管理员搜索/下载的全量拉取上限（超过要求细化关键词，保护 naci 与响应体积）。 */
export const MAX_ADMIN_SEARCH_RESULTS = 5000;
/** 用户前缀查询的全量拉取上限（单前缀渠道数的合理上界）。 */
export const MAX_USER_SEARCH_RESULTS = 5000;

/**
 * 用户渠道管理接口限流闸门（Redis 滑动窗口桶，Redis 不可用自动降级内存桶）：
 * 占到额度返回 ok + rollback（下游 naci 失败时退还，避免白等一个窗口）；
 * 占不到返回 429 用的提示文案（带剩余等待时长）。intervalMs<=0 表示不限流。
 */
export type RateGate =
  | { ok: true; rollback: () => Promise<void> }
  | { ok: false; message: string };

async function acquireGate(
  scope: string,
  intervalMs: number,
  buildMessage: (retryAfterMs: number) => string
): Promise<RateGate> {
  if (intervalMs <= 0) return { ok: true, rollback: async () => {} };
  const { granted, members } = await reserveBucketMs(scope, 1, 1, intervalMs);
  if (granted > 0) {
    return { ok: true, rollback: () => releaseBucket(scope, members) };
  }
  const retryAfterMs = await bucketRetryAfterMs(scope, intervalMs);
  return { ok: false, message: buildMessage(retryAfterMs) };
}

/** 用户渠道查询限流：每 intervalSeconds 秒最多一次（0=不限）。 */
export function acquireUserQuerySlot(
  userId: string,
  intervalSeconds: number
): Promise<RateGate> {
  return acquireGate(`qry:user:${userId}`, intervalSeconds * 1000, (ms) => {
    const wait = Math.max(1, Math.ceil(ms / 1000));
    return `查询过于频繁：每 ${intervalSeconds} 秒最多查询一次，请 ${wait} 秒后重试`;
  });
}

/** 用户报表拉取限流：每 intervalMinutes 分钟最多一次（0=不限）。 */
export function acquireUserReportSlot(
  userId: string,
  intervalMinutes: number
): Promise<RateGate> {
  return acquireGate(
    `rpt:user:${userId}`,
    intervalMinutes * 60_000,
    (ms) => {
      const waitSec = Math.max(1, Math.ceil(ms / 1000));
      const wait =
        waitSec >= 60 ? `${Math.ceil(waitSec / 60)} 分钟` : `${waitSec} 秒`;
      return `报表 ${intervalMinutes} 分钟内只能拉取一次，请 ${wait}后重试`;
    }
  );
}

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

/** used-quota / status-batch 补数据的分块与节流。100/批减少往返（单请求仍 <60s naci 超时）。 */
const ENRICH_CHUNK = 100;
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
  opts: {
    withStatus?: boolean;
    /** 每处理完一块回调一次（done=已补完的渠道数, total=总数），供报表进度上报 */
    onProgress?: (done: number, total: number) => void;
  } = {}
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
    opts.onProgress?.(Math.min(i + ENRICH_CHUNK, ids.length), ids.length);
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

/**
 * 渠道行 → CSV 报表（UTF-8 BOM，Excel 直接打开不乱码）。
 * key数量列 = naci 的聚合 key 数（multiKeySize）——一个渠道可聚合多个 key，一渠道≠一 key；
 * 末尾合计行的 key 总数按聚合数累加。状态没拉到的渠道 key 数留空、不计入合计（合计行会标注几个未知）。
 */
export function channelRowsToCsv(rows: ChannelSearchRow[]): string {
  const lines: string[] = [
    "naci_id,渠道名,优先级,key数量,used_quota,金额USD,创建时间",
  ];
  let totalKeys = 0;
  let unknownKeyRows = 0;
  let totalQuota = 0;
  for (const r of rows) {
    const keyCount = r.hasStatus && r.multiKeySize > 0 ? r.multiKeySize : null;
    if (keyCount == null) unknownKeyRows += 1;
    else totalKeys += keyCount;
    totalQuota += r.used_quota;
    lines.push(
      [
        r.id,
        escapeCsvField(r.name),
        r.priority ?? "",
        keyCount ?? "",
        r.used_quota,
        (r.used_quota / QUOTA_PER_USD).toFixed(2),
        escapeCsvField(r.created_at),
      ].join(",")
    );
  }
  const label =
    unknownKeyRows > 0
      ? `合计(${rows.length}渠道,其中${unknownKeyRows}个key数未知)`
      : `合计(${rows.length}渠道)`;
  lines.push(
    [
      escapeCsvField(label),
      "",
      "",
      totalKeys,
      totalQuota,
      (totalQuota / QUOTA_PER_USD).toFixed(2),
      "",
    ].join(",")
  );
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

/**
 * 渠道行 → xlsx(Excel) 报表 Buffer。列与合计逻辑同 CSV（channelRowsToCsv），
 * 但数值列是真正的数字单元格（Excel 里可直接求和/排序），首行与合计行加粗。
 */
export async function channelRowsToXlsx(
  rows: ChannelSearchRow[]
): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("渠道报表");
  ws.columns = [
    { header: "naci_id", key: "id", width: 12 },
    { header: "渠道名", key: "name", width: 30 },
    { header: "优先级", key: "priority", width: 8 },
    { header: "key数量", key: "keyCount", width: 10 },
    { header: "used_quota", key: "usedQuota", width: 14 },
    { header: "金额USD", key: "usd", width: 12 },
    { header: "创建时间", key: "createdAt", width: 22 },
  ];
  ws.getRow(1).font = { bold: true };
  let totalKeys = 0;
  let unknownKeyRows = 0;
  let totalQuota = 0;
  for (const r of rows) {
    const keyCount = r.hasStatus && r.multiKeySize > 0 ? r.multiKeySize : null;
    if (keyCount == null) unknownKeyRows += 1;
    else totalKeys += keyCount;
    totalQuota += r.used_quota;
    ws.addRow({
      id: r.id,
      name: r.name,
      priority: r.priority ?? "",
      keyCount: keyCount ?? "",
      usedQuota: r.used_quota,
      usd: Number((r.used_quota / QUOTA_PER_USD).toFixed(2)),
      createdAt: r.created_at,
    });
  }
  const label =
    unknownKeyRows > 0
      ? `合计(${rows.length}渠道,其中${unknownKeyRows}个key数未知)`
      : `合计(${rows.length}渠道)`;
  const totalRow = ws.addRow({
    id: label,
    keyCount: totalKeys,
    usedQuota: totalQuota,
    usd: Number((totalQuota / QUOTA_PER_USD).toFixed(2)),
  });
  totalRow.font = { bold: true };
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

/** xlsx(Excel) 下载响应。 */
export function xlsxResponse(buf: ArrayBuffer, filename: string): Response {
  return new Response(buf, {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(
        filename
      )}"`,
    },
  });
}
