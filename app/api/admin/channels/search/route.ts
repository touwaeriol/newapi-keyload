import { NextRequest } from "next/server";
import { errorResponse, fail, ok, requireAdmin } from "@/lib/auth";
import { getConfig } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QUOTA_PER_USD = 500000;
const NAC_PAGE_SIZE = 200; // naci 每页条数
const NAC_PAGE_DELAY_MS = 200; // 翻页节流
const BATCH_CHUNK = 40; // used-quota/status-batch 分块
const BATCH_DELAY_MS = 300;

const SITE_NAMES: Record<number, string> = { 6: "AC", 13: "AGT", 21: "61" };

function parsePriority(channelJson: unknown): number | null {
  if (typeof channelJson !== "string") return null;
  try {
    const inner = JSON.parse(channelJson);
    if (typeof inner?.priority === "number") return inner.priority;
  } catch { /* ignore */ }
  return null;
}

function parseStatusPage(data: unknown): Map<number, { sites: { site_id: number; status: number }[]; multiKeySize: number; aliveCount: number; deadCount: number }> {
  const out = new Map<number, { sites: { site_id: number; status: number }[]; multiKeySize: number; aliveCount: number; deadCount: number }>();
  if (!data || typeof data !== "object") return out;
  const map = data as Record<string, unknown>;
  for (const [idStr, entry] of Object.entries(map)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { sites?: unknown };
    const sites = Array.isArray(e.sites) ? e.sites : [];
    const siteList: { site_id: number; status: number }[] = [];
    let multiKeySize = 0;
    let minDeadOpen: number | null = null;
    let minDeadAny: number | null = null;
    for (const s of sites) {
      if (!s || typeof s !== "object") continue;
      const si = s as Record<string, unknown>;
      const st = typeof si.status === "number" ? si.status : null;
      const sid = typeof si.site_id === "number" ? si.site_id : null;
      if (sid != null && st != null) siteList.push({ site_id: sid, status: st });
      const info = si.channel_info as Record<string, unknown> | undefined;
      if (!info || typeof info !== "object") continue;
      if (!multiKeySize && typeof info.multi_key_size === "number") multiKeySize = info.multi_key_size;
      const list = info.multi_key_status_list;
      let deadOnSite: number | null = null;
      if (list && typeof list === "object") {
        deadOnSite = Object.values(list as Record<string, unknown>).map(x => Number(x)).filter(x => x === 3).length;
      } else if (typeof info.multi_key_size === "number") {
        deadOnSite = 0;
      }
      if (deadOnSite !== null) {
        if (minDeadAny === null) minDeadAny = deadOnSite; else minDeadAny = Math.min(minDeadAny, deadOnSite);
        if (st === 1) { if (minDeadOpen === null) minDeadOpen = deadOnSite; else minDeadOpen = Math.min(minDeadOpen, deadOnSite); }
      }
    }
    const dead = minDeadOpen ?? minDeadAny ?? 0;
    out.set(Number(idStr), { sites: siteList, multiKeySize, aliveCount: Math.max(0, multiKeySize - Math.min(multiKeySize, dead)), deadCount: Math.max(0, Math.min(multiKeySize, dead)) });
  }
  return out;
}

