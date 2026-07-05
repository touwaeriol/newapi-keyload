import { NextRequest } from "next/server";
import { errorResponse, ok, requireUser } from "@/lib/auth";
import { resolveMyChannel } from "@/lib/channelService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/my/channel —— 返回调用者绑定渠道的详情；未创建返回 exists:false。
export async function GET(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const channel = await resolveMyChannel(user);
    return ok({ channel });
  } catch (err) {
    return errorResponse(err);
  }
}
