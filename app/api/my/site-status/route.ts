import { NextRequest } from "next/server";
import { errorResponse, fail, ok, requireUser } from "@/lib/auth";
import { SITES } from "@/lib/supplier";
import { setMySiteStatus } from "@/lib/channelService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 允许透传的站点调度 status（前端语义：1=开启 / 3=自动禁用 / 0=关闭 / 2=手动禁用）。
const ALLOWED_STATUS = new Set([0, 1, 2, 3]);

// POST /api/my/site-status —— 调用者手动开/关自己绑定渠道某个站点的调度。
// body { siteId:number, status:number }；返回更新后的三站状态 sites。
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const body = (await req.json().catch(() => ({}))) as {
      siteId?: number;
      status?: number;
    };

    const siteId = Number(body.siteId);
    const status = Number(body.status);
    if (!SITES.some((s) => s.site_id === siteId)) {
      return fail("无效的站点 ID");
    }
    if (!ALLOWED_STATUS.has(status)) {
      return fail("无效的站点状态值");
    }

    // 只能操作调用者自己绑定的渠道；渠道未创建 → null
    const sites = await setMySiteStatus(user, siteId, status);
    if (!sites) return fail("渠道尚未创建，无法设置站点调度");

    return ok({ sites });
  } catch (err) {
    return errorResponse(err);
  }
}
