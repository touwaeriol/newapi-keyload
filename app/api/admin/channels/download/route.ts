import { NextRequest } from "next/server";
import { errorResponse, fail, requireAdmin } from "@/lib/auth";
import { searchChannelsAll } from "@/lib/naci";
import {
  channelRowsToCsv,
  channelRowsToXlsx,
  csvResponse,
  enrichChannelRows,
  MAX_ADMIN_SEARCH_RESULTS,
  xlsxResponse,
} from "@/lib/channelSearch";
import { updateReportProgress } from "@/lib/reportProgress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/admin/channels/download?keyword=xxx&job=<前端生成的进度id> —— 关键词命中渠道的 CSV 报表。
// 带 job 时把「拉列表/补用量」进度写进内存表，前端下载期间轮询 /api/report-progress 展示。
export async function GET(req: NextRequest) {
  try {
    const admin = await requireAdmin(req);
    const keyword = (req.nextUrl.searchParams.get("keyword") || "").trim();
    if (!keyword) return fail("keyword 参数必填", 400);
    const job = (req.nextUrl.searchParams.get("job") || "").trim().slice(0, 64);
    const track = (
      phase: "search" | "enrich" | "done",
      done: number,
      total: number
    ) => {
      if (job) updateReportProgress(job, admin.id, phase, done, total);
    };

    track("search", 0, 0);
    const { items } = await searchChannelsAll(
      keyword,
      MAX_ADMIN_SEARCH_RESULTS,
      (fetched, total) => track("search", fetched, total)
    );
    // 报表需要用量 + 状态（key数量列取聚合 key 数 multiKeySize）；用量读失败兜底列表自带值
    track("enrich", 0, items.length);
    const rows = await enrichChannelRows(items, {
      onProgress: (done, total) => track("enrich", done, total),
    });
    track("done", items.length, items.length);

    const dateStr = new Date().toISOString().slice(0, 10);
    const format = (req.nextUrl.searchParams.get("format") || "csv").toLowerCase();
    if (format === "xlsx") {
      return xlsxResponse(
        await channelRowsToXlsx(rows),
        `渠道报表_${keyword}_${dateStr}.xlsx`
      );
    }
    return csvResponse(channelRowsToCsv(rows), `渠道报表_${keyword}_${dateStr}.csv`);
  } catch (err) {
    return errorResponse(err);
  }
}
