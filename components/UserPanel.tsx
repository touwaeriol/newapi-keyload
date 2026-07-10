"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SafeUser } from "@/lib/types";
import { apiFetch } from "@/lib/client";
import { useToast } from "@/components/Toast";
import { Button, Card, Spinner } from "@/components/ui";
import { UserChannelCard } from "@/components/UserChannelCard";
import {
  UploadResultView,
  DirectResultView,
  type UploadQueueResult,
  type DirectUploadResult,
} from "@/components/UploadKeyModal";
import {
  ChannelStatusView,
  CacheRefreshCountdown,
  type ChannelStatus,
  type SiteScheduleStatus,
} from "@/components/ChannelStatusView";

/** 常态轮询间隔（毫秒）：保持「上/下一次检查」倒计时与渠道状态新鲜 */
const POLL_INTERVAL = 15000;
/** 队列仍有待上传 key 时的更快轮询间隔（毫秒） */
const POLL_INTERVAL_BUSY = 8000;

/** 关闭站点时提交的 status 值（2=手动禁用）。 */
const SITE_CLOSE_STATUS = 2;

/** 建批结果 shape（POST /api/my/create-batch 返回）。 */
interface CreateBatchResult {
  created: boolean;
  channelName?: string;
  channelId?: number;
  keyCount?: number;
  /** 是否因上传限速被拦下 */
  limited?: boolean;
  limitedMessage?: string;
  /** 是否因「仅高优先级」无空闲名额被拦下 */
  waitingSlot?: boolean;
  waitingMessage?: string;
  poolPending: number;
  poolUploaded: number;
}

export function UserPanel({ user }: { user: SafeUser }) {
  const toast = useToast();
  const [tab, setTab] = useState<"my" | "channels">("my");
  const [channel, setChannel] = useState<ChannelStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const fetchChannel = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const data = await apiFetch<{ channel: ChannelStatus }>(
          "/api/my/channel"
        );
        if (!mounted.current) return;
        setChannel(data.channel);
      } catch (err) {
        if (!mounted.current) return;
        if (!silent) {
          toast.error(err instanceof Error ? err.message : "读取渠道失败");
        }
      } finally {
        if (mounted.current && !silent) setLoading(false);
      }
    },
    [toast]
  );

  useEffect(() => {
    fetchChannel(false);
  }, [fetchChannel]);

  // 常态静默轮询：队列仍有待上传 key 时用更快间隔。卸载即停。
  const poolPending = channel?.poolPending ?? 0;
  useEffect(() => {
    const interval = poolPending > 0 ? POLL_INTERVAL_BUSY : POLL_INTERVAL;
    const timer = window.setInterval(() => {
      fetchChannel(true);
    }, interval);
    return () => window.clearInterval(timer);
  }, [poolPending, fetchChannel]);

  // 站点开关：POST 后用返回的最新 sites 就地更新对应渠道
  const handleSiteToggle = useCallback(
    async (channelId: number, siteId: number, on: boolean) => {
      const status = on ? 1 : SITE_CLOSE_STATUS;
      try {
        const res = await apiFetch<{ sites: SiteScheduleStatus[] }>(
          "/api/my/site-status",
          {
            method: "POST",
            body: JSON.stringify({ channelId, siteId, status }),
          }
        );
        if (!mounted.current) return;
        setChannel((prev) => {
          if (!prev || !prev.channels) return prev;
          return {
            ...prev,
            channels: prev.channels.map((c) =>
              c.channelId === channelId ? { ...c, sites: res.sites ?? [] } : c
            ),
          };
        });
        toast.success(`站点已${on ? "开启" : "关闭"}`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "操作失败");
      }
    },
    [toast]
  );

  // 手动一键回退优先级（6→5）：同步 naci 与本地记录，立即释放高优先级名额
  const handleDemote = useCallback(
    async (channelId: number) => {
      try {
        const res = await apiFetch<{
          channelName: string;
          from: number;
          to: number;
        }>("/api/my/demote-channel", {
          method: "POST",
          body: JSON.stringify({ channelId }),
        });
        toast.success(`已回退 ${res.channelName} 优先级 ${res.from}→${res.to}`);
        fetchChannel(true);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "回退优先级失败");
      }
    },
    [toast, fetchChannel]
  );

  // 手动同步最新用量：立即实时拉 used-quota 刷新缓存（不受后台自动刷新次数上限约束）
  const handleSyncUsage = useCallback(async () => {
    try {
      const res = await apiFetch<{
        channelCount: number;
        totalUsedAmount: number;
      }>("/api/my/sync-usage", { method: "POST" });
      toast.success(
        `已同步 ${res.channelCount} 个渠道用量，合计 $${res.totalUsedAmount.toFixed(2)}`
      );
      fetchChannel(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "同步用量失败");
    }
  }, [toast, fetchChannel]);

  return (
    <div className="space-y-4">
      {/* Tab 导航 */}
      <div className="flex gap-1 rounded-xl bg-slate-100 p-1 w-fit">
        <button
          onClick={() => setTab("my")}
          className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium transition ${
            tab === "my"
              ? "bg-white text-slate-800 shadow-sm"
              : "text-slate-500 hover:text-slate-700"
          }`}
        >
          📤 我的渠道
        </button>
        <button
          onClick={() => setTab("channels")}
          className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium transition ${
            tab === "channels"
              ? "bg-white text-slate-800 shadow-sm"
              : "text-slate-500 hover:text-slate-700"
          }`}
        >
          📊 渠道列表
        </button>
      </div>

      {tab === "my" ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <ChannelCard
            user={user}
            channel={channel}
            loading={loading}
            onRefresh={() => fetchChannel(false)}
            onSiteToggle={handleSiteToggle}
            onDemote={handleDemote}
            onSyncUsage={handleSyncUsage}
          />
          <UploadCard
            onUploaded={() => fetchChannel(false)}
            manualUploadEnabled={channel?.manualUploadEnabled !== false}
            onlyHighPriority={channel?.onlyHighPriority === true}
          />
        </div>
      ) : (
        <UserChannelCard user={user} />
      )}
    </div>
  );
}

