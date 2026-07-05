import { NextRequest } from "next/server";
import { errorResponse, ok, requireAdmin } from "@/lib/auth";
import { ping } from "@/lib/naci";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/ping —— 管理员测试 naci 连通性。
export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);
    const result = await ping();
    return ok({ total: result.total });
  } catch (err) {
    return errorResponse(err);
  }
}
