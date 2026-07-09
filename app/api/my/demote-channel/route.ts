import { NextRequest } from "next/server";
import { errorResponse, fail, ok, requireUser } from "@/lib/auth";
import { demoteChannelManually } from "@/lib/channelService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/my/demote-channel —— 手动一键把自己某个已建渠道优先级回退到 5，
// 同步 naci 与本地记录（立即释放优先级 6 名额，不等定时任务）。
// body { channelId:number }；返回 { channelName, from, to }。
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const body = (await req.json().catch(() => ({}))) as {
      channelId?: number;
    };
    const channelId = Number(body.channelId);
    if (!Number.isFinite(channelId) || channelId <= 0) {
      return fail("无效的渠道 ID");
    }

    const res = await demoteChannelManually(
      user.username,
      channelId,
      user.channelName
    );
    if (!res) return fail("渠道不存在或不属于当前用户");
    return ok(res);
  } catch (err) {
    return errorResponse(err);
  }
}
