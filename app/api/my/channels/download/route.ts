import { NextRequest } from "next/server";
import { errorResponse, fail, requireUser } from "@/lib/auth";
import { getConfig } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QUOTA_PER_USD = 500000;
const CHUNK_SIZE = 40;
const CHUNK_DELAY_MS = 300;
const PAGE_DELAY_MS = 200;

function parsePriority(channelJson: unknown): number | null {
  if (typeof channelJson !== "string") return null;
  try { const inner = JSON.parse(channelJson); if (typeof inner?.priority === "number") return inner.priority; } catch { /* ignore */ }
  return null;
}

function escapeCsvField(v: string | number | null): string {
  if (v == null) return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// GET /api/my/channels/download —— 下载当前用户前缀下所有渠道的 CSV 报表
export async function GET(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const prefix = user.channelName.trim();
    if (!prefix) return fail("当前用户未配置渠道前缀", 400);

    const cfg = await getConfig();
    const base = (cfg.naciBaseUrl || "").replace(/\/$/, "");
    const username = (cfg.naciUsername || "").trim();
    const password = cfg.naciPassword || "";
    if (!base || !username || !password) return fail("naci 凭据未配置", 500);

    // 登录
    const loginRes = await fetch(`${base}/api/user/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(15000),
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

    const keyword = prefix;

    // 1. 翻页搜全量
    const allItems: { id: number; name: string; priority: number | null; created_at: string }[] = [];
    let page = 1;
    let total = 0;
    while (true) {
      const chRes = await fetch(
        `${base}/api/admin-hub/channels/?p=${page}&page_size=200&keyword=${encodeURIComponent(keyword)}`,
        { headers, signal: AbortSignal.timeout(30000) }
      );
      const chJson = await chRes.json();
      if (!chRes.ok || (chJson && chJson.success === false)) {
        return fail((chJson && chJson.message) || `naci 搜索失败 HTTP ${chRes.status}`, 502);
      }
      const data = chJson?.data || {};
      const items = Array.isArray(data.items) ? data.items : [];
      for (const item of items) {
        allItems.push({ id: Number(item.id), name: String(item.name || ""), priority: parsePriority(item.channel_json), created_at: String(item.created_at || "") });
      }
      total = Number(data.total) || 0;
      if (allItems.length >= total || items.length === 0) break;
      page += 1;
      await new Promise(r => setTimeout(r, PAGE_DELAY_MS));
    }

    // 2. 分块拉 used-quota
    const ids = allItems.map(i => i.id);
    const usageMap = new Map<number, number>();
    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      const chunk = ids.slice(i, i + CHUNK_SIZE);
      try {
        const uRes = await fetch(`${base}/api/admin-hub/channels/used-quota`, {
          method: "POST", headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ ids: chunk }), signal: AbortSignal.timeout(30000),
        });
        const uJson = await uRes.json();
        const uData = (uJson?.data || {}) as Record<string, { used_quota?: number }>;
        for (const id of chunk) {
          const entry = uData[String(id)];
          if (entry && typeof entry === "object") usageMap.set(id, Number(entry.used_quota) || 0);
        }
      } catch { /* best-effort */ }
      if (i + CHUNK_SIZE < ids.length) await new Promise(r => setTimeout(r, CHUNK_DELAY_MS));
    }

    // 3. CSV
    const dateStr = new Date().toISOString().slice(0, 10);
    const rows: string[] = [];
    rows.push("naci_id,渠道名,优先级,used_quota,金额USD,创建时间");
    for (const item of allItems) {
      const q = usageMap.get(item.id) ?? 0;
      rows.push([item.id, escapeCsvField(item.name), item.priority ?? "", q, (q / QUOTA_PER_USD).toFixed(2), escapeCsvField(item.created_at)].join(","));
    }
    const csv = "﻿" + rows.join("\n");
    const filename = `渠道报表_${prefix}_${dateStr}.csv`;

    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
