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
import { updateReportProgress } from "@/lib/reportProgress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/my/channels/download?job=<前端生成的进度id> —— 当前用户前缀下所有渠道的 CSV 报表
//（与搜索同样按整名正则精确过滤，防止 naci 子串匹配带出别的用户的渠道）
// 限流：每用户每 userReportIntervalMinutes 分钟最多一次（Redis 桶，管理员可配），超频 429。
// 带 job 时把「拉列表/补用量」进度写进内存表，前端下载期间轮询 /api/report-progress 展示。
export async function GET(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const prefix = user.channelName.trim();
    if (!prefix) return fail("当前用户未配置渠道前缀", 400);
    const job = (req.nextUrl.searchParams.get("job") || "").trim().slice(0, 64);
    const track = (
      phase: "search" | "enrich" | "done",
      done: number,
      total: number
    ) => {
      if (job) updateReportProgress(job, user.id, phase, done, total);
    };

    const cfg = await getConfig();
    const gate = await acquireUserReportSlot(
      user.id,
      cfg.userReportIntervalMinutes
    );
    if (!gate.ok) return fail(gate.message, 429);

    try {
      track("search", 0, 0);
      const { items } = await searchChannelsAll(
        prefix,
        MAX_USER_SEARCH_RESULTS,
        (fetched, total) => track("search", fetched, total)
      );
      const isOwn = ownChannelNameFilter(prefix);
      const mine = items.filter((i) => isOwn(i.name));

      // 报表需要用量 + 状态（key数量列取聚合 key 数 multiKeySize）；用量读失败兜底列表自带值
      track("enrich", 0, mine.length);
      const rows = await enrichChannelRows(mine, {
        onProgress: (done, total) => track("enrich", done, total),
      });
      track("done", mine.length, mine.length);

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
