import { NextRequest } from "next/server";
import { errorResponse, ok, requireAdmin } from "@/lib/auth";
import {
  effectiveUserLimit,
  GLOBAL_SCOPE,
  peekBucket,
  userScope,
} from "@/lib/rateLimit";
import {
  countChannelsAtPriority,
  countChannelsAtPriorityForPrefix,
  getConfig,
  getUsers,
} from "@/lib/store";
import { FIXED_PRIORITY } from "@/lib/supplier";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/admin/upload-limit —— 上传限速 + 高优先级配额实时状态：
// 全局桶 / 各用户桶滚动窗口用量，以及全局/各用户的优先级6渠道已用与上限。
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
    // 高优先级(优先级6)配额：全局已用/上限
    const highPriorityGlobal = {
      used: await countChannelsAtPriority(FIXED_PRIORITY),
      limit: cfg.priority6Limit,
    };

    const users = [];
    for (const u of await getUsers()) {
      const eff = effectiveUserLimit(u, cfg);
      const usage = await peekBucket(userScope(u.id), eff.limit, eff.windowMinutes);
      const hpUsed = u.channelName
        ? await countChannelsAtPriorityForPrefix(u.channelName.trim(), FIXED_PRIORITY)
        : 0;
      users.push({
        id: u.id,
        username: u.username,
        channelName: u.channelName,
        used: usage.used,
        limit: usage.limit,
        windowMinutes: usage.windowMinutes,
        unlimited: usage.unlimited,
        isOverride: eff.isOverride,
        // 高优先级配额
        hpAllowed: u.allowHighPriority !== false,
        hpUsed,
        hpLimit: u.highPriorityLimit ?? null,
      });
    }

    return ok({ global, highPriorityGlobal, users });
  } catch (err) {
    return errorResponse(err);
  }
}
