"use client";

import { useState, useCallback, useMemo } from "react";
import { apiFetch } from "@/lib/client";
import { useToast } from "@/components/Toast";
import { Badge, Button, Card, Spinner, TextInput } from "@/components/ui";

const QUOTA_PER_USD = 500000;
const CLIENT_PAGE_SIZE = 100;

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
      window.open(`/api/admin/channels/download?keyword=${encodeURIComponent(kw)}`, "_blank");
    } catch (err) {
      t.error(`下载失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDownloading(false);
    }
  }, [keyword, t]);

  const totalPages = Math.ceil(total / CLIENT_PAGE_SIZE);
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
            onKeyDown={(e) => { if (e.key === "Enter") search(); }}
            className="w-64"
          />
          <Button onClick={search} loading={loading}>
            🔍 搜索
          </Button>
          {total > 0 && (
            <Button variant="secondary" onClick={download} loading={downloading}>
              📥 下载报表
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
            共 {total.toLocaleString()} 条，第 {page}/{totalPages} 页（每页 {CLIENT_PAGE_SIZE} 条）
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
                {pageItems.map((c) => (
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
                第 {page} / {totalPages} 页
              </span>
              <div className="flex gap-2">
                <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                  上一页
                </Button>
                <Button variant="secondary" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
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
