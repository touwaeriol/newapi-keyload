import { NextRequest } from "next/server";
import { errorResponse, ok, requireUser } from "@/lib/auth";
import { createChannelFromNextBatch } from "@/lib/channelService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/my/create-batch —— 调用者从本地池取「下一批」（数量=管理员 uploadBatchSize）
// 新建一个 naci 渠道并发布（对应「我的渠道」卡顶部的「上传一批（新建渠道）」按钮）。
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const result = await createChannelFromNextBatch(user);
    return ok(result);
  } catch (err) {
    return errorResponse(err);
  }
}
