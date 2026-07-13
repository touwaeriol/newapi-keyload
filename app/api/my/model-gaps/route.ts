import { NextRequest } from "next/server";
import { errorResponse, fail, ok, requireUser } from "@/lib/auth";
import { getModelGaps } from "@/lib/naci";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/my/model-gaps?site_id=13 —— 普通用户查看 naci 平台某站点的模型缺口（供需差）。
// 与 /api/admin/model-gaps 数据一致，仅鉴权放宽到 requireUser（平台级供需信息，非用户私密数据）。
export async function GET(req: NextRequest) {
  try {
    await requireUser(req);
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
