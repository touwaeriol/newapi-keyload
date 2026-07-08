import { NextRequest } from "next/server";
import { errorResponse, ok, requireAdmin } from "@/lib/auth";
import {
  effectiveUserLimit,
  GLOBAL_SCOPE,
  peekBucket,
  userScope,
} from "@/lib/rateLimit";
import { getConfig, getUsers } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/admin/upload-limit —— 上传限速实时状态：全局桶 + 各用户桶（滚动窗口用量）。
// 前端「上传限速状态」卡片 15s 轮询本接口。
export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);
    const cfg = await getConfig();

    const global = await peekBucket(
      GLOBAL_SCOPE,
      cfg.globalUploadLimitCount,
      cfg.globalUploadLimitWindowMinutes
    );

    const users = [];
    for (const u of await getUsers()) {
      const eff = effectiveUserLimit(u, cfg);
      const usage = await peekBucket(userScope(u.id), eff.limit, eff.windowMinutes);
      users.push({
        id: u.id,
        username: u.username,
        channelName: u.channelName,
        used: usage.used,
        limit: usage.limit,
        windowMinutes: usage.windowMinutes,
        unlimited: usage.unlimited,
        isOverride: eff.isOverride,
      });
    }

    return ok({ global, users });
  } catch (err) {
    return errorResponse(err);
  }
}
