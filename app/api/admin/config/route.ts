import { NextRequest } from "next/server";
import { errorResponse, fail, ok, requireAdmin } from "@/lib/auth";
import { getConfig, saveConfig } from "@/lib/store";
import type { SystemConfig } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/admin/config —— 读取 naci 连接配置。
export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);
    const cfg = await getConfig();
    return ok({ naciBaseUrl: cfg.naciBaseUrl, naciToken: cfg.naciToken });
  } catch (err) {
    return errorResponse(err);
  }
}

// PUT /api/admin/config —— 保存 naci 连接配置。
export async function PUT(req: NextRequest) {
  try {
    await requireAdmin(req);
    const body = (await req.json().catch(() => ({}))) as Partial<SystemConfig>;
    const naciBaseUrl = (body.naciBaseUrl ?? "").trim();
    const naciToken = (body.naciToken ?? "").trim();
    if (!naciBaseUrl) return fail("naciBaseUrl 不能为空");
    await saveConfig({ naciBaseUrl, naciToken });
    return ok({ naciBaseUrl, naciToken });
  } catch (err) {
    return errorResponse(err);
  }
}
