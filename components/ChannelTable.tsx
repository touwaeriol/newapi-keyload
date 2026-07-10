"use client";

// 渠道搜索结果表格（管理员「渠道管理」与用户「渠道列表」共用）：
// naci ID / 渠道名 / 优先级 / 站点状态 / key 存活 / 金额 / 创建时间，附翻页条。
import { Badge, Button } from "@/components/ui";

/** naci 额度换算美元的除数（与 lib/naci.ts QUOTA_PER_USD 一致；lib 为服务端模块，前端不直接 import）。 */
export const QUOTA_PER_USD = 500000;

export interface SiteStatus {
  site_id: number;
  site_name: string;
  status: number;
}

/** 搜索路由返回的渠道行（lib/channelSearch.ts ChannelSearchRow 的前端镜像）。 */
export interface ChannelItem {
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

export function fmtUsd(v: number) {
  return `$${(v / QUOTA_PER_USD).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function fmtTime(ts: string) {
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
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full ${
          open ? "bg-emerald-500" : "bg-rose-400"
        }`}
      />
      {site.site_name}
    </span>
  );
}

export function ChannelTable({ items }: { items: ChannelItem[] }) {
  return (
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
          {items.map((c) => (
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
                  {c.sites.length > 0 ? (
                    c.sites.map((s) => <SiteDot key={s.site_id} site={s} />)
                  ) : (
                    <span className="text-xs text-slate-300">-</span>
                  )}
                </div>
              </td>
              <td className="py-2 pr-2 text-center">
                {c.hasStatus ? (
                  <span
                    className={`text-xs tabular-nums ${
                      c.deadCount != null && c.deadCount > 0
                        ? "text-rose-600 font-medium"
                        : "text-slate-500"
                    }`}
                  >
                    {c.aliveCount != null ? `${c.aliveCount}/` : ""}
                    {c.multiKeySize}
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
  );
}

/** 翻页条：第 X / Y 页 + 上一页/下一页。totalPages ≤ 1 时不渲染。 */
export function Pager({
  page,
  totalPages,
  onPage,
  disabled = false,
}: {
  page: number;
  totalPages: number;
  onPage: (page: number) => void;
  disabled?: boolean;
}) {
  if (totalPages <= 1) return null;
  return (
    <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-3">
      <span className="text-xs text-slate-400">
        第 {page} / {totalPages} 页
      </span>
      <div className="flex gap-2">
        <Button
          variant="secondary"
          disabled={disabled || page <= 1}
          onClick={() => onPage(page - 1)}
        >
          上一页
        </Button>
        <Button
          variant="secondary"
          disabled={disabled || page >= totalPages}
          onClick={() => onPage(page + 1)}
        >
          下一页
        </Button>
      </div>
    </div>
  );
}
