import { NextRequest } from "next/server";
import { errorResponse, fail, ok, requireAdmin } from "@/lib/auth";
import { getConfig } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QUOTA_PER_USD = 500000;

/** 从 naci channel_json 字符串里解析 priority */
function parsePriority(channelJson: unknown): number | null {
  if (typeof channelJson !== "string") return null;
  try {
    const inner = JSON.parse(channelJson);
    if (typeof inner?.priority === "number") return inner.priority;
  } catch { /* ignore */ }
  return null;
}

// GET /api/admin/channels/search?keyword=xxx&page=1&pageSize=50
export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);
    const { searchParams } = req.nextUrl;
    const keyword = (searchParams.get("keyword") || "").trim();
    if (!keyword) return fail("keyword 参数必填", 400);

    const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(searchParams.get("pageSize") || "50", 10) || 50));

    // 读凭据
    const cfg = await getConfig();
    const base = (cfg.naciBaseUrl || "").replace(/\/$/, "");
    const username = (cfg.naciUsername || "").trim();
    const password = cfg.naciPassword || "";
    if (!base || !username || !password) {
      return fail("naci 凭据未配置", 500);
    }

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

    // 搜索
    const chRes = await fetch(
      `${base}/api/admin-hub/channels/?p=${page}&page_size=${pageSize}&keyword=${encodeURIComponent(keyword)}`,
      {
        headers: { Cookie: `session=${cookie}` },
        signal: AbortSignal.timeout(30000),
      }
    );
    const chJson = await chRes.json();
    if (!chRes.ok || (chJson && chJson.success === false)) {
      return fail((chJson && chJson.message) || `naci 搜索失败 HTTP ${chRes.status}`, 502);
    }

    const data = chJson?.data || {};
    const items = (Array.isArray(data.items) ? data.items : []).map((item: Record<string, unknown>) => {
      const usedQuota = Number(item.used_quota) || 0;
      return {
        id: item.id,
        name: item.name,
        priority: parsePriority(item.channel_json),
        used_quota: usedQuota,
        used_amount: Math.round((usedQuota / QUOTA_PER_USD) * 100) / 100,
        created_at: item.created_at,
        updated_at: item.updated_at,
      };
    });

    return ok({
      page: Number(data.page) || page,
      pageSize: Number(data.page_size) || pageSize,
      total: Number(data.total) || 0,
      items,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
