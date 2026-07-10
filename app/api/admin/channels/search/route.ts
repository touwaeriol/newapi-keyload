import { NextRequest } from "next/server";
import { errorResponse, fail, ok, requireAdmin } from "@/lib/auth";
import { searchChannelsAll } from "@/lib/naci";
import { enrichChannelRows, MAX_ADMIN_SEARCH_RESULTS } from "@/lib/channelSearch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/admin/channels/search?keyword=xxx
// 拉全量 naci 结果（超过 MAX_ADMIN_SEARCH_RESULTS 报错要求细化关键词），前端本地分页。
export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);
    const keyword = (req.nextUrl.searchParams.get("keyword") || "").trim();
    if (!keyword) return fail("keyword 参数必填", 400);

    const { items, total } = await searchChannelsAll(keyword, MAX_ADMIN_SEARCH_RESULTS);
    const rows = await enrichChannelRows(items);
    return ok({ total, items: rows });
  } catch (err) {
    return errorResponse(err);
  }
}