// GET /api/admin/channels/search?keyword=xxx
// 自动翻页拉全量 naci 结果，前端本地分页
export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);
    const { searchParams } = req.nextUrl;
    const keyword = (searchParams.get("keyword") || "").trim();
    if (!keyword) return fail("keyword 参数必填", 400);

    const cfg = await getConfig();
    const base = (cfg.naciBaseUrl || "").replace(/\/$/, "");
    const username = (cfg.naciUsername || "").trim();
    const password = cfg.naciPassword || "";
    if (!base || !username || !password) return fail("naci 凭据未配置", 500);

    // 登录
    const loginRes = await fetch(`${base}/api/user/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }), signal: AbortSignal.timeout(15000),
    });
    const loginJson = await loginRes.json().catch(() => null);
    if (!loginRes.ok || (loginJson && loginJson.success === false)) {
      return fail((loginJson && loginJson.message) || `naci 登录失败 HTTP ${loginRes.status}`, 502);
    }
    const sc = loginRes.headers.get("set-cookie") || "";
    const m = sc.match(/session=([^;]+)/);
    if (!m) return fail("naci 登录未返回 session", 502);
    const cookie = m[1];
    const headers = { Cookie: `session=${cookie}` };

    // 1. 翻页拉全量列表
    const rawItems: Record<string, unknown>[] = [];
    let page = 1;
    let total = 0;
    while (true) {
      const chRes = await fetch(
        `${base}/api/admin-hub/channels/?p=${page}&page_size=${NAC_PAGE_SIZE}&keyword=${encodeURIComponent(keyword)}`,
        { headers, signal: AbortSignal.timeout(30000) }
      );
      const chJson = await chRes.json();
      if (!chRes.ok || (chJson && chJson.success === false)) {
        return fail((chJson && chJson.message) || `naci 搜索失败 HTTP ${chRes.status}`, 502);
      }
      const data = chJson?.data || {};
      const items = Array.isArray(data.items) ? data.items : [];
      rawItems.push(...items);
      total = Number(data.total) || 0;
      if (rawItems.length >= total || items.length === 0) break;
      page += 1;
      await new Promise(r => setTimeout(r, NAC_PAGE_DELAY_MS));
    }

    const allIds: number[] = rawItems.map((item: Record<string, unknown>) => Number(item.id));

    // 2. 分块拉 used-quota + status-batch
    const usageMap = new Map<number, number>();
    const statusMap = new Map<number, { sites: { site_id: number; status: number }[]; multiKeySize: number; aliveCount: number; deadCount: number }>();

    for (let i = 0; i < allIds.length; i += BATCH_CHUNK) {
      const chunk = allIds.slice(i, i + BATCH_CHUNK);
      const hdr = { ...headers, "Content-Type": "application/json" };

      const [uRes, sRes] = await Promise.allSettled([
        fetch(`${base}/api/admin-hub/channels/used-quota`, { method: "POST", headers: hdr, body: JSON.stringify({ ids: chunk }), signal: AbortSignal.timeout(30000) }),
        fetch(`${base}/api/admin-hub/channels/status-batch`, { method: "POST", headers: hdr, body: JSON.stringify({ ids: chunk }), signal: AbortSignal.timeout(30000) }),
      ]);

      if (uRes.status === "fulfilled" && uRes.value.ok) {
        try {
          const uJson = await uRes.value.json();
          const uData = (uJson?.data || {}) as Record<string, { used_quota?: number }>;
          for (const id of chunk) {
            const entry = uData[String(id)];
            if (entry && typeof entry === "object") usageMap.set(id, Number(entry.used_quota) || 0);
          }
        } catch { /* best-effort */ }
      }
      if (sRes.status === "fulfilled" && sRes.value.ok) {
        try {
          const sJson = await sRes.value.json();
          for (const [id, st] of parseStatusPage(sJson?.data)) statusMap.set(id, st);
        } catch { /* best-effort */ }
      }

      if (i + BATCH_CHUNK < allIds.length) {
        await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
      }
    }

    // 3. 组装
    const items = rawItems.map((item: Record<string, unknown>) => {
      const id = Number(item.id);
      const usedQuota = usageMap.get(id) ?? (Number(item.used_quota) || 0);
      const st = statusMap.get(id);
      return {
        id, name: item.name,
        priority: parsePriority(item.channel_json),
        used_quota: usedQuota,
        used_amount: Math.round((usedQuota / QUOTA_PER_USD) * 100) / 100,
        created_at: item.created_at, updated_at: item.updated_at,
        sites: (st?.sites ?? []).map(s => ({ site_id: s.site_id, site_name: SITE_NAMES[s.site_id] ?? String(s.site_id), status: s.status })),
        multiKeySize: st?.multiKeySize ?? 0,
        aliveCount: st?.aliveCount ?? null as number | null,
        deadCount: st?.deadCount ?? null as number | null,
        hasStatus: !!st,
      };
    });

    return ok({ total, items });
  } catch (err) {
    return errorResponse(err);
  }
}
