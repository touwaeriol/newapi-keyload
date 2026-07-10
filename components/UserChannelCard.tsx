"use client";

// 用户「渠道列表」卡：按自己前缀查询 naci 渠道（服务端精确过滤+分页），实时用量与状态。
import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "@/lib/client";
import { useToast } from "@/components/Toast";
import { Card, Spinner } from "@/components/ui";
import { ChannelTable, Pager, type ChannelItem } from "@/components/ChannelTable";
import type { SafeUser } from "@/lib/types";

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
  const [result, setResult] = useState<SearchResult | null>(null);

  const search = useCallback(
    async (page: number) => {
      if (!prefix) return;
      setLoading(true);
      try {
        const data = await apiFetch<SearchResult>(
          `/api/my/channels/search?page=${page}&pageSize=50`
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

  // 自动首次加载
  useEffect(() => {
    search(1);
  }, [search]);

  const totalPages = result ? Math.ceil(result.total / result.pageSize) : 0;

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
      actions={null}
    >
      {loading && !result && (
        <div className="flex items-center justify-center gap-2 py-8 text-slate-400">
          <Spinner /> <span className="text-sm">加载中…</span>
        </div>
      )}

      {result && (
        <>
          <div className="mb-2 flex items-center justify-between text-xs text-slate-500">
            <span>共 {result.total.toLocaleString()} 条</span>
            <button
              onClick={() => search(1)}
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
