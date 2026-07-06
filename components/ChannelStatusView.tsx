"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { SiteAmount } from "@/lib/types";
import { Badge } from "@/components/ui";

/**
 * 站点调度状态（GET /api/my/channel 的 channel.sites 元素）。
 * status：1=开启 / 3=自动禁用 / 0=关闭 / 2=手动禁用 / null 或其他=未知。
 */
export interface SiteScheduleStatus {
  site_id: number;
  site_name: string;
  status: number | null;
}

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
  /** 平台上该渠道的真实 key 数（multi_key_size） */
  platformKeyCount?: number | null;
  /** 被禁用（status=3）的 key 数 */
  deadKeyCount?: number | null;
  /** 本地队列中待上传的 key 数 */
  poolPending?: number;
  /** 本地队列中已上传的 key 数 */
  poolUploaded?: number;
  /** 定时引擎每批上传数量（管理员配置） */
  uploadBatchSize?: number;
  /** 是否启用自动补 key */
  autoRefillEnabled?: boolean;
  /** 下一次定时检查时间（ISO 字符串） */
  nextCheckAt?: string | null;
  /** 定时引擎当前是否正在检查 */
  checking?: boolean;
  /** 该渠道最近一次检查的结果/执行说明 */
  lastCheck?: {
    at: string;
    status: string;
    message: string;
  } | null;
  models?: string;
  priority?: number;
  group?: string;
  usedQuota?: number;
  usedAmount?: number;
  siteAmounts?: SiteAmount[];
  /** 各站点调度状态（用户端可手动开/关） */
  sites?: SiteScheduleStatus[];
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

/** 可用 key 数 = 平台 key 数 − 禁用 key 数；任一缺失返回 null（显示「-」） */
function aliveKeyCount(channel: ChannelStatus): number | null {
  if (channel.platformKeyCount == null || channel.deadKeyCount == null) {
    return null;
  }
  return channel.platformKeyCount - channel.deadKeyCount;
}

/** 「自动禁用」态：渠道有 key 但可用为 0（全死），即使 status 显示启用也需补 key */
function isExhausted(channel: ChannelStatus): boolean {
  return (channel.platformKeyCount ?? 0) > 0 && aliveKeyCount(channel) === 0;
}

/**
 * 共享渠道状态视图：是否存在、状态徽章、概览（含已上传 key 数）、
 * 顶层用量、模型 badges、各站点发布与用量。供用户面板与管理员弹窗复用。
 */