/* ============ 我的渠道卡 ============ */

function ChannelCard({
  user,
  channel,
  loading,
  onRefresh,
  onSiteToggle,
  onDemote,
  onSyncUsage,
}: {
  user: SafeUser;
  channel: ChannelStatus | null;
  loading: boolean;
  onRefresh: () => void;
  onSiteToggle: (
    channelId: number,
    siteId: number,
    on: boolean
  ) => Promise<void>;
  onDemote: (channelId: number) => Promise<void>;
  onSyncUsage: () => Promise<void>;
}) {
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const manualDisabled = channel?.manualUploadEnabled === false;
  const onlyHigh = channel?.onlyHighPriority === true;

  // 顶部按钮：从本地池取「下一批」新建一个渠道并发布
  async function createBatch() {
    setCreating(true);
    try {
      const res = await apiFetch<CreateBatchResult>("/api/my/create-batch", {
        method: "POST",
      });
      if (res.created) {
        toast.success(
          `已新建渠道 ${res.channelName}（本批 ${res.keyCount} 个，剩余待上传 ${res.poolPending}）`
        );
      } else if (res.limited) {
        toast.error(res.limitedMessage ?? "上传限速中，请稍后再试");
      } else if (res.waitingSlot) {
        toast.info(res.waitingMessage ?? "仅高优先级模式：暂无空闲名额，key 已留池等待回收");
      } else {
        toast.info("本地库暂无待上传 key");
      }
      onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "新建渠道失败");
    } finally {
      setCreating(false);
    }
  }

  return (
    <Card
      title="我的渠道"
      subtitle={`渠道前缀：${user.channelName}`}
      actions={
        <div className="flex items-center gap-2">
          <CacheRefreshCountdown
            cachedAt={channel?.cachedAt}
            ttlMs={channel?.cacheTtlMs}
          />
          <Button
            onClick={createBatch}
            loading={creating}
            disabled={manualDisabled || onlyHigh}
            title={
              onlyHigh
                ? "仅高优先级模式：渠道由定时任务在各用户间公平分配，请用「提交上传」录入本地库"
                : manualDisabled
                ? "管理员已关闭手动上传，key 录入本地库后由系统自动上传"
                : undefined
            }
          >
            上传一批（新建渠道）
          </Button>
          <Button
            variant="secondary"
            onClick={async () => {
              setSyncing(true);
              try {
                await onSyncUsage();
              } finally {
                setSyncing(false);
              }
            }}
            loading={syncing}
            title="立即实时拉取所有渠道的最新用量（不受后台自动刷新次数上限约束）"
          >
            同步用量
          </Button>
          <Button variant="secondary" onClick={onRefresh} loading={loading}>
            刷新
          </Button>
        </div>
      }
    >
      {loading ? (
        <div className="flex items-center gap-2 py-6 text-sm text-slate-400">
          <Spinner className="h-4 w-4" /> 加载中…
        </div>
      ) : (
        <ChannelStatusView
          channel={channel}
          onSiteToggle={onSiteToggle}
          onDemote={onDemote}
        />
      )}
    </Card>
  );
}

