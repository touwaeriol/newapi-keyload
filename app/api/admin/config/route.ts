import { NextRequest } from "next/server";
import { errorResponse, fail, ok, requireAdmin } from "@/lib/auth";
import { getConfig, saveConfig } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/admin/config —— 读取 naci 连接配置。
// 出于安全，密码与 token 均不回传明文，仅返回是否已设置（hasNaciPassword / hasNaciToken）。
export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);
    const cfg = await getConfig();
    return ok({
      naciBaseUrl: cfg.naciBaseUrl,
      naciUsername: cfg.naciUsername,
      hasNaciPassword: Boolean(cfg.naciPassword),
      hasNaciToken: Boolean(cfg.naciToken),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

// PUT /api/admin/config —— 保存 naci 连接配置。
// naciPassword / naciToken 留空表示保持原值不变（GET 不回传明文，前端读到空值不应清库）。
export async function PUT(req: NextRequest) {
  try {
    await requireAdmin(req);
    const body = (await req.json().catch(() => ({}))) as {
      naciBaseUrl?: string;
      naciUsername?: string;
      naciPassword?: string;
      naciToken?: string;
    };
    const naciBaseUrl = (body.naciBaseUrl ?? "").trim();
    if (!naciBaseUrl) return fail("naciBaseUrl 不能为空");

    const current = await getConfig();
    const naciUsername = (body.naciUsername ?? current.naciUsername ?? "").trim();
    const naciPassword =
      body.naciPassword && body.naciPassword.length > 0
        ? body.naciPassword
        : current.naciPassword ?? "";
    const naciToken =
      body.naciToken && body.naciToken.trim().length > 0
        ? body.naciToken.trim()
        : current.naciToken ?? "";

    await saveConfig({ naciBaseUrl, naciUsername, naciPassword, naciToken });
    return ok({
      naciBaseUrl,
      naciUsername,
      hasNaciPassword: Boolean(naciPassword),
      hasNaciToken: Boolean(naciToken),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