export function ChannelStatusView({ channel }: { channel: ChannelStatus | null }) {
  if (!channel) return null;

  if (channel.exists === false) {
    return (
      <div className="space-y-4">
        <UploadProgress channel={channel} />
        <div className="rounded-lg bg-amber-50 px-4 py-6 text-center">
          <Badge tone="amber">尚未创建</Badge>
          <p className="mt-2 text-sm text-slate-500">
            该渠道还未在平台创建，队列有 key 后由定时引擎自动创建并上传。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <UploadProgress channel={channel} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="渠道 ID" value={`#${channel.channelId ?? "-"}`} />
        <Stat label="状态" value={statusBadge(channel.status)} />
        <Stat label="类型" value={channel.type ?? "-"} />
        <Stat label="分组" value={channel.group ?? "-"} />
        <Stat label="优先级" value={channel.priority ?? "-"} />
        <Stat label="已上传 Key 数" value={channel.uploadedKeyCount ?? 0} />
        <Stat
          label="平台 Key 数"
          value={
            channel.platformKeyCount == null ? "-" : channel.platformKeyCount
          }
        />
        <Stat
          label="禁用 Key 数"
          value={
            channel.deadKeyCount == null ? (
              "-"
            ) : (
              <span
                className={
                  channel.deadKeyCount > 0 ? "text-rose-600" : undefined
                }
              >
                {channel.deadKeyCount}
              </span>
            )
          }
        />
        <Stat
          label="可用 Key 数"
          value={
            aliveKeyCount(channel) == null ? (
              "-"
            ) : (
              <span
                className={isExhausted(channel) ? "text-rose-600" : undefined}
              >
                {aliveKeyCount(channel)}
              </span>
            )
          }
        />
        <Stat
          label="待上传(队列)"
          value={
            channel.poolPending == null ? (
              "-"
            ) : (
              <span
                className={
                  channel.poolPending > 0 ? "text-amber-600" : undefined
                }
              >
                {channel.poolPending}
              </span>
            )
          }
        />
        <Stat
          label="已上传(队列)"
          value={channel.poolUploaded == null ? "-" : channel.poolUploaded}
        />
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

/** 上传进度：累计已上传 / 待上传 / 每批数量 / 进度条 / 下一次检查倒计时 / 预计批次。 */
function UploadProgress({ channel }: { channel: ChannelStatus }) {
  const uploaded = channel.poolUploaded ?? 0;
  const pending = channel.poolPending ?? 0;
  const total = uploaded + pending;
  const pct = total > 0 ? Math.round((uploaded / total) * 100) : 0;
  const batch = channel.uploadBatchSize ?? 0;
  const remainingBatches = batch > 0 ? Math.ceil(pending / batch) : 0;
  const auto = channel.autoRefillEnabled;
  const alive = aliveKeyCount(channel);
  const exhausted = isExhausted(channel);

  return (
    <div className="rounded-xl border border-brand-100 bg-brand-50/50 p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-slate-800">上传进度</h4>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {exhausted && <Badge tone="rose">自动禁用 · 无可用 Key</Badge>}
          {auto === false ? (
            <Badge tone="rose">自动补 key 已关闭</Badge>
          ) : (
            <Badge tone="green">自动补 key 运行中</Badge>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <BigStat label="累计已上传" value={uploaded} />
        <BigStat
          label="待上传"
          value={pending}
          tone={pending > 0 ? "amber" : undefined}
        />
        <BigStat label="每批数量" value={batch || "-"} />
        <BigStat
          label="可用 / 平台 Key"
          value={
            channel.platformKeyCount == null ? (
              "-"
            ) : (
              <>
                <span className={exhausted ? "text-rose-600" : undefined}>
                  {alive == null ? "-" : alive}
                </span>
                <span className="text-slate-400">
                  {" / "}
                  {channel.platformKeyCount}
                </span>
              </>
            )
          }
        />
      </div>

      {/* 进度条 */}
      <div className="mt-3">
        <div className="mb-1 flex justify-between text-xs text-slate-500">
          <span>{`已上传 ${uploaded} / 共 ${total}`}</span>
          <span>{pct}%</span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
          <div
            className="h-full rounded-full bg-brand-500 transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {/* 上一次检查结果 */}
      <LastCheckResult check={channel.lastCheck} />

      {/* 下一次检查 + 预计 */}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
        <span>
          下一次检查：
          <span className="font-medium text-slate-700">
            <NextCheck at={channel.nextCheckAt} checking={channel.checking} />
          </span>
        </span>
        {pending > 0 && batch > 0 && (
          <span>
            待上传约 <b className="text-slate-700">{remainingBatches}</b> 批（每批约 1 分钟，≈{" "}
            {remainingBatches} 分钟完成）
          </span>
        )}
      </div>
    </div>
  );
}

function BigStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: ReactNode;
  tone?: "amber";
}) {
  return (
    <div className="rounded-lg bg-white/70 px-3 py-2">
      <div className="text-xs text-slate-400">{label}</div>
      <div
        className={`mt-0.5 text-lg font-semibold ${
          tone === "amber" ? "text-amber-600" : "text-slate-800"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

/** 下一次检查倒计时（每秒刷新）。倒计时归零后显示「检查中…」，等待轮询拿到新的时间。 */
function NextCheck({
  at,
  checking,
}: {
  at?: string | null;
  checking?: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (checking) return <span className="text-brand-600">检查中…</span>;
  if (!at) return <>—</>;
  const ms = new Date(at).getTime() - now;
  const s = Math.max(0, Math.round(ms / 1000));
  return <>{s > 0 ? `约 ${s} 秒后` : <span className="text-brand-600">检查中…</span>}</>;
}

/** 相对时间「X 前」文案（不含组件状态）。 */
function relativeTime(atMs: number, now: number): string {
  const s = Math.max(0, Math.round((now - atMs) / 1000));
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  return `${Math.floor(m / 60)} 小时前`;
}

/** 检查结果状态 → 圆点颜色。 */
function statusDot(status: string): string {
  switch (status) {
    case "alive":
      return "bg-emerald-500";
    case "exhausted":
    case "missing":
      return "bg-amber-500";
    case "manual":
      return "bg-slate-400";
    case "unreadable":
      return "bg-rose-500";
    default:
      return "bg-slate-400";
  }
}

/** 上一次检查结果：状态圆点 + 结果/执行说明 + 相对时间（每秒刷新）。 */
function LastCheckResult({
  check,
}: {
  check?: { at: string; status: string; message: string } | null;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!check) {
    return (
      <div className="mt-3 rounded-lg bg-white/60 px-3 py-2 text-xs text-slate-400">
        上次检查：尚未执行首次检查
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-lg bg-white/60 px-3 py-2">
      <div className="flex items-start gap-2">
        <span
          className={`mt-1 h-2 w-2 shrink-0 rounded-full ${statusDot(
            check.status
          )}`}
        />
        <div className="min-w-0 text-xs">
          <span className="text-slate-400">上次检查结果：</span>
          <span className="font-medium text-slate-700">{check.message}</span>
          <span className="ml-1 text-slate-400">
            （{relativeTime(new Date(check.at).getTime(), now)}）
          </span>
        </div>
      </div>
    </div>
  );
}
