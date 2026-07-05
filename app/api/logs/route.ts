import { NextRequest } from "next/server";
import { errorResponse, ok, requireUser } from "@/lib/auth";
import { getLogs } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/logs —— admin 看全部；user 只看与自己 channelName 相关的日志。
export async function GET(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const all = await getLogs(); // 已按时间倒序存储

    const filtered =
      user.role === "admin"
        ? all
        : all.filter(
            (l) => user.channelName && l.channelName === user.channelName
          );

    const limitParam = Number(req.nextUrl.searchParams.get("limit"));
    const limit =
      Number.isFinite(limitParam) && limitParam > 0
        ? Math.min(limitParam, 500)
        : 100;

    return ok({ logs: filtered.slice(0, limit) });
  } catch (err) {
    return errorResponse(err);
  }
}
