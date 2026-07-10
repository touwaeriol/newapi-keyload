import { NextRequest } from "next/server";
import { errorResponse, fail, requireAdmin } from "@/lib/auth";
import { searchChannelsAll } from "@/lib/naci";
import {
  channelRowsToCsv,
  csvResponse,
  enrichChannelRows,
  MAX_ADMIN_SEARCH_RESULTS,
} from "@/lib/channelSearch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/admin/channels/download?keyword=xxx —— 关键词命中渠道的 CSV 报表
export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);
    const keyword = (req.nextUrl.searchParams.get("keyword") || "").trim();
    if (!keyword) return fail("keyword 参数必填", 400);

    const { items } = await searchChannelsAll(keyword, MAX_ADMIN_SEARCH_RESULTS);
    // 报表需要用量 + 状态（key数量列取聚合 key 数 multiKeySize）；用量读失败兜底列表自带值
    const rows = await enrichChannelRows(items);

    const dateStr = new Date().toISOString().slice(0, 10);
    return csvResponse(channelRowsToCsv(rows), `渠道报表_${keyword}_${dateStr}.csv`);
  } catch (err) {
    return errorResponse(err);
  }
}
