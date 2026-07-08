import { NextRequest } from "next/server";
import { errorResponse, fail, ok, requireUser } from "@/lib/auth";
import { parseKeys } from "@/lib/supplier";
import { directUploadKeys } from "@/lib/channelService";
import { kickEngine } from "@/lib/engine";
import { getConfig } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/my/upload-direct —— 调用者为自己绑定的渠道「直接上传」key：
// 跳过定时队列，立即推送到站点（仍会先落本地库去重）。
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const body = (await req.json().catch(() => ({}))) as {
      keys?: string | string[];
    };
    const raw = Array.isArray(body.keys) ? body.keys.join("\n") : body.keys ?? "";
    const keys = parseKeys(raw);
    if (keys.length === 0) return fail("请提供至少一个 key");

    // 全局开关：禁止普通用户手动上传时，只允许「提交上传（录入本地库）」，此路由拒绝（管理员不受限）
    if (user.role !== "admin") {
      const cfg = await getConfig();
      if (!cfg.userManualUploadEnabled) {
        return fail("管理员已关闭手动上传，请改用「提交上传」录入本地库，系统会自动上传");
      }
    }

    const result = await directUploadKeys(user, keys);
    // 仅高优先级模式下直接上传只入池：kick 一次让定时任务尽快公平分配（kick 内部按模式走轮转）。
    if (result.waitingSlot) kickEngine(user.channelName);
    return ok(result);
  } catch (err) {
    return errorResponse(err);
  }
}
