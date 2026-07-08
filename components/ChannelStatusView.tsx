"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Badge, Spinner } from "@/components/ui";

/**
 * 站点调度状态（每个已建渠道的 sites 元素）。
 * status：1=开启 / 3=自动禁用 / 0=关闭 / 2=手动禁用 / null 或其他=未知。
 */
export interface SiteScheduleStatus {
  site_id: number;
  site_name: string;
  status: number | null;
}

/** 单个已建渠道视图（GET /api/my/channel 的 channel.channels 元素）。 */
export interface CreatedChannelView {
  id: string;
  channelId: number;
  channelName: string;
  suffix: number;
  keyCount: number;
  /** 当前优先级（6=新建，5=退化后降级） */
  priority?: number;
  /** 派生状态：3=自动禁用（有 key 但可用为 0），1=正常，null=无 key 信息 */
  status: number | null;
  platformKeyCount: number | null;
  deadKeyCount: number | null;
  aliveKeyCount: number | null;
  usedQuota: number;
  usedAmount: number;
  sites: SiteScheduleStatus[];
  /** 各站远程渠道 id（本地落库的 publish_results）。 */
  remoteSites?: {
    siteId: number;
    remoteChannelId: number;
    remoteChannelName: string;
  }[];
}

/**
 * 渠道状态对象 shape（新模型：一个前缀对应多个已建渠道）。
 * GET /api/my/channel 与 GET /api/admin/users/[id]/channel 的 data.channel 一致。
 * platformKeyCount / deadKeyCount / usedAmount 等为**所有已建渠道的聚合值**。
 */
export interface ChannelStatus {
  exists: boolean;
  /** 用户配置的渠道前缀 */
  prefix?: string;
  channelName?: string;
  /** 已成功创建的渠道数 */
  createdCount?: number;
  /** 已建渠道列表 */
  channels?: CreatedChannelView[];
  /** 本系统累计上传去重 key 数（该前缀） */
  uploadedKeyCount?: number;
  /** 聚合：平台真实 key 数 */
  platformKeyCount?: number | null;
  /** 聚合：被禁用 key 数 */
  deadKeyCount?: number | null;
  /** 聚合：可用 key 数 */
  aliveKeyCount?: number | null;
  /** 本地队列中待上传的 key 数 */
  poolPending?: number;
  /** 本地队列中已上传的 key 数 */
  poolUploaded?: number;
  /** 每渠道聚合 key 数量（管理员配置） */
  uploadBatchSize?: number;
  /** 是否启用自动补 key */
  autoRefillEnabled?: boolean;
  /** 该用户生效的上传限速状态（滚动窗口用量，随轮询刷新） */
  uploadLimit?: {
    used: number;
    limit: number;
    windowMinutes: number;
    unlimited: boolean;
    /** 是否为单用户自定义限速（而非全局默认） */
    isOverride: boolean;
  } | null;
  /** 是否允许手动上传（全局开关；false=只能录入，靠引擎自动推站点） */
  manualUploadEnabled?: boolean;
  /** 高优先级配额状态 */
  highPriority?: {
    allowed: boolean;
    /** 独立上限（null=仅受全局约束） */
    limit: number | null;
    /** 该用户已建的优先级6渠道数 */
    used: number;
    /** 全局已用的优先级6渠道数（跨所有用户） */
    globalUsed?: number;
    /** 全局优先级6上限 */
    globalLimit?: number;
  } | null;
  /** 下一次定时检查时间（ISO 字符串） */
  nextCheckAt?: string | null;
  /** 定时引擎当前是否正在检查 */
  checking?: boolean;
  /** 该前缀最近一次检查的结果/执行说明 */
  lastCheck?: {
    at: string;
    status: string;
    message: string;
  } | null;
  /** naci 实时数据快照生成时间（ISO）；用于「缓存刷新倒计时」 */
  cachedAt?: string | null;
  /** naci 实时数据缓存时长（毫秒） */
  cacheTtlMs?: number;
  /** 聚合总用量金额 */
  usedQuota?: number;
  usedAmount?: number;
}

