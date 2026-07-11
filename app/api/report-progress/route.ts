import { NextRequest } from "next/server";
import { errorResponse, fail, ok, requireUser } from "@/lib/auth";
import { getReportProgress } from "@/lib/reportProgress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/report-progress?job=xxx —— 报表生成进度轮询（管理员/用户下载报表期间前端每秒查一次）。
// 只能读到自己创建的 job；job 还没上报（下载请求尚未到达服务器）返回 pending。
export async function GET(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const job = (req.nextUrl.searchParams.get("job") || "").trim();
    if (!job) return fail("job 参数必填", 400);
    const p = getReportProgress(job, user.id);
    return ok(p ?? { phase: "pending", done: 0, total: 0 });
  } catch (err) {
    return errorResponse(err);
  }
}
