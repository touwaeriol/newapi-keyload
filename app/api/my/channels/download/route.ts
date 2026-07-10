import { NextRequest } from "next/server";
import { errorResponse, fail, requireUser } from "@/lib/auth";
import { searchChannelsAll } from "@/lib/naci";
import { getConfig } from "@/lib/store";
import {
  acquireUserReportSlot,
  channelRowsToCsv,
  csvResponse,
  enrichChannelRows,
  MAX_USER_SEARCH_RESULTS,
  ownChannelNameFilter,
} from "@/lib/channelSearch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/my/channels/download —— 当前用户前缀下所有渠道的 CSV 报表
//（与搜索同样按整名正则精确过滤，防止 naci 子串匹配带出别的用户的渠道）
// 限流：每用户每 userReportIntervalMinutes 分钟最多一次（Redis 桶，管理员可配），超频 429。
export async function GET(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const prefix = user.channelName.trim();
    if (!prefix) return fail("当前用户未配置渠道前缀", 400);

    const cfg = await getConfig();
    const gate = await acquireUserReportSlot(
      user.id,
      cfg.userReportIntervalMinutes
    );
    if (!gate.ok) return fail(gate.message, 429);

    try {
      const { items } = await searchChannelsAll(prefix, MAX_USER_SEARCH_RESULTS);
      const isOwn = ownChannelNameFilter(prefix);
      const mine = items.filter((i) => isOwn(i.name));

      // 报表需要用量 + 状态（key数量列取聚合 key 数 multiKeySize）；用量读失败兜底列表自带值
      const rows = await enrichChannelRows(mine);

      const dateStr = new Date().toISOString().slice(0, 10);
      return csvResponse(channelRowsToCsv(rows), `渠道报表_${prefix}_${dateStr}.csv`);
    } catch (err) {
      // naci 侧失败不该烧掉这一格额度：退还后再抛，让用户可立即重试
      await gate.rollback();
      throw err;
    }
  } catch (err) {
    return errorResponse(err);
  }
}
