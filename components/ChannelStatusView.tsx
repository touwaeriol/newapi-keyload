"use client";

import type { ReactNode } from "react";
import type { SiteAmount } from "@/lib/types";
import { Badge } from "@/components/ui";

/**
 * 渠道状态对象 shape（GET /api/my/channel 与 GET /api/admin/users/[id]/channel
 * 的 data.channel 一致）。顶层 camelCase；siteAmounts 内部元素仍是 snake_case。
 */
export interface ChannelStatus {
  exists: boolean;
  channelName: string;
  channelId?: number | null;
  /** 1 启用 / 2 手动禁用 / 3 自动禁用 */
  status?: number;
  type?: number;
  /** 本系统累计上传去重 key 数 */
  uploadedKeyCount?: number;
  models?: string;
  priority?: number;
  group?: string;
  usedQuota?: number;
  usedAmount?: number;
  siteAmounts?: SiteAmount[];
}

function statusBadge(status?: number) {
  switch (status) {
    case 1:
      return <Badge tone="green">启用</Badge>;
    case 2:
      return <Badge tone="slate">手动禁用</Badge>;
    case 3:
      return <Badge tone="rose">自动禁用</Badge>;
    default:
      return <Badge tone="slate">未知</Badge>;
  }
}

/** 金额展示：数值保留 4 位小数，非数值原样 */
function fmtAmount(v?: number) {
  if (typeof v !== "number" || Number.isNaN(v)) return "0";
  return v.toFixed(4);
}

/**
 * 共享渠道状态视图：是否存在、状态徽章、概览（含已上传 key 数）、
 * 顶层用量、模型 badges、各站点发布与用量。供用户面板与管理员弹窗复用。
 */
export function ChannelStatusView({ channel }: { channel: ChannelStatus | null }) {
  if (!channel) return null;

  if (channel.exists === false) {
    return (
      <div className="rounded-lg bg-amber-50 px-4 py-6 text-center">
        <Badge tone="amber">尚未创建</Badge>
        <p className="mt-2 text-sm text-slate-500">
          该渠道还未在平台创建，首次上传 Key 后将自动创建。
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="渠道 ID" value={`#${channel.channelId ?? "-"}`} />
        <Stat label="状态" value={statusBadge(channel.status)} />
        <Stat label="类型" value={channel.type ?? "-"} />
        <Stat label="分组" value={channel.group ?? "-"} />
        <Stat label="优先级" value={channel.priority ?? "-"} />
        <Stat label="已上传 Key 数" value={channel.uploadedKeyCount ?? 0} />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Stat label="used_quota（顶层额度）" value={channel.usedQuota ?? 0} />
        <Stat label="used_amount（顶层金额）" value={fmtAmount(channel.usedAmount)} />
      </div>

      {channel.models && (
        <div>
          <div className="mb-1 text-xs font-medium text-slate-500">模型</div>
          <div className="flex flex-wrap gap-1.5">
            {channel.models
              .split(",")
              .map((m) => m.trim())
              .filter(Boolean)
              .map((m) => (
                <Badge key={m} tone="slate">
                  {m}
                </Badge>
              ))}
          </div>
        </div>
      )}

      <div>
        <div className="mb-1 text-xs font-medium text-slate-500">站点发布与用量</div>
        {channel.siteAmounts && channel.siteAmounts.length > 0 ? (
          <div className="overflow-hidden rounded-lg border border-slate-200">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">站点</th>
                  <th className="px-3 py-2 text-left font-medium">远端 ID</th>
                  <th className="px-3 py-2 text-right font-medium">used_quota</th>
                  <th className="px-3 py-2 text-right font-medium">used_amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {channel.siteAmounts.map((s) => (
                  <tr key={s.site_id}>
                    <td className="px-3 py-2 text-slate-700">{s.site_name}</td>
                    <td className="px-3 py-2 text-slate-500">{s.remote_channel_id}</td>
                    <td className="px-3 py-2 text-right text-slate-600">{s.used_quota}</td>
                    <td className="px-3 py-2 text-right text-slate-600">
                      {s.used_amount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-xs text-slate-400">暂无站点发布明细</p>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2">
      <div className="text-xs text-slate-400">{label}</div>
      <div className="mt-0.5 text-sm font-medium text-slate-800">{value}</div>
    </div>
  );
}
