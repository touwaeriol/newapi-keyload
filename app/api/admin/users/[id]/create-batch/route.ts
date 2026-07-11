import { NextRequest } from "next/server";
import {
  errorResponse,
  fail,
  ok,
  requireAdmin,
  uploadGloballyDisabled,
} from "@/lib/auth";
import { findUserById } from "@/lib/store";
import { createChannelFromNextBatch } from "@/lib/channelService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/admin/users/[id]/create-batch —— 管理员代指定用户从本地池取「下一批」
// 新建一个 naci 渠道并发布。
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    await requireAdmin(req);
    const blocked = await uploadGloballyDisabled();
    if (blocked) return blocked;
    const target = await findUserById(params.id);
    if (!target) return fail("用户不存在", 404);

    const result = await createChannelFromNextBatch(target);
    return ok(result);
  } catch (err) {
    return errorResponse(err);
  }
}
