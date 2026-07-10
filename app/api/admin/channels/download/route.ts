import { NextRequest } from "next/server";
import { errorResponse, fail, requireAdmin } from "@/lib/auth";
import { getConfig } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QUOTA_PER_USD = 500000;
const CHUNK_SIZE = 40;
const CHUNK_DELAY_MS = 300;
const PAGE_DELAY_MS = 200;

function parsePriority(channelJson: unknown): number | null {
  if (typeof channelJson !== "string") return null;
  try {
    const inner = JSON.parse(channelJson);
    if (typeof inner?.priority === "number") return inner.priority;
  } catch { /* ignore */ }
  return null;
}

function escapeCsvField(v: string | number | null): string {
  if (v == null) return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// GET /api/admin/channels/download?keyword=xxx
export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);
    const { searchParams } = req.nextUrl;
    const keyword = (searchParams.get("keyword") || "").trim();
    if (!keyword) return fail("keyword 参数必填", 400);

    // 读凭据
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

    // 1. 翻页搜全量（同时记下列表自带的 used_quota 作为兜底）
    const allItems: { id: number; name: string; priority: number | null; listQuota: number; created_at: string }[] = [];
    let page = 1;
    let total = 0;
    while (true) {
      const chRes = await fetch(
        `${base}/api/admin-hub/channels/?p=${page}&page_size=500&keyword=${encodeURIComponent(keyword)}`,
        { headers, signal: AbortSignal.timeout(30000) }
      );
      const chJson = await chRes.json();
      if (!chRes.ok || (chJson && chJson.success === false)) {
        return fail((chJson && chJson.message) || `naci 搜索失败 HTTP ${chRes.status}`, 502);
      }
      const data = chJson?.data || {};
      const items = Array.isArray(data.items) ? data.items : [];
      for (const item of items) {
        allItems.push({
          id: Number(item.id),
          name: String(item.name || ""),
          priority: parsePriority(item.channel_json),
          listQuota: Number(item.used_quota) || 0,
          created_at: String(item.created_at || ""),
        });
      }
      total = Number(data.total) || 0;
      if (allItems.length >= total || items.length === 0) break;
      page += 1;
      await new Promise(r => setTimeout(r, PAGE_DELAY_MS));
    }

    // 2. 分块拉 used-quota（失败重试 1 次；以 live 值为准，兜底用列表自带值）
    const ids = allItems.map(i => i.id);
    const usageMap = new Map<number, number>();
    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      const chunk = ids.slice(i, i + CHUNK_SIZE);
      let ok = false;
      for (let attempt = 0; attempt < 2 && !ok; attempt++) {
        try {
          const uRes = await fetch(`${base}/api/admin-hub/channels/used-quota`, {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ ids: chunk }),
            signal: AbortSignal.timeout(30000),
          });
          const uJson = await uRes.json();
          const uData = (uJson?.data || {}) as Record<string, { used_quota?: number }>;
          for (const id of chunk) {
            const entry = uData[String(id)];
            if (entry && typeof entry === "object") {
              usageMap.set(id, Number(entry.used_quota) || 0);
            }
          }
          ok = true;
        } catch {
          if (attempt === 0) await new Promise(r => setTimeout(r, 2000)); // 等 2s 重试
        }
      }
      if (i + CHUNK_SIZE < ids.length) {
        await new Promise(r => setTimeout(r, CHUNK_DELAY_MS));
      }
    }

    // 3. 生成 CSV（UTF-8 BOM）：优先 live 值，兜底列表自带值
    const dateStr = new Date().toISOString().slice(0, 10);
    const rows: string[] = [];
    rows.push("naci_id,渠道名,优先级,used_quota,金额USD,创建时间");
    for (const item of allItems) {
      const q = usageMap.get(item.id) ?? item.listQuota;
      rows.push([
        item.id,
        escapeCsvField(item.name),
        item.priority ?? "",
        q,
        (q / QUOTA_PER_USD).toFixed(2),
        escapeCsvField(item.created_at),
      ].join(","));
    }
    const bom = "﻿";
    const csv = bom + rows.join("\n");
    const filename = `渠道报表_${keyword}_${dateStr}.csv`;

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
