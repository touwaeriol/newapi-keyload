import { NextRequest } from "next/server";
import {
  errorResponse,
  fail,
  ok,
  requireUser,
  uploadGloballyDisabled,
} from "@/lib/auth";
import { createChannelFromNextBatch } from "@/lib/channelService";
import { getConfig } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/my/create-batch —— 调用者从本地池取「下一批」（数量=管理员 uploadBatchSize）
// 新建一个 naci 渠道并发布（对应「我的渠道」卡顶部的「上传一批（新建渠道）」按钮）。
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const blocked = await uploadGloballyDisabled();
    if (blocked) return blocked;
    // 全局开关：禁止普通用户手动上传时，只允许录入本地库（管理员不受限）
    if (user.role !== "admin") {
      const cfg = await getConfig();
      if (!cfg.userManualUploadEnabled) {
        return fail("管理员已关闭手动上传，key 可正常录入本地库，将由系统自动上传");
      }
    }
    const result = await createChannelFromNextBatch(user);
    return ok(result);
  } catch (err) {
    return errorResponse(err);
  }
}
