"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SafeUser } from "@/lib/types";
import { apiFetch } from "@/lib/client";
import { useToast } from "@/components/Toast";
import { Badge, Button, Card, Spinner } from "@/components/ui";
import {
  UploadResultView,
  type UploadQueueResult,
} from "@/components/UploadKeyModal";
import {
  ChannelStatusView,
  type ChannelStatus,
  type SiteScheduleStatus,
} from "@/components/ChannelStatusView";

/** 队列未清空时的轮询间隔（毫秒） */
const POLL_INTERVAL = 15000;

/**
 * 关闭站点时提交的 status 值。
 * TODO(团队待确认)：暂用 2（手动禁用）。team-lead 与用户确认后只需改这一个常量。
 */
const SITE_CLOSE_STATUS = 2;

export function UserPanel({ user }: { user: SafeUser }) {
  const toast = useToast();
  const [channel, setChannel] = useState<ChannelStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // silent=true 用于后台轮询：不切换整卡 loading，也不弹错误 toast
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

  // 队列仍有待上传 key 时，每 ~15s 静默轮询刷新进度；pending=0 或卸载即停
  const poolPending = channel?.poolPending ?? 0;
  useEffect(() => {
    if (poolPending <= 0) return;
    const timer = window.setInterval(() => {
      fetchChannel(true);
    }, POLL_INTERVAL);
    return () => window.clearInterval(timer);
  }, [poolPending, fetchChannel]);

  // 站点开关成功后，用后端返回的最新 sites 就地刷新渠道状态
  const handleSitesChange = useCallback((sites: SiteScheduleStatus[]) => {
    setChannel((prev) => (prev ? { ...prev, sites } : prev));
  }, []);

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <ChannelCard
        user={user}
        channel={channel}
        loading={loading}
        onRefresh={() => fetchChannel(false)}
        onSitesChange={handleSitesChange}
      />
      <UploadCard onUploaded={() => fetchChannel(false)} />
    </div>
  );
}

/* ============ 我的渠道卡 ============ */

function ChannelCard({
  user,
  channel,
  loading,
  onRefresh,
  onSitesChange,
}: {
  user: SafeUser;
  channel: ChannelStatus | null;
  loading: boolean;
  onRefresh: () => void;
  onSitesChange: (sites: SiteScheduleStatus[]) => void;
}) {
  const sites = channel?.sites ?? [];
  return (
    <Card
      title="我的渠道"
      subtitle={`绑定渠道名：${user.channelName}`}
      actions={
        <Button variant="secondary" onClick={onRefresh} loading={loading}>
          刷新
        </Button>
      }
    >
      {loading ? (
        <div className="flex items-center gap-2 py-6 text-sm text-slate-400">
          <Spinner className="h-4 w-4" /> 加载中…
        </div>
      ) : (
        <div className="space-y-4">
          <ChannelStatusView channel={channel} />
          {sites.length > 0 && (
            <SiteScheduleSection sites={sites} onSitesChange={onSitesChange} />
          )}
        </div>
      )}
    </Card>
  );
}

/* ============ 站点调度（每站开关） ============ */

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

/** 纯 Tailwind 开关：on=开启，busy 时禁用 */
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

/**
 * 站点调度区：列出三站，每行 站点名 + 状态徽章 + 开关。
 * 开→POST status:1；关→POST status:SITE_CLOSE_STATUS。请求中禁用全部开关防重复，
 * 成功用返回 sites 就地刷新，失败 toast；卸载后不再 setState。
 */
function SiteScheduleSection({
  sites,
  onSitesChange,
}: {
  sites: SiteScheduleStatus[];
  onSitesChange: (sites: SiteScheduleStatus[]) => void;
}) {
  const toast = useToast();
  const [busyId, setBusyId] = useState<number | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function toggle(site: SiteScheduleStatus, on: boolean) {
    if (busyId != null) return; // 一次只处理一个请求，防重复点击
    const status = on ? 1 : SITE_CLOSE_STATUS;
    setBusyId(site.site_id);
    try {
      const res = await apiFetch<{ sites: SiteScheduleStatus[] }>(
        "/api/my/site-status",
        {
          method: "POST",
          body: JSON.stringify({ siteId: site.site_id, status }),
        }
      );
      if (!mounted.current) return;
      onSitesChange(res.sites ?? []);
      toast.success(`${site.site_name} 已${on ? "开启" : "关闭"}`);
    } catch (err) {
      if (!mounted.current) return;
      toast.error(err instanceof Error ? err.message : "操作失败");
    } finally {
      if (mounted.current) setBusyId(null);
    }
  }

  return (
    <div>
      <div className="mb-1 text-xs font-medium text-slate-500">站点调度</div>
      <div className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200">
        {sites.map((s) => {
          const on = s.status === 1;
          const busy = busyId === s.site_id;
          return (
            <div
              key={s.site_id}
              className="flex items-center justify-between gap-3 px-3 py-2.5"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-slate-700">
                  {s.site_name}
                </div>
                <div className="mt-0.5 text-xs text-slate-400">
                  站点 #{s.site_id}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {siteBadge(s.status)}
                {busy && <Spinner className="h-4 w-4 text-slate-400" />}
                <Toggle
                  on={on}
                  disabled={busyId != null}
                  onChange={(next) => toggle(s, next)}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ============ 上传 Key 卡 ============ */

function UploadCard({ onUploaded }: { onUploaded: () => void }) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<UploadQueueResult | null>(null);

  const lineCount = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean).length;

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
      setResult(res);
      setText("");
      toast.success(
        `已加入队列：新增 ${res.added} 个，待上传 ${res.poolPending}，已上传 ${res.poolUploaded}`
      );
      onUploaded();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "上传失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card
      title="上传 Key"
      subtitle="每行一个 key，提交后入本地队列，由定时引擎按每批数量批量上传"
    >
      <div className="space-y-3">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={8}
          placeholder={"sk-ant-api03-xxxx\nsk-ant-api03-yyyy"}
          className="w-full resize-y rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs text-slate-800 outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
        />
        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-400">
            识别到 {lineCount} 行有效 key
          </span>
          <Button onClick={submit} loading={loading}>
            提交上传
          </Button>
        </div>

        {result && (
          <div className="rounded-lg border border-slate-200 bg-slate-50/50 p-3">
            <UploadResultView result={result} />
          </div>
        )}
      </div>
    </Card>
  );
}
