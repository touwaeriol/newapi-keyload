import { NextRequest } from "next/server";
import { errorResponse, fail, ok, requireAdmin } from "@/lib/auth";
import { demoteChannelManually } from "@/lib/channelService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/admin/channels/demote —— 管理员手动一键把任意已建渠道优先级回退到 5，
// 同步 naci 与本地记录（立即释放优先级 6 名额，不等定时任务）。
// body { channelId:number }；返回 { channelName, from, to }。
export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin(req);
    const body = (await req.json().catch(() => ({}))) as {
      channelId?: number;
    };
    const channelId = Number(body.channelId);
    if (!Number.isFinite(channelId) || channelId <= 0) {
      return fail("无效的渠道 ID");
    }

    const res = await demoteChannelManually(admin.username, channelId, null);
    if (!res) return fail("该渠道不在本系统记录中");
    return ok(res);
  } catch (err) {
    return errorResponse(err);
  }
}
