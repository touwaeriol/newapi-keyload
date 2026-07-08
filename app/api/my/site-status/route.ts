import { NextRequest } from "next/server";
import { errorResponse, fail, ok, requireUser } from "@/lib/auth";
import { PUBLISH_SITES } from "@/lib/supplier";
import { setMySiteStatus } from "@/lib/channelService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 允许透传的站点调度 status（前端语义：1=开启 / 3=自动禁用 / 0=关闭 / 2=手动禁用）。
const ALLOWED_STATUS = new Set([0, 1, 2, 3]);

// POST /api/my/site-status —— 调用者手动开/关自己某个**已建渠道**某站点的调度。
// body { channelId:number, siteId:number, status:number }；返回更新后的站点状态 sites。
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const body = (await req.json().catch(() => ({}))) as {
      channelId?: number;
      siteId?: number;
      status?: number;
    };

    const channelId = Number(body.channelId);
    const siteId = Number(body.siteId);
    const status = Number(body.status);
    if (!Number.isFinite(channelId) || channelId <= 0) {
      return fail("无效的渠道 ID");
    }
    if (!PUBLISH_SITES.some((s) => s.site_id === siteId)) {
      return fail("无效的站点 ID");
    }
    if (!ALLOWED_STATUS.has(status)) {
      return fail("无效的站点状态值");
    }

    // 只能操作调用者自己前缀下的渠道；渠道不属于该前缀 → null
    const sites = await setMySiteStatus(user, channelId, siteId, status);
    if (!sites) return fail("渠道不存在或不属于当前用户");

    return ok({ sites });
  } catch (err) {
    return errorResponse(err);
  }
}
