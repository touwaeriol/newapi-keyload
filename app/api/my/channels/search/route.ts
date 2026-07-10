import { NextRequest } from "next/server";
import { errorResponse, fail, ok, requireUser } from "@/lib/auth";
import { searchChannelsAll } from "@/lib/naci";
import {
  enrichChannelRows,
  MAX_USER_SEARCH_RESULTS,
  ownChannelNameFilter,
} from "@/lib/channelSearch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/my/channels/search?page=1&pageSize=50
// 普通用户查询自己前缀下的渠道。naci keyword 是子串匹配（前缀 LIU 会命中 LIU-B 的渠道），
// 因此拉全量后按整名正则精确过滤，再服务端分页；只对当前页补实时用量/状态。
export async function GET(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const prefix = user.channelName.trim();
    if (!prefix) return fail("当前用户未配置渠道前缀", 400);

    const { searchParams } = req.nextUrl;
    const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10) || 1);
    const pageSize = Math.min(
      200,
      Math.max(1, parseInt(searchParams.get("pageSize") || "50", 10) || 50)
    );

    const { items } = await searchChannelsAll(prefix, MAX_USER_SEARCH_RESULTS);
    const isOwn = ownChannelNameFilter(prefix);
    const mine = items.filter((i) => isOwn(i.name));

    const slice = mine.slice((page - 1) * pageSize, page * pageSize);
    const rows = await enrichChannelRows(slice);

    return ok({ page, pageSize, total: mine.length, items: rows });
  } catch (err) {
    return errorResponse(err);
  }
}
