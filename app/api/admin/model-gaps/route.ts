import { NextRequest } from "next/server";
import { errorResponse, fail, ok, requireAdmin } from "@/lib/auth";
import { getModelGaps } from "@/lib/naci";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/admin/model-gaps?site_id=6 —— 查询 naci 平台某站点的模型缺口（供需差）。
// 仅 nci/naci 平台有效。
export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);
    const raw = req.nextUrl.searchParams.get("site_id") ?? "";
    const siteId = Number(raw);
    if (!Number.isFinite(siteId) || siteId <= 0) {
      return fail("site_id 须为大于 0 的整数", 400);
    }
    const gaps = await getModelGaps(siteId);
    return ok(gaps);
  } catch (err) {
    return errorResponse(err);
  }
}