/* ============ 上传 Key 卡 ============ */

type UploadCardResult =
  | { mode: "queue"; data: UploadQueueResult }
  | { mode: "direct"; data: DirectUploadResult };

function UploadCard({
  onUploaded,
  manualUploadEnabled = true,
  onlyHighPriority = false,
}: {
  onUploaded: () => void;
  manualUploadEnabled?: boolean;
  onlyHighPriority?: boolean;
}) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [directLoading, setDirectLoading] = useState(false);
  const [result, setResult] = useState<UploadCardResult | null>(null);

  const busy = loading || directLoading;
  const lineCount = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean).length;

  // 提交上传：只录入本地库，由手动按钮 / 定时引擎分批建渠道
  async function submit() {
    const keys = text.trim();
    if (!keys) {
      toast.error("请粘贴至少一个 key");
      return;
    }
    setLoading(true);
    try {
      const res = await apiFetch<UploadQueueResult>("/api/my/upload", {
        method: "POST",
        body: JSON.stringify({ keys }),
      });
      setResult({ mode: "queue", data: res });
      setText("");
      toast.success(
        `已录入 ${res.added} 个（待上传 ${res.poolPending}，已上传 ${res.poolUploaded}）`
      );
      onUploaded();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "上传失败");
    } finally {
      setLoading(false);
    }
  }

  // 直接上传：录入本地库并立即把 pending 逐批建成新渠道
  async function submitDirect() {
    const keys = text.trim();
    if (!keys) {
      toast.error("请粘贴至少一个 key");
      return;
    }
    setDirectLoading(true);
    try {
      const res = await apiFetch<DirectUploadResult>("/api/my/upload-direct", {
        method: "POST",
        body: JSON.stringify({ keys }),
      });
      setResult({ mode: "direct", data: res });
      setText("");
      if (res.limited) {
        toast.info(
          `已建 ${res.createdChannels} 个新渠道共传 ${res.pushed} 个后触发上传限速（剩余待上传 ${res.poolPending}，窗口滚动后自动续传）`
        );
      } else if (res.waitingSlot) {
        toast.info(
          res.waitingMessage ??
            `已录入 ${res.added} 个，剩余待上传 ${res.poolPending}，由定时任务公平分配高优先级渠道`
        );
      } else {
        toast.success(
          `已建 ${res.createdChannels} 个新渠道共传 ${res.pushed} 个（新录入 ${res.added}，剩余待上传 ${res.poolPending}）`
        );
      }
      onUploaded();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "直接上传失败");
    } finally {
      setDirectLoading(false);
    }
  }

  return (
    <Card
      title="上传 Key"
      subtitle="每行一个 key。直接上传＝按「聚合 key 数量」拆分立即建成渠道（有名额建 P6，满则 P5），不排队。"
    >
      <div className="space-y-3">
        {!manualUploadEnabled && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
            管理员已关闭手动上传：请使用「提交上传」录入本地库，系统会自动分批推送到站点。
          </p>
        )}
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={8}
          placeholder={"sk-ant-api03-xxxx\nsk-ant-api03-yyyy"}
          className="w-full resize-y rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs text-slate-800 outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
        />
        <div className="flex items-center justify-between gap-2">
          <span className="shrink-0 text-xs text-slate-400">
            识别到 {lineCount} 行有效 key
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              onClick={submitDirect}
              loading={directLoading}
              disabled={busy || !manualUploadEnabled}
              title={
                !manualUploadEnabled
                  ? "管理员已关闭手动上传"
                  : "立即按「聚合 key 数量」拆分建渠道传完；有名额建P6，满则P5"
              }
            >
              直接上传（建渠道）
            </Button>
            <Button onClick={submit} loading={loading} disabled={true}>
              提交上传（已禁用）
            </Button>
          </div>
        </div>

        {result && (
          <div className="rounded-lg border border-slate-200 bg-slate-50/50 p-3">
            {result.mode === "queue" ? (
              <UploadResultView result={result.data} />
            ) : (
              <DirectResultView result={result.data} />
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
