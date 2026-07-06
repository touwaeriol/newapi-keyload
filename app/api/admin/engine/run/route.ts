import { NextRequest } from "next/server";
import { errorResponse, ok, requireAdmin } from "@/lib/auth";
import { tick } from "@/lib/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/admin/engine/run —— 管理员手动触发一次定时引擎调度（方便测试，不必等 60s）。
export async function POST(req: NextRequest) {
  try {
    await requireAdmin(req);
    await tick();
    return ok({ triggered: true });
  } catch (err) {
    return errorResponse(err);
  }
}
