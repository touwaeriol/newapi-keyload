import { NextRequest } from "next/server";
import { errorResponse, fail, ok, requireAdmin } from "@/lib/auth";
import { getConfig, saveConfig } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/admin/config —— 读取 naci 连接配置。
// 出于安全，密码不回传明文，仅返回是否已设置（hasNaciPassword）。
export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);
    const cfg = await getConfig();
    return ok({
      naciBaseUrl: cfg.naciBaseUrl,
      naciUsername: cfg.naciUsername,
      hasNaciPassword: Boolean(
        process.env.NACI_PASSWORD || cfg.naciPassword
      ),
      naciToken: cfg.naciToken ?? "",
    });
  } catch (err) {
    return errorResponse(err);
  }
}

// PUT /api/admin/config —— 保存 naci 连接配置。
// naciPassword 留空表示保持原密码不变（避免前端把掩码写回清空真实密码）。
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
    const naciToken = (body.naciToken ?? current.naciToken ?? "").trim();
    const naciPassword =
      body.naciPassword && body.naciPassword.length > 0
        ? body.naciPassword
        : current.naciPassword ?? "";

    await saveConfig({ naciBaseUrl, naciUsername, naciPassword, naciToken });
    return ok({
      naciBaseUrl,
      naciUsername,
      hasNaciPassword: Boolean(process.env.NACI_PASSWORD || naciPassword),
      naciToken,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
