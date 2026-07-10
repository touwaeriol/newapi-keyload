"use client";

// 管理员「渠道管理」卡：关键词搜索 naci 渠道（后端拉全量，前端本地分页）+ CSV 报表下载。
import { useState, useCallback, useMemo } from "react";
import { apiFetch, getStoredKey } from "@/lib/client";
import { useToast } from "@/components/Toast";
import { Button, Card, Spinner, TextInput } from "@/components/ui";
import {
  ChannelTable,
  downloadButtonLabel,
  Pager,
  useElapsedSeconds,
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

  const download = useCallback(async () => {
    const kw = keyword.trim();
    if (!kw) return;
    setDownloading(true);
    try {
      const key = getStoredKey();
      const res = await fetch(
        `/api/admin/channels/download?keyword=${encodeURIComponent(kw)}`,
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
      a.download = `渠道报表_${kw}_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      t.success("报表已生成并开始下载");
    } catch (err) {
      t.error(`下载失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDownloading(false);
    }
  }, [keyword, t]);

  const totalPages = Math.ceil(total / CLIENT_PAGE_SIZE);
  const downloadSec = useElapsedSeconds(downloading);
  const pageItems = useMemo(
    () => allItems.slice((page - 1) * CLIENT_PAGE_SIZE, page * CLIENT_PAGE_SIZE),
    [allItems, page]
  );

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
            <Button
              variant="secondary"
              onClick={download}
              loading={downloading}
              title="生成 CSV 报表：服务端逐块拉取全部命中渠道的实时用量与 key 状态，渠道多时需要几十秒"
            >
              {downloadButtonLabel(downloading, downloadSec, total)}
            </Button>
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
          <div className="mb-2 text-xs text-slate-500">
            共 {total.toLocaleString()} 条，第 {page}/{totalPages} 页（每页{" "}
            {CLIENT_PAGE_SIZE} 条）
          </div>
          <ChannelTable items={pageItems} />
          <Pager page={page} totalPages={totalPages} onPage={setPage} />
        </>
      )}
    </Card>
  );
}