/** 站点状态徽章：1 开启 / 3 自动禁用 / 2 手动禁用 / 0 已关闭 / 其它未知 */
function siteBadge(status: number | null) {
  switch (status) {
    case 1:
      return <Badge tone="green">开启</Badge>;
    case 3:
      return <Badge tone="rose">自动禁用</Badge>;
    case 2:
      return <Badge tone="slate">手动禁用</Badge>;
    case 0:
      return <Badge tone="slate">已关闭</Badge>;
    default:
      return <Badge tone="slate">未知</Badge>;
  }
}

/** 渠道级状态徽章：1 正常 / 3 自动禁用 / 其它未知 */
function channelBadge(status: number | null) {
  switch (status) {
    case 1:
      return <Badge tone="green">正常</Badge>;
    case 3:
      return <Badge tone="rose">自动禁用</Badge>;
    default:
      return <Badge tone="slate">-</Badge>;
  }
}

/** 美元金额展示：$ + 千分位 + 2 位小数（非数值按 $0.00）。 */
function fmtUsd(v?: number) {
  const n = typeof v === "number" && !Number.isNaN(v) ? v : 0;
  return `$${n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** 聚合可用 key 数 = 平台 key 数 − 禁用 key 数；任一缺失返回 null（显示「-」） */
function aliveKeyCount(channel: ChannelStatus): number | null {
  if (channel.platformKeyCount == null || channel.deadKeyCount == null) {
    return null;
  }
  return channel.platformKeyCount - channel.deadKeyCount;
}

/** 「自动禁用」态：有 key 但可用为 0（全死） */
function isExhausted(channel: ChannelStatus): boolean {
  return (channel.platformKeyCount ?? 0) > 0 && aliveKeyCount(channel) === 0;
}

/**
 * 共享渠道状态视图：上传进度（聚合）+ 已建渠道列表（每渠道 key/金额/站点开关）。
 * onSiteToggle 存在时渲染站点开关（用户面板）；不存在时只读展示徽章（管理员查看）。
 */
export function ChannelStatusView({
  channel,
  onSiteToggle,
}: {
  channel: ChannelStatus | null;
  onSiteToggle?: (
    channelId: number,
    siteId: number,
    on: boolean
  ) => Promise<void>;
}) {
  if (!channel) return null;

  const channels = channel.channels ?? [];

  return (
    <div className="space-y-4">
      {/* 突出展示：所有已建渠道的累计消费总金额 */}
      <div className="flex items-end justify-between gap-3 rounded-xl border border-emerald-100 bg-gradient-to-br from-emerald-50 to-white px-4 py-3">
        <div>
          <div className="text-xs font-medium text-emerald-700/80">
            累计消费金额（所有已建渠道）
          </div>
          <div className="mt-0.5 text-3xl font-bold tracking-tight text-emerald-600">
            {fmtUsd(channel.usedAmount)}
          </div>
        </div>
        <div className="text-right text-xs text-slate-400">
          共 {channel.createdCount ?? channels.length} 个渠道
        </div>
      </div>

      <UploadProgress channel={channel} />

      <div className="grid grid-cols-2 gap-3">
        <Stat label="已建渠道数" value={channel.createdCount ?? channels.length} />
        <Stat label="累计上传(去重)" value={channel.uploadedKeyCount ?? 0} />
      </div>

      <div>
        <div className="mb-1 text-xs font-medium text-slate-500">已建渠道</div>
        {channels.length > 0 ? (
          <div className="space-y-2">
            {channels.map((c) => (
              <ChannelRow
                key={c.id}
                channel={c}
                onSiteToggle={onSiteToggle}
              />
            ))}
          </div>
        ) : (
          <div className="rounded-lg bg-amber-50 px-4 py-6 text-center">
            <Badge tone="amber">尚未创建</Badge>
            <p className="mt-2 text-sm text-slate-500">
              还没有已建渠道。录入 key 后点「上传一批（新建渠道）」或由定时引擎自动新建。
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/** 单个已建渠道行：名称/#id、状态、平台/可用 key、金额、站点开关。 */
function ChannelRow({
  channel,
  onSiteToggle,
}: {
  channel: CreatedChannelView;
  onSiteToggle?: (
    channelId: number,
    siteId: number,
    on: boolean
  ) => Promise<void>;
}) {
  const alive = channel.aliveKeyCount;
  const platform = channel.platformKeyCount;
  const exhausted = (platform ?? 0) > 0 && alive === 0;
  // site_id → 远程渠道 id（本地落库的 publish_results），供站点行小字展示
  const remoteBySite = new Map(
    (channel.remoteSites ?? []).map((r) => [r.siteId, r])
  );

  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-slate-800">
            {channel.channelName}
          </div>
          <div className="mt-0.5 text-xs text-slate-400">#{channel.channelId}</div>
        </div>
        <div className="flex items-center gap-1.5">
          {channel.priority != null && (
            <Badge tone={channel.priority >= 6 ? "green" : "slate"}>
              P{channel.priority}
            </Badge>
          )}
          {channelBadge(channel.status)}
        </div>
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
        <MiniStat
          label="可用/平台"
          value={
            platform == null ? (
              "-"
            ) : (
              <>
                <span className={exhausted ? "text-rose-600" : undefined}>
                  {alive == null ? "-" : alive}
                </span>
                <span className="text-slate-400"> / {platform}</span>
              </>
            )
          }
        />
        <MiniStat label="本批 key" value={channel.keyCount} />
        <MiniStat
          label="金额"
          value={
            <span className="text-emerald-600">{fmtUsd(channel.usedAmount)}</span>
          }
        />
      </div>

      {channel.sites.length > 0 && (
        <div className="mt-2 divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200">
          {channel.sites.map((s) => (
            <SiteRow
              key={s.site_id}
              channelId={channel.channelId}
              site={s}
              remoteChannelId={remoteBySite.get(s.site_id)?.remoteChannelId}
              onSiteToggle={onSiteToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** 单站点行：站名 + 状态徽章（+ 可选开关）。 */
function SiteRow({
  channelId,
  site,
  remoteChannelId,
  onSiteToggle,
}: {
  channelId: number;
  site: SiteScheduleStatus;
  remoteChannelId?: number;
  onSiteToggle?: (
    channelId: number,
    siteId: number,
    on: boolean
  ) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const on = site.status === 1;

  async function toggle(next: boolean) {
    if (!onSiteToggle || busy) return;
    setBusy(true);
    try {
      await onSiteToggle(channelId, site.site_id, next);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2">
      <div className="truncate text-xs text-slate-600">
        {site.site_name}
        <span className="ml-1 text-slate-400">#{site.site_id}</span>
        {remoteChannelId != null && remoteChannelId > 0 && (
          <span
            className="ml-1 text-slate-400"
            title="该站点上的远程渠道 id"
          >
            · 远程 #{remoteChannelId}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        {siteBadge(site.status)}
        {busy && <Spinner className="h-4 w-4 text-slate-400" />}
        {onSiteToggle && (
          <Toggle on={on} disabled={busy} onChange={toggle} />
        )}
      </div>
    </div>
  );
}

/** 纯 Tailwind 开关。 */
function Toggle({
  on,
  disabled,
  onChange,
}: {
  on: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-50 ${
        on ? "bg-emerald-500" : "bg-slate-300"
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition ${
          on ? "translate-x-6" : "translate-x-1"
        }`}
      />
    </button>
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

