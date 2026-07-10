"use client";

import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "@/lib/client";
import { useToast } from "@/components/Toast";
import { Badge, Button, Card, Spinner } from "@/components/ui";
import type { SafeUser } from "@/lib/types";

const QUOTA_PER_USD = 500000;

interface SiteStatus {
  site_id: number;
  site_name: string;
  status: number;
}

interface ChannelItem {
  id: number;
  name: string;
  priority: number | null;
  used_quota: number;
  used_amount: number;
  created_at: string;
  updated_at: string;
  sites: SiteStatus[];
  multiKeySize: number;
  aliveCount: number | null;
  deadCount: number | null;
  hasStatus: boolean;
}

interface SearchResult {
  page: number;
  pageSize: number;
  total: number;
  items: ChannelItem[];
}

function fmtUsd(v: number) {
  return `$${(v / QUOTA_PER_USD).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtTime(ts: string) {
  if (!ts) return "";
  const d = new Date(ts.length === 19 ? ts + "Z" : ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString("zh-CN", { hour12: false });
}

function SiteDot({ site }: { site: SiteStatus }) {
  const open = site.status === 1;
  return (
    <span
      title={`${site.site_name}: ${open ? "已打开" : `自动禁用(${site.status})`}`}
      className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs font-medium ${
        open ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-600"
      }`}
    >
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${open ? "bg-emerald-500" : "bg-rose-400"}`} />
      {site.site_name}
    </span>
  );
}

export function UserChannelCard({ user }: { user: SafeUser }) {
  const t = useToast();
  const prefix = user.channelName.trim();
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [result, setResult] = useState<SearchResult | null>(null);

  const search = useCallback(async (page: number) => {
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
  }, [prefix, t]);

  // 自动首次加载
  useEffect(() => { search(1); }, [search]);

  const download = useCallback(async () => {
    setDownloading(true);
    try {
      window.open(`/api/my/channels/download`, "_blank");
    } catch (err) {
      t.error(`下载失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDownloading(false);
    }
  }, [t]);

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
      actions={
        result && result.total > 0 && (
          <Button variant="secondary" onClick={download} loading={downloading}>
            📥 下载报表
          </Button>
        )
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
            <span>共 {result.total.toLocaleString()} 条</span>
            <button onClick={() => search(1)} className="text-brand-600 hover:underline" disabled={loading}>
              {loading ? "刷新中…" : "🔄 刷新"}
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                  <th className="pb-2 pr-2 font-medium">naci ID</th>
                  <th className="pb-2 pr-2 font-medium">渠道名</th>
                  <th className="pb-2 pr-2 font-medium">P</th>
                  <th className="pb-2 pr-2 font-medium">站点状态</th>
                  <th className="pb-2 pr-2 text-center font-medium">Key</th>
                  <th className="pb-2 pr-2 text-right font-medium">金额 USD</th>
                  <th className="pb-2 font-medium">创建时间</th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((c) => (
                  <tr key={c.id} className="border-b border-slate-50 hover:bg-slate-50">
                    <td className="py-2 pr-2 text-slate-400 font-mono text-xs">{c.id}</td>
                    <td className="py-2 pr-2 text-slate-700 font-medium text-xs">{c.name}</td>
                    <td className="py-2 pr-2">
                      {c.priority != null ? (
                        <Badge tone={c.priority >= 6 ? "blue" : "slate"}>{c.priority}</Badge>
                      ) : (
                        <span className="text-slate-300">?</span>
                      )}
                    </td>
                    <td className="py-2 pr-2">
                      <div className="flex gap-1 flex-wrap">
                        {c.sites.length > 0
                          ? c.sites.map(s => <SiteDot key={s.site_id} site={s} />)
                          : <span className="text-xs text-slate-300">-</span>
                        }
                      </div>
                    </td>
                    <td className="py-2 pr-2 text-center">
                      {c.hasStatus ? (
                        <span className={`text-xs tabular-nums ${
                          c.deadCount != null && c.deadCount > 0 ? "text-rose-600 font-medium" : "text-slate-500"
                        }`}>
                          {c.aliveCount != null ? `${c.aliveCount}/` : ""}{c.multiKeySize}
                          {c.deadCount != null && c.deadCount > 0 && (
                            <span className="text-rose-400"> -{c.deadCount}</span>
                          )}
                        </span>
                      ) : (
                        <span className="text-xs text-slate-300">-</span>
                      )}
                    </td>
                    <td className="py-2 pr-2 text-right text-slate-700 tabular-nums font-medium text-xs">
                      {fmtUsd(c.used_quota)}
                    </td>
                    <td className="py-2 text-xs text-slate-400">{fmtTime(c.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-3">
              <span className="text-xs text-slate-400">
                第 {result.page} / {totalPages} 页
              </span>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  disabled={result.page <= 1}
                  onClick={() => search(result.page - 1)}
                >
                  上一页
                </Button>
                <Button
                  variant="secondary"
                  disabled={result.page >= totalPages}
                  onClick={() => search(result.page + 1)}
                >
                  下一页
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
