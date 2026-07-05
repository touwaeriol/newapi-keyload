import { NextRequest } from "next/server";
import { errorResponse, fail, ok, requireAdmin } from "@/lib/auth";
import { findUserById } from "@/lib/store";
import { resolveMyChannel } from "@/lib/channelService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/admin/users/[id]/channel —— 管理员查看指定用户的绑定渠道状态。
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    await requireAdmin(req);
    const target = await findUserById(params.id);
    if (!target) return fail("用户不存在", 404);

    const channel = await resolveMyChannel(target);
    return ok({ channel });
  } catch (err) {
    return errorResponse(err);
  }
}
