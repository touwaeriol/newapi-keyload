import { NextRequest } from "next/server";
import { errorResponse, ok, requireUser } from "@/lib/auth";
import { syncPrefixUsage } from "@/lib/channelService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/my/sync-usage —— 手动同步当前用户所有已建渠道的最新用量（实时拉 used-quota、写回缓存）。
// 不受后台「自动最多刷 N 次」上限约束；带冷却，狂点会返回「同步过于频繁」。
// 返回 { channelCount, totalUsedQuota, totalUsedAmount }。
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const res = await syncPrefixUsage(user);
    return ok(res);
  } catch (err) {
    return errorResponse(err);
  }
}
