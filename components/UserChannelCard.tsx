"use client";

// 用户「渠道列表」卡：按自己前缀查询 naci 渠道（服务端精确过滤+分页），实时用量与状态。
// 查询/报表均有服务端限流（默认查询 3s 一次、报表 3 分钟一次），超频 429 直接 toast 提示。
import { useState, useEffect, useCallback } from "react";
import { apiFetch, getStoredKey } from "@/lib/client";
import { useToast } from "@/components/Toast";
import { Button, Card, Spinner } from "@/components/ui";
import {
  ChannelTable,
  downloadButtonLabel,
  newReportJobId,
  Pager,
  useElapsedSeconds,
  useReportProgress,
  type ChannelItem,
} from "@/components/ChannelTable";
import type { SafeUser } from "@/lib/types";

const PAGE_SIZE = 100;

interface SearchResult {
  page: number;
  pageSize: number;
  total: number;
  items: ChannelItem[];
}

export function UserChannelCard({ user }: { user: SafeUser }) {
  const t = useToast();
  const prefix = user.channelName.trim();
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadJob, setDownloadJob] = useState<string | null>(null);
  const [result, setResult] = useState<SearchResult | null>(null);

  const search = useCallback(
    async (page: number) => {
      if (!prefix) return;
      setLoading(true);
      try {
        const data = await apiFetch<SearchResult>(
          `/api/my/channels/search?page=${page}&pageSize=${PAGE_SIZE}`
        );
        setResult(data);
      } catch (err) {
        t.error(`搜索失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setLoading(false);
      }
    },
    [prefix, t]
  );

  const download = useCallback(async () => {
    if (!prefix) return;
    const job = newReportJobId();
    setDownloadJob(job);
    setDownloading(true);
    try {
      const key = getStoredKey();
      const res = await fetch(`/api/my/channels/download?job=${job}`, {
        headers: key ? { "x-access-key": key } : {},
      });
      if (!res.ok) {
        // 非 200 时后端返回 JSON {message}（429 限流 / 401 等），解析后提示
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
      a.download = `渠道报表_${prefix}_${new Date().toISOString().slice(0, 10)}.csv`;
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
    }
  }, [prefix, t]);

  // 自动首次加载
  useEffect(() => {
    search(1);
  }, [search]);

  const totalPages = result ? Math.ceil(result.total / result.pageSize) : 0;
  const downloadSec = useElapsedSeconds(downloading);
  const downloadProgress = useReportProgress(downloadJob);

  if (!prefix) {
    return (
      <Card title="📊 渠道列表" subtitle="naci 平台渠道实时用量与状态">
        <p className="py-6 text-center text-sm text-slate-400">
          当前用户未配置渠道前缀，无法查询渠道
        </p>
      </Card>
    );
  }

  return (
    <Card
      title="📊 渠道列表"
      subtitle={`前缀 "${prefix}" — naci 实时用量与站点/key状态`}
      actions={
        <Button
          variant="secondary"
          onClick={download}
          loading={downloading}
          title="生成 CSV 报表：服务端逐块拉取全部渠道的实时用量与 key 状态，渠道多时需要几十秒"
        >
          {downloadButtonLabel(downloading, downloadSec, downloadProgress)}
        </Button>
      }
    >
      {loading && !result && (
        <div className="flex items-center justify-center gap-2 py-8 text-slate-400">
          <Spinner /> <span className="text-sm">加载中…</span>
        </div>
      )}

      {result && (
        <>
          <div className="mb-2 flex items-center justify-between text-xs text-slate-500">
            <span>
              共 {result.total.toLocaleString()} 条（每页 {result.pageSize} 条）
            </span>
            <button
              onClick={() => search(result.page)}
              className="text-brand-600 hover:underline"
              disabled={loading}
            >
              {loading ? "刷新中…" : "🔄 刷新"}
            </button>
          </div>
          <ChannelTable items={result.items} />
          <Pager
            page={result.page}
            totalPages={totalPages}
            onPage={(p) => search(p)}
            disabled={loading}
          />
        </>
      )}
    </Card>
  );
}
