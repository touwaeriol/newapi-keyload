"use client";

// 管理员「渠道管理」卡：关键词搜索 naci 渠道（后端拉全量，前端本地分页）+ CSV 报表下载。
import { useState, useCallback, useMemo } from "react";
import { apiFetch, getStoredKey } from "@/lib/client";
import { useToast } from "@/components/Toast";
import { Button, Card, Spinner, TextInput } from "@/components/ui";
import {
  ChannelTable,
  downloadButtonLabel,
  fmtUsd,
  newReportJobId,
  Pager,
  useElapsedSeconds,
  useReportProgress,
  type ChannelItem,
} from "@/components/ChannelTable";

const CLIENT_PAGE_SIZE = 100;

interface SearchResult {
  total: number;
  items: ChannelItem[];
}

export function AdminChannelCard() {
  const t = useToast();
  const [keyword, setKeyword] = useState("");
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadJob, setDownloadJob] = useState<string | null>(null);
  const [dlFmt, setDlFmt] = useState<"csv" | "xlsx" | null>(null);
  const [allItems, setAllItems] = useState<ChannelItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);

  const search = useCallback(async () => {
    const kw = keyword.trim();
    if (!kw) return;
    setLoading(true);
    try {
      const data = await apiFetch<SearchResult>(
        `/api/admin/channels/search?keyword=${encodeURIComponent(kw)}`
      );
      setAllItems(data.items);
      setTotal(data.total);
      setPage(1);
    } catch (err) {
      t.error(`搜索失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [keyword, t]);

  const download = useCallback(async (format: "csv" | "xlsx") => {
    const kw = keyword.trim();
    if (!kw) return;
    const job = newReportJobId();
    setDownloadJob(job);
    setDlFmt(format);
    setDownloading(true);
    try {
      const key = getStoredKey();
      const res = await fetch(
        `/api/admin/channels/download?keyword=${encodeURIComponent(kw)}&job=${job}&format=${format}`,
        { headers: key ? { "x-access-key": key } : {} }
      );
      if (!res.ok) {
        // 非 200 时后端返回 JSON {message}，解析后提示（401/429/500 等）
        let msg = `下载失败 (HTTP ${res.status})`;
        try {
          const j = (await res.json()) as { message?: string };
          if (j?.message) msg = j.message;
        } catch {
          /* 非 JSON 响应用兜底文案 */
        }
        t.error(msg);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `渠道报表_${kw}_${new Date().toISOString().slice(0, 10)}.${format}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      t.success("报表已生成并开始下载");
    } catch (err) {
      t.error(`下载失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDownloading(false);
      setDownloadJob(null);
      setDlFmt(null);
    }
  }, [keyword, t]);

  const totalPages = Math.ceil(total / CLIENT_PAGE_SIZE);
  const downloadSec = useElapsedSeconds(downloading);
  const downloadProgress = useReportProgress(downloadJob);
  const pageItems = useMemo(
    () => allItems.slice((page - 1) * CLIENT_PAGE_SIZE, page * CLIENT_PAGE_SIZE),
    [allItems, page]
  );
  // 金额总额：对全部搜索结果（非当前页）的原始额度求和，再统一换算美元
  const totalUsd = useMemo(
    () => allItems.reduce((sum, c) => sum + (c.used_quota || 0), 0),
    [allItems]
  );
  // Key 聚合统计：一个渠道可聚合多个 apikey，合计 = 各渠道 multiKeySize 之和；
  // 仅统计已拉到 key 状态的渠道，未拉到的单列「状态未知」（与 CSV/Excel 报表合计口径一致）。
  const keyStats = useMemo(() => {
    let keys = 0;
    let alive = 0;
    let dead = 0;
    let knownChannels = 0;
    let unknownChannels = 0;
    for (const c of allItems) {
      if (c.hasStatus && c.multiKeySize > 0) {
        keys += c.multiKeySize;
        alive += c.aliveCount ?? 0;
        dead += c.deadCount ?? 0;
        knownChannels += 1;
      } else {
        unknownChannels += 1;
      }
    }
    return { keys, alive, dead, knownChannels, unknownChannels };
  }, [allItems]);

  return (
    <Card
      title="📊 渠道管理"
      subtitle="搜索 naci 平台渠道（拉全量后本地分页），实时用量 + 站点/key状态"
      actions={
        <div className="flex items-center gap-2">
          <TextInput
            placeholder="输入渠道名关键词搜索"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") search();
            }}
            className="w-64"
          />
          <Button onClick={search} loading={loading}>
            🔍 搜索
          </Button>
          {total > 0 && (
            <>
              <Button
                variant="secondary"
                onClick={() => download("csv")}
                loading={dlFmt === "csv"}
                disabled={downloading}
                title="下载 CSV 报表（UTF-8 BOM，Excel 可直接打开）"
              >
                {dlFmt === "csv"
                  ? downloadButtonLabel(true, downloadSec, downloadProgress)
                  : "📥 CSV"}
              </Button>
              <Button
                variant="secondary"
                onClick={() => download("xlsx")}
                loading={dlFmt === "xlsx"}
                disabled={downloading}
                title="下载 Excel(.xlsx) 报表"
              >
                {dlFmt === "xlsx"
                  ? downloadButtonLabel(true, downloadSec, downloadProgress)
                  : "📊 Excel"}
              </Button>
            </>
          )}
        </div>
      }
    >
      {allItems.length === 0 && !loading && (
        <p className="py-8 text-center text-sm text-slate-400">
          输入渠道名关键词（如 07-09-ANTH-LIU-B）点击搜索
        </p>
      )}

      {loading && (
        <div className="flex items-center justify-center gap-2 py-8 text-slate-400">
          <Spinner /> <span className="text-sm">搜索 + 拉取用量和状态中…</span>
        </div>
      )}

      {allItems.length > 0 && !loading && (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
            <span>
              共 {total.toLocaleString()} 条，第 {page}/{totalPages} 页（每页{" "}
              {CLIENT_PAGE_SIZE} 条）
            </span>
            <span className="text-slate-300">·</span>
            <span className="font-semibold text-emerald-700">
              金额合计 {fmtUsd(totalUsd)}
            </span>
            <span className="text-slate-300">·</span>
            <span
              className="font-semibold text-brand-700"
              title="Key 列为聚合 key：一个渠道可聚合多个 apikey。合计 = 各渠道聚合 key 数之和；未拉到状态的渠道计为「状态未知」，不计入合计。"
            >
              Key 合计 {keyStats.keys.toLocaleString()} 个
              <span className="font-normal text-slate-500">
                （{keyStats.knownChannels.toLocaleString()} 渠道聚合
                {keyStats.unknownChannels > 0
                  ? `，另 ${keyStats.unknownChannels.toLocaleString()} 渠道状态未知`
                  : ""}
                ，存活 {keyStats.alive.toLocaleString()} / 失效{" "}
                {keyStats.dead.toLocaleString()}）
              </span>
            </span>
          </div>
          <ChannelTable items={pageItems} />
          <Pager page={page} totalPages={totalPages} onPage={setPage} />
        </>
      )}
    </Card>
  );
}