function MiniStat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-md bg-slate-50 px-2 py-1.5">
      <div className="text-[10px] text-slate-400">{label}</div>
      <div className="mt-0.5 font-medium text-slate-700">{value}</div>
    </div>
  );
}

/** 高优先级徽章色：全局满 或 用户独立配额满 → 红（无法再建优先级6）；否则蓝。 */
function highPriorityTone(hp: {
  limit: number | null;
  used: number;
  globalUsed?: number;
  globalLimit?: number;
}): "blue" | "rose" {
  const globalFull =
    hp.globalLimit != null &&
    hp.globalUsed != null &&
    hp.globalUsed >= hp.globalLimit;
  const userFull = hp.limit != null && hp.used >= hp.limit;
  return globalFull || userFull ? "rose" : "blue";
}

/**
 * 上传进度。术语：
 * 「录入」= 已保存到本系统数据库（本地库）；「上传」= 已建成渠道推送到 naci 站点。
 * 已录入 = 待上传 + 已上传。
 */
function UploadProgress({ channel }: { channel: ChannelStatus }) {
  const uploaded = channel.poolUploaded ?? 0;
  const pending = channel.poolPending ?? 0;
  const recorded = uploaded + pending;
  const pct = recorded > 0 ? Math.round((uploaded / recorded) * 100) : 0;
  const batch = channel.uploadBatchSize ?? 0;
  const remainingBatches = batch > 0 ? Math.ceil(pending / batch) : 0;
  const auto = channel.autoRefillEnabled;
  const alive = aliveKeyCount(channel);
  const exhausted = isExhausted(channel);
  const limit = channel.uploadLimit;
  const limitedNow = limit != null && !limit.unlimited && limit.used >= limit.limit;
  const hp = channel.highPriority;

  return (
    <div className="rounded-xl border border-brand-100 bg-brand-50/50 p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-slate-800">上传进度</h4>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {channel.manualUploadEnabled === false && (
            <Badge tone="amber">已禁手动上传 · 系统自动上</Badge>
          )}
          {hp != null &&
            (!hp.allowed ? (
              <Badge tone="slate">不可用高优先级</Badge>
            ) : (
              <Badge tone={highPriorityTone(hp)}>
                高优先级 全局 {hp.globalUsed ?? "?"}/{hp.globalLimit ?? "?"} · 我{" "}
                {hp.limit != null ? `${hp.used}/${hp.limit}` : hp.used}
              </Badge>
            ))}
          {limit != null &&
            (limit.unlimited ? (
              <Badge tone="slate">上传不限速</Badge>
            ) : (
              <Badge tone={limitedNow ? "rose" : "green"}>
                {limitedNow ? "限速中" : "上传限速"} {limit.used}/{limit.limit} ·{" "}
                {limit.windowMinutes}分钟
              </Badge>
            ))}
          {exhausted && <Badge tone="rose">自动禁用 · 无可用 Key</Badge>}
          {auto === false ? (
            <Badge tone="rose">自动建渠道已关闭</Badge>
          ) : (
            <Badge tone="green">自动建渠道运行中</Badge>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <BigStat label="已录入(本地库)" value={recorded} />
        <BigStat
          label="待上传"
          value={pending}
          tone={pending > 0 ? "amber" : undefined}
        />
        <BigStat label="已上传" value={uploaded} />
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
          <span>{`已上传 ${uploaded} / 已录入 ${recorded}`}</span>
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

      {/* 每批数量 + 下一次检查 + 预计 */}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
        <span>
          每渠道聚合：
          <span className="font-medium text-slate-700">{batch || "-"}</span> 个 key
        </span>
        <span>
          下一次检查：
          <span className="font-medium text-slate-700">
            <NextCheck at={channel.nextCheckAt} checking={channel.checking} />
          </span>
        </span>
        {pending > 0 && batch > 0 && (
          <span>
            待上传约 <b className="text-slate-700">{remainingBatches}</b> 批（每批 1 个新渠道）
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

/** 下一次检查倒计时（每秒刷新）。 */
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

/**
 * 缓存刷新倒计时（放刷新按钮旁）：naci 实时数据是 30s 缓存快照。
 */
export function CacheRefreshCountdown({
  cachedAt,
  ttlMs,
}: {
  cachedAt?: string | null;
  ttlMs?: number;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!cachedAt || !ttlMs) return null;
  const expireAt = new Date(cachedAt).getTime() + ttlMs;
  const s = Math.max(0, Math.round((expireAt - now) / 1000));
  return (
    <span className="text-xs text-slate-400" title="渠道数据为缓存快照，到点后自动取最新">
      {s > 0 ? `缓存 · 约 ${s} 秒后刷新` : "缓存 · 刷新中…"}
    </span>
  );
}

/** 相对时间「X 前」文案。 */
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
    case "created":
      return "bg-emerald-500";
    case "paused":
    case "limited":
      return "bg-amber-500";
    case "empty":
      return "bg-slate-400";
    case "error":
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
