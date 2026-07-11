"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { LogEntry, SafeUser } from "@/lib/types";
import { apiFetch } from "@/lib/client";
import { useToast } from "@/components/Toast";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  CopyButton,
  Modal,
  Spinner,
  TextInput,
} from "@/components/ui";
import { AdminChannelCard } from "@/components/AdminChannelCard";
import { UserEditorModal } from "@/components/UserEditorModal";
import { UploadKeyModal } from "@/components/UploadKeyModal";
import {
  ChannelStatusView,
  type ChannelStatus,
} from "@/components/ChannelStatusView";

/** 兼容后端返回 {users:[...]} 或直接数组 */
function toArray<T>(data: unknown, key: string): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === "object") {
    const v = (data as Record<string, unknown>)[key];
    if (Array.isArray(v)) return v as T[];
  }
  return [];
}

type AdminTab = "upload" | "channel" | "config";

const ADMIN_TABS: { key: AdminTab; label: string }[] = [
  { key: "upload", label: "📤 Key上传管理" },
  { key: "channel", label: "📊 渠道管理" },
  { key: "config", label: "⚙️ 系统配置" },
];

export function AdminPanel() {
  const [tab, setTab] = useState<AdminTab>("upload");

  return (
    <div className="space-y-4">
      {/* Tab 导航 */}
      <div className="flex gap-1 rounded-xl bg-slate-100 p-1 w-fit">
        {ADMIN_TABS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium transition ${
              tab === key
                ? "bg-white text-slate-800 shadow-sm"
                : "text-slate-500 hover:text-slate-700"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "upload" && (
        <>
          <UploadLimitCard />
          <UsersCard />
          <LogsCard />
        </>
      )}
      {tab === "channel" && <AdminChannelCard />}
      {tab === "config" && <ConfigCard />}
    </div>
  );
}

/* ============ 系统配置卡 ============ */

/** GET /api/admin/config 返回 shape（密码不回传明文，仅返回是否已设置） */
interface ConfigResponse {
  naciBaseUrl: string;
  naciUsername: string;
  hasNaciPassword: boolean;
  /** 新建渠道使用的模型列表（逗号分隔，管理员可配） */
  models: string;
  /** 聚合 key 数量：每个新建渠道聚合多少个 key */
  uploadBatchSize: number;
  /** 每批处理数量：每轮/每次处理多少个 key */
  processBatchSize: number;
  /** 是否启用自动补 key（按间隔从本地队列批量上传） */
  autoRefillEnabled: boolean;
  /** 定时引擎补给间隔（分钟，1~1440） */
  refillIntervalMinutes: number;
  /** 优先级 6 渠道数量上限（本地检测配额，0~1000） */
  priority6Limit: number;
  /** 退化降级检测间隔（秒，5~86400） */
  demoteIntervalSeconds: number;
  /** 退化判定宽限期（秒，0~86400） */
  demoteGraceSeconds: number;
  /** 用量刷新频率（分钟，1~1440） */
  usageRefreshIntervalMinutes: number;
  /** 每渠道最多刷新用量次数（0~100） */
  usageMaxUpdates: number;
  /** 全局上传限速·个数（窗口内最多上传 key 数，0=不限速） */
  globalUploadLimitCount: number;
  /** 全局上传限速窗口（分钟，1~1440） */
  globalUploadLimitWindowMinutes: number;
  /** 用户默认上传限速·个数（0=不限速；可被单用户覆盖） */
  userUploadLimitCount: number;
  /** 用户默认上传限速窗口（分钟，1~1440） */
  userUploadLimitWindowMinutes: number;
  /** 是否允许普通用户手动上传（false=只能录入本地库，由引擎自动推站点） */
  userManualUploadEnabled: boolean;
  /** 仅使用高优先级渠道：只在有空闲优先级6名额时建渠道，不降级到5 */
  onlyHighPriorityEnabled: boolean;
  /** 全局禁止上传总闸：true=所有上传/提交端点拒绝 */
  uploadDisabled: boolean;
  /** 用户渠道查询限流：每 N 秒最多一次（0=不限） */
  userQueryIntervalSeconds: number;
  /** 用户报表拉取限流：每 N 分钟最多一次（0=不限） */
  userReportIntervalMinutes: number;
}

const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_PROCESS_BATCH = 20;
const DEFAULT_INTERVAL_MINUTES = 1;
const DEFAULT_PRIORITY6_LIMIT = 6;
const DEFAULT_DEMOTE_INTERVAL_SEC = 30;
const DEFAULT_DEMOTE_GRACE_SEC = 30;
const DEFAULT_USAGE_REFRESH_MIN = 10;
const DEFAULT_USAGE_MAX_UPDATES = 3;
const DEFAULT_UPLOAD_LIMIT_COUNT = 0; // 0=不限速
const DEFAULT_UPLOAD_LIMIT_WINDOW = 10;
const DEFAULT_QUERY_INTERVAL_SEC = 3; // 用户查询限流：每 3 秒一次
const DEFAULT_REPORT_INTERVAL_MIN = 3; // 用户报表限流：每 3 分钟一次
const DEFAULT_MODELS = "claude-opus-4-6,claude-opus-4-7,claude-opus-4-8";

function ConfigCard() {
  const toast = useToast();
  const [baseUrl, setBaseUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [hasPassword, setHasPassword] = useState(false);
  const [models, setModels] = useState<string>(DEFAULT_MODELS);
  const [batchSize, setBatchSize] = useState<number>(DEFAULT_BATCH_SIZE);
  const [processBatch, setProcessBatch] = useState<number>(DEFAULT_PROCESS_BATCH);
  const [intervalMin, setIntervalMin] = useState<number>(
    DEFAULT_INTERVAL_MINUTES
  );
  const [priority6Limit, setPriority6Limit] = useState<number>(
    DEFAULT_PRIORITY6_LIMIT
  );
  const [demoteInterval, setDemoteInterval] = useState<number>(
    DEFAULT_DEMOTE_INTERVAL_SEC
  );
  const [demoteGrace, setDemoteGrace] = useState<number>(
    DEFAULT_DEMOTE_GRACE_SEC
  );
  const [usageRefresh, setUsageRefresh] = useState<number>(
    DEFAULT_USAGE_REFRESH_MIN
  );
  const [usageMax, setUsageMax] = useState<number>(DEFAULT_USAGE_MAX_UPDATES);
  const [gLimitCount, setGLimitCount] = useState<number>(
    DEFAULT_UPLOAD_LIMIT_COUNT
  );
  const [gLimitWindow, setGLimitWindow] = useState<number>(
    DEFAULT_UPLOAD_LIMIT_WINDOW
  );
  const [uLimitCount, setULimitCount] = useState<number>(
    DEFAULT_UPLOAD_LIMIT_COUNT
  );
  const [uLimitWindow, setULimitWindow] = useState<number>(
    DEFAULT_UPLOAD_LIMIT_WINDOW
  );
  const [qryInterval, setQryInterval] = useState<number>(
    DEFAULT_QUERY_INTERVAL_SEC
  );
  const [rptInterval, setRptInterval] = useState<number>(
    DEFAULT_REPORT_INTERVAL_MIN
  );
  const [autoRefill, setAutoRefill] = useState(true);
  // 全局「禁止用户手动上传」：state 存「是否允许」，UI 展示取反为「禁止」
  const [manualUploadEnabled, setManualUploadEnabled] = useState(true);
  // 仅使用高优先级渠道
  const [onlyHighPriority, setOnlyHighPriority] = useState(false);
  // 全局禁止上传总闸
  const [uploadDisabled, setUploadDisabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pinging, setPinging] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [pingUser, setPingUser] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<ConfigResponse>("/api/admin/config");
      if (!mounted.current) return;
      setBaseUrl(data.naciBaseUrl ?? "");
      setUsername(data.naciUsername ?? "");
      setHasPassword(Boolean(data.hasNaciPassword));
      setModels(
        typeof data.models === "string" && data.models.trim()
          ? data.models
          : DEFAULT_MODELS
      );
      setBatchSize(
        typeof data.uploadBatchSize === "number" && data.uploadBatchSize > 0
          ? data.uploadBatchSize
          : DEFAULT_BATCH_SIZE
      );
      setProcessBatch(
        typeof data.processBatchSize === "number" && data.processBatchSize > 0
          ? data.processBatchSize
          : DEFAULT_PROCESS_BATCH
      );
      setIntervalMin(
        typeof data.refillIntervalMinutes === "number" &&
          data.refillIntervalMinutes > 0
          ? data.refillIntervalMinutes
          : DEFAULT_INTERVAL_MINUTES
      );
      setPriority6Limit(
        typeof data.priority6Limit === "number" && data.priority6Limit >= 0
          ? data.priority6Limit
          : DEFAULT_PRIORITY6_LIMIT
      );
      setDemoteInterval(
        typeof data.demoteIntervalSeconds === "number" &&
          data.demoteIntervalSeconds >= 5
          ? data.demoteIntervalSeconds
          : DEFAULT_DEMOTE_INTERVAL_SEC
      );
      setDemoteGrace(
        typeof data.demoteGraceSeconds === "number" &&
          data.demoteGraceSeconds >= 0
          ? data.demoteGraceSeconds
          : DEFAULT_DEMOTE_GRACE_SEC
      );
      setUsageRefresh(
        typeof data.usageRefreshIntervalMinutes === "number" &&
          data.usageRefreshIntervalMinutes > 0
          ? data.usageRefreshIntervalMinutes
          : DEFAULT_USAGE_REFRESH_MIN
      );
      setUsageMax(
        typeof data.usageMaxUpdates === "number" && data.usageMaxUpdates >= 0
          ? data.usageMaxUpdates
          : DEFAULT_USAGE_MAX_UPDATES
      );
      setGLimitCount(
        typeof data.globalUploadLimitCount === "number" &&
          data.globalUploadLimitCount >= 0
          ? data.globalUploadLimitCount
          : DEFAULT_UPLOAD_LIMIT_COUNT
      );
      setGLimitWindow(
        typeof data.globalUploadLimitWindowMinutes === "number" &&
          data.globalUploadLimitWindowMinutes > 0
          ? data.globalUploadLimitWindowMinutes
          : DEFAULT_UPLOAD_LIMIT_WINDOW
      );
      setULimitCount(
        typeof data.userUploadLimitCount === "number" &&
          data.userUploadLimitCount >= 0
          ? data.userUploadLimitCount
          : DEFAULT_UPLOAD_LIMIT_COUNT
      );
      setULimitWindow(
        typeof data.userUploadLimitWindowMinutes === "number" &&
          data.userUploadLimitWindowMinutes > 0
          ? data.userUploadLimitWindowMinutes
          : DEFAULT_UPLOAD_LIMIT_WINDOW
      );
      setQryInterval(
        typeof data.userQueryIntervalSeconds === "number" &&
          data.userQueryIntervalSeconds >= 0
          ? data.userQueryIntervalSeconds
          : DEFAULT_QUERY_INTERVAL_SEC
      );
      setRptInterval(
        typeof data.userReportIntervalMinutes === "number" &&
          data.userReportIntervalMinutes >= 0
          ? data.userReportIntervalMinutes
          : DEFAULT_REPORT_INTERVAL_MIN
      );
      setAutoRefill(Boolean(data.autoRefillEnabled));
      setManualUploadEnabled(
        typeof data.userManualUploadEnabled === "boolean"
          ? data.userManualUploadEnabled
          : true
      );
      setOnlyHighPriority(Boolean(data.onlyHighPriorityEnabled));
      setUploadDisabled(Boolean(data.uploadDisabled));
      setPassword("");
    } catch (err) {
      if (!mounted.current) return;
      toast.error(err instanceof Error ? err.message : "读取配置失败");
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    const naciBaseUrl = baseUrl.trim();
    if (!naciBaseUrl) {
      toast.error("naciBaseUrl 不能为空");
      return;
    }
    // 聚合 key 数量夹到 1~1000
    const safeBatch = Math.min(
      1000,
      Math.max(1, Math.round(Number(batchSize) || DEFAULT_BATCH_SIZE))
    );
    // 每批处理数量夹到 1~10000
    const safeProcess = Math.min(
      10000,
      Math.max(1, Math.round(Number(processBatch) || DEFAULT_PROCESS_BATCH))
    );
    // 补给间隔夹到 1~1440 分钟
    const safeInterval = Math.min(
      1440,
      Math.max(1, Math.round(Number(intervalMin) || DEFAULT_INTERVAL_MINUTES))
    );
    // 优先级6上限夹到 0~1000（允许 0=永不用优先级6，故不能用 || 兜底）
    const p6raw = Number(priority6Limit);
    const safeP6 = Number.isNaN(p6raw)
      ? DEFAULT_PRIORITY6_LIMIT
      : Math.min(1000, Math.max(0, Math.round(p6raw)));
    // 退化降级检测间隔夹到 5~86400 秒
    const safeDemoteInterval = Math.min(
      86400,
      Math.max(5, Math.round(Number(demoteInterval) || DEFAULT_DEMOTE_INTERVAL_SEC))
    );
    // 宽限期夹到 0~86400 秒（允许 0=建后即可判定，故不能用 || 兜底）
    const graceRaw = Number(demoteGrace);
    const safeGrace = Number.isNaN(graceRaw)
      ? DEFAULT_DEMOTE_GRACE_SEC
      : Math.min(86400, Math.max(0, Math.round(graceRaw)));
    // 用量刷新频率夹到 1~1440 分钟
    const safeUsageRefresh = Math.min(
      1440,
      Math.max(1, Math.round(Number(usageRefresh) || DEFAULT_USAGE_REFRESH_MIN))
    );
    // 每渠道最多刷新用量次数夹到 0~100（允许 0=不刷新，故不能用 || 兜底）
    const usageMaxRaw = Number(usageMax);
    const safeUsageMax = Number.isNaN(usageMaxRaw)
      ? DEFAULT_USAGE_MAX_UPDATES
      : Math.min(100, Math.max(0, Math.round(usageMaxRaw)));
    // 上传限速·个数允许 0=不限速（不能用 || 兜底）；窗口夹到 1~1440 分钟
    const gCountRaw = Number(gLimitCount);
    const safeGCount = Number.isNaN(gCountRaw)
      ? DEFAULT_UPLOAD_LIMIT_COUNT
      : Math.min(1_000_000, Math.max(0, Math.round(gCountRaw)));
    const safeGWindow = Math.min(
      1440,
      Math.max(1, Math.round(Number(gLimitWindow) || DEFAULT_UPLOAD_LIMIT_WINDOW))
    );
    const uCountRaw = Number(uLimitCount);
    const safeUCount = Number.isNaN(uCountRaw)
      ? DEFAULT_UPLOAD_LIMIT_COUNT
      : Math.min(1_000_000, Math.max(0, Math.round(uCountRaw)));
    const safeUWindow = Math.min(
      1440,
      Math.max(1, Math.round(Number(uLimitWindow) || DEFAULT_UPLOAD_LIMIT_WINDOW))
    );
    // 查询/报表限流间隔允许 0=不限（不能用 || 兜底）
    const qryRaw = Number(qryInterval);
    const safeQryInterval = Number.isNaN(qryRaw)
      ? DEFAULT_QUERY_INTERVAL_SEC
      : Math.min(3600, Math.max(0, Math.round(qryRaw)));
    const rptRaw = Number(rptInterval);
    const safeRptInterval = Number.isNaN(rptRaw)
      ? DEFAULT_REPORT_INTERVAL_MIN
      : Math.min(1440, Math.max(0, Math.round(rptRaw)));
    setSaving(true);
    try {
      // naciPassword 留空 = 保持原密码不变（后端约定）
      await apiFetch("/api/admin/config", {
        method: "PUT",
        body: JSON.stringify({
          naciBaseUrl,
          naciUsername: username.trim(),
          naciPassword: password,
          models: models.trim() || DEFAULT_MODELS,
          uploadBatchSize: safeBatch,
          processBatchSize: safeProcess,
          autoRefillEnabled: autoRefill,
          refillIntervalMinutes: safeInterval,
          priority6Limit: safeP6,
          demoteIntervalSeconds: safeDemoteInterval,
          demoteGraceSeconds: safeGrace,
          usageRefreshIntervalMinutes: safeUsageRefresh,
          usageMaxUpdates: safeUsageMax,
          globalUploadLimitCount: safeGCount,
          globalUploadLimitWindowMinutes: safeGWindow,
          userUploadLimitCount: safeUCount,
          userUploadLimitWindowMinutes: safeUWindow,
          userManualUploadEnabled: manualUploadEnabled,
          onlyHighPriorityEnabled: onlyHighPriority,
          uploadDisabled,
          userQueryIntervalSeconds: safeQryInterval,
          userReportIntervalMinutes: safeRptInterval,
        }),
      });
      toast.success("配置已保存");
      setPassword("");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function ping() {
    setPinging(true);
    setPingUser(null);
    try {
      const res = await apiFetch<{ userId: number; username: string }>(
        "/api/ping"
      );
      setPingUser(res.username);
      toast.success(`已登录 naci: ${res.username}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "连接失败");
    } finally {
      setPinging(false);
    }
  }

  return (
    <Card
      title="系统配置"
      subtitle="naci 连接凭据与全部运行参数；字段说明悬停 ⓘ 查看"
      actions={
        <>
          <Button variant="secondary" onClick={ping} loading={pinging}>
            测试连接
          </Button>
          <Button onClick={save} loading={saving}>
            保存
          </Button>
        </>
      }
    >
      {loading ? (
        <LoadingRow />
      ) : (
        <div className="space-y-4">
          {/* 全局禁止上传总闸：放最顶、做成大号开关，一眼可见 */}
          <button
            type="button"
            onClick={() => setUploadDisabled((v) => !v)}
            className={`flex w-full items-center justify-between rounded-xl border-2 px-4 py-3 text-left transition ${
              uploadDisabled
                ? "border-rose-300 bg-rose-50"
                : "border-slate-200 bg-white hover:bg-slate-50"
            }`}
          >
            <div>
              <div
                className={`text-sm font-semibold ${
                  uploadDisabled ? "text-rose-700" : "text-slate-700"
                }`}
              >
                🚫 全局禁止上传（总闸）
              </div>
              <div className="mt-0.5 text-xs text-slate-500">
                {uploadDisabled
                  ? "已开启：所有人（含管理员代传）都无法提交 key，前端上传按钮全部禁用；不影响引擎消化本地池。改动需点「保存」生效"
                  : "关闭中：上传正常。开启后立即拦截所有人工上传，用于紧急停摆 / naci 维护。改动需点「保存」生效"}
              </div>
            </div>
            <span
              className={`relative ml-4 inline-flex h-7 w-12 shrink-0 items-center rounded-full transition ${
                uploadDisabled ? "bg-rose-500" : "bg-slate-300"
              }`}
            >
              <span
                className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${
                  uploadDisabled ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </span>
          </button>

          <ConfigSection title="连接配置" desc="naci 后端登录凭据与建渠道模型">
            <CompactField label="naciBaseUrl">
              <TextInput
                className="py-1.5"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://open.naci-tech.com"
              />
            </CompactField>
            <CompactField label="登录用户名">
              <TextInput
                className="py-1.5"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="naci 登录用户名"
                autoComplete="off"
              />
            </CompactField>
            <CompactField
              label="登录密码"
              hint={hasPassword ? "已设置（留空则不修改）" : "未设置"}
            >
              <div className="flex gap-2">
                <TextInput
                  className="py-1.5"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={hasPassword ? "已设置（留空不改）" : "未设置"}
                  autoComplete="new-password"
                />
                <Button
                  variant="secondary"
                  type="button"
                  className="!py-1.5"
                  onClick={() => setShowPassword((v) => !v)}
                >
                  {showPassword ? "隐藏" : "显示"}
                </Button>
              </div>
            </CompactField>
            <CompactField
              label="模型列表"
              hint="新建渠道使用的模型，逗号分隔；默认 claude-opus-4-6,claude-opus-4-7,claude-opus-4-8"
              className="sm:col-span-2 lg:col-span-3 xl:col-span-4"
            >
              <textarea
                value={models}
                onChange={(e) => setModels(e.target.value)}
                rows={2}
                placeholder={DEFAULT_MODELS}
                className="w-full resize-y rounded-lg border border-slate-300 px-3 py-1.5 font-mono text-xs text-slate-800 outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
              />
            </CompactField>
          </ConfigSection>

          <ConfigSection title="基础设置" desc="建渠道聚合数量与定时补给">
            <NumField
              label="聚合 key 数量"
              hint="每个新建渠道里聚合多少个 key（1~1000）"
              min={1}
              max={1000}
              value={batchSize}
              onChange={setBatchSize}
              placeholder={String(DEFAULT_BATCH_SIZE)}
            />
            <NumField
              label="每批处理数量"
              hint="每轮/每次处理多少个 key，拆成 ⌈处理数/聚合数⌉ 个渠道（1~10000）"
              min={1}
              max={10000}
              value={processBatch}
              onChange={setProcessBatch}
              placeholder={String(DEFAULT_PROCESS_BATCH)}
            />
            <NumField
              label="补给间隔（分钟）"
              hint="定时引擎每 N 分钟检查并按需补给一次，1~1440，改后下一轮生效"
              min={1}
              max={1440}
              value={intervalMin}
              onChange={setIntervalMin}
              placeholder={String(DEFAULT_INTERVAL_MINUTES)}
            />
            <CheckField
              label="自动建渠道"
              hint="关闭后定时引擎不再自动建渠道；手动「上传一批 / 直接上传」按钮仍可用"
              checked={autoRefill}
              onChange={setAutoRefill}
            />
          </ConfigSection>

          <ConfigSection title="高优先级渠道" desc="优先级6配额与自动降级">
            <NumField
              label="优先级6渠道上限"
              hint="本地已建优先级6渠道达到此数即改用优先级5创建（账号配额6，0~1000）"
              min={0}
              max={1000}
              value={priority6Limit}
              onChange={setPriority6Limit}
              placeholder={String(DEFAULT_PRIORITY6_LIMIT)}
            />
            <NumField
              label="退化检测间隔（秒）"
              hint="每 N 秒用一次 status-batch 检测高优先级渠道，任一站点禁用即降到5；下限5秒防打爆naci，5~86400"
              min={5}
              max={86400}
              value={demoteInterval}
              onChange={setDemoteInterval}
              placeholder={String(DEFAULT_DEMOTE_INTERVAL_SEC)}
            />
            <NumField
              label="退化判定宽限期（秒）"
              hint="渠道建后超过此时长才纳入降级判定，避免刚建误判；0=建后即判，0~86400"
              min={0}
              max={86400}
              value={demoteGrace}
              onChange={setDemoteGrace}
              placeholder={String(DEFAULT_DEMOTE_GRACE_SEC)}
            />
            <NumField
              label="用量刷新频率（分钟）"
              hint="后台每 N 分钟批量拉一次 used-quota 更新渠道用量缓存，1~1440"
              min={1}
              max={1440}
              value={usageRefresh}
              onChange={setUsageRefresh}
              placeholder={String(DEFAULT_USAGE_REFRESH_MIN)}
            />
            <NumField
              label="每渠道最多刷新次数"
              hint="前 N 次按频率刷新，刷够后等 1 小时补最后一次，之后永久冻结；0=不刷新用量，0~100"
              min={0}
              max={100}
              value={usageMax}
              onChange={setUsageMax}
              placeholder={String(DEFAULT_USAGE_MAX_UPDATES)}
            />
            <CheckField
              label="仅使用高优先级渠道"
              hint="开启后只在有空闲优先级6名额时才建渠道（不降级到5）；名额满则 key 留池等回收，多用户按轮转公平分配"
              checked={onlyHighPriority}
              onChange={setOnlyHighPriority}
            />
          </ConfigSection>

          <ConfigSection
            title="上传限速与管控"
            desc="全站限速与「禁止用户手动上传」总开关"
          >
            <NumField
              label="全局上传限速·个数"
              hint="滚动窗口内全站最多上传多少个 key；0=不限速"
              min={0}
              max={1000000}
              value={gLimitCount}
              onChange={setGLimitCount}
              placeholder={String(DEFAULT_UPLOAD_LIMIT_COUNT)}
            />
            <NumField
              label="全局限速窗口（分钟）"
              hint="全局限速的滚动窗口长度，1~1440；格式即「N 分钟最多 X 个」"
              min={1}
              max={1440}
              value={gLimitWindow}
              onChange={setGLimitWindow}
              placeholder={String(DEFAULT_UPLOAD_LIMIT_WINDOW)}
            />
            <CheckField
              label="禁止用户手动上传"
              hint="开启后普通用户不能手动「上传一批 / 直接上传」，只能录入本地库，由引擎自动推站点；管理员代传不受限"
              checked={!manualUploadEnabled}
              onChange={(v) => setManualUploadEnabled(!v)}
              onText="已禁止"
              offText="未禁止（用户可手动）"
            />
          </ConfigSection>

          <ConfigSection
            title="默认用户与查询限流"
            desc="新用户默认上传限速（可按用户覆盖）；渠道查询/报表下载限流（Redis 桶）"
          >
            <NumField
              label="用户默认限速·个数"
              hint="每个用户窗口内最多上传多少个 key；0=不限速"
              min={0}
              max={1000000}
              value={uLimitCount}
              onChange={setULimitCount}
              placeholder={String(DEFAULT_UPLOAD_LIMIT_COUNT)}
            />
            <NumField
              label="用户默认限速窗口（分钟）"
              hint="用户默认限速的滚动窗口长度，1~1440"
              min={1}
              max={1440}
              value={uLimitWindow}
              onChange={setULimitWindow}
              placeholder={String(DEFAULT_UPLOAD_LIMIT_WINDOW)}
            />
            <NumField
              label="查询限流间隔（秒）"
              hint="用户渠道列表每 N 秒最多查询一次，超频直接报错；0=不限，0~3600"
              min={0}
              max={3600}
              value={qryInterval}
              onChange={setQryInterval}
              placeholder={String(DEFAULT_QUERY_INTERVAL_SEC)}
            />
            <NumField
              label="报表限流间隔（分钟）"
              hint="用户报表每 N 分钟最多下载一次，超频直接报错；0=不限，0~1440"
              min={0}
              max={1440}
              value={rptInterval}
              onChange={setRptInterval}
              placeholder={String(DEFAULT_REPORT_INTERVAL_MIN)}
            />
          </ConfigSection>

          {pingUser && (
            <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
              已登录 naci：<b>{pingUser}</b>
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

/** 系统配置分区（紧凑版）：标题与说明同一行，分区间细分隔线，字段直接排进密格栅。 */
function ConfigSection({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: string;
  children: ReactNode;
}) {
  return (
    <section className="border-t border-slate-100 pt-3 first:border-t-0 first:pt-0">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-2">
        <h4 className="text-sm font-semibold text-slate-800">{title}</h4>
        {desc && <span className="text-xs text-slate-400">{desc}</span>}
      </div>
      <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {children}
      </div>
    </section>
  );
}

/** 紧凑字段：长说明收进 ⓘ 的悬停提示（title），不再在输入框下占多行文字。 */
function CompactField({
  label,
  hint,
  className = "",
  children,
}: {
  label: string;
  hint?: string;
  /** 附加到外层 label 的类（如让字段横跨整行 col-span） */
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={`block ${className}`} title={hint}>
      <span className="mb-1 flex items-center gap-1 text-[13px] font-medium text-slate-700">
        {label}
        {hint && (
          <span className="cursor-help text-xs text-slate-300 hover:text-slate-500">
            ⓘ
          </span>
        )}
      </span>
      {children}
    </label>
  );
}

/** 紧凑数字输入字段（NaN 显示为空串，valueAsNumber 回写）。 */
function NumField({
  label,
  hint,
  min,
  max,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  hint?: string;
  min: number;
  max: number;
  value: number;
  onChange: (n: number) => void;
  placeholder?: string;
}) {
  return (
    <CompactField label={label} hint={hint}>
      <TextInput
        type="number"
        min={min}
        max={max}
        className="py-1.5"
        value={Number.isNaN(value) ? "" : value}
        onChange={(e) => onChange(e.target.valueAsNumber)}
        placeholder={placeholder}
      />
    </CompactField>
  );
}

/** 紧凑开关字段（高度与输入框对齐，保持行高一致）。 */
function CheckField({
  label,
  hint,
  checked,
  onChange,
  onText = "已开启",
  offText = "已关闭",
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  onText?: string;
  offText?: string;
}) {
  return (
    <CompactField label={label} hint={hint}>
      <span className="flex h-[34px] cursor-pointer items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-400"
        />
        {checked ? onText : offText}
      </span>
    </CompactField>
  );
}

/* ============ 上传限速状态卡 ============ */

/** GET /api/admin/upload-limit 返回 shape */
interface UploadLimitUsage {
  used: number;
  limit: number;
  windowMinutes: number;
  unlimited: boolean;
}

interface UploadLimitUserRow extends UploadLimitUsage {
  id: string;
  username: string;
  channelName: string;
  /** 是否为单用户自定义限速（而非全局默认） */
  isOverride: boolean;
  /** 高优先级配额：是否允许 / 已用 / 独立上限（null=仅受全局） */
  hpAllowed: boolean;
  hpUsed: number;
  hpLimit: number | null;
}

interface UploadLimitResponse {
  global: UploadLimitUsage;
  /** 全局高优先级(优先级6)配额：已用 / 上限 */
  highPriorityGlobal: { used: number; limit: number };
  users: UploadLimitUserRow[];
}

// 30s：该接口每轮做 getUsers + 每用户 N+1 子查询，管理页常驻，拉长间隔削减全表扫描频率
const UPLOAD_LIMIT_POLL_INTERVAL = 30000;

/** 用量文案：「已用 X / Y · Z分钟窗口」，不限速时「已用 X · 不限速」 */
function usageText(u: UploadLimitUsage): string {
  return u.unlimited
    ? `已用 ${u.used} · 不限速`
    : `已用 ${u.used} / ${u.limit} · ${u.windowMinutes}分钟窗口`;
}

/** 用量对应徽章色：不限速灰、被限中红、接近上限（≥80%）黄、正常绿 */
function usageTone(u: UploadLimitUsage): "slate" | "green" | "amber" | "rose" {
  if (u.unlimited) return "slate";
  if (u.used >= u.limit) return "rose";
  if (u.used >= u.limit * 0.8) return "amber";
  return "green";
}

/** 高优先级配额徽章色：满=红、接近（≥80%）=黄、正常=蓝。 */
function hpTone(used: number, limit: number): "blue" | "amber" | "rose" {
  if (limit > 0 && used >= limit) return "rose";
  if (limit > 0 && used >= limit * 0.8) return "amber";
  return "blue";
}

function UploadLimitCard() {
  const [data, setData] = useState<UploadLimitResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const d = await apiFetch<UploadLimitResponse>("/api/admin/upload-limit");
      if (mounted.current) setData(d);
    } catch {
      // 轮询失败静默（保留上次数据），避免 toast 刷屏
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    load();
    const t = setInterval(load, UPLOAD_LIMIT_POLL_INTERVAL);
    return () => {
      mounted.current = false;
      clearInterval(t);
    };
  }, [load]);

  return (
    <Card
      title="上传限速 / 高优先级配额状态"
      subtitle="滚动窗口限速用量与优先级6渠道配额（15 秒自动刷新）；阈值在上方系统配置 / 编辑用户中调整"
    >
      {loading && !data ? (
        <LoadingRow />
      ) : !data ? (
        <EmptyRow text="读取状态失败" />
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg bg-slate-50 px-3 py-2 text-sm">
            <span className="flex items-center gap-2">
              <span className="font-medium text-slate-700">全局限速</span>
              <Badge tone={usageTone(data.global)}>{usageText(data.global)}</Badge>
            </span>
            <span className="flex items-center gap-2">
              <span className="font-medium text-slate-700">全局高优先级</span>
              <Badge
                tone={hpTone(
                  data.highPriorityGlobal.used,
                  data.highPriorityGlobal.limit
                )}
              >
                已用 {data.highPriorityGlobal.used} / {data.highPriorityGlobal.limit}{" "}
                个优先级6
              </Badge>
            </span>
          </div>
          {data.users.length === 0 ? (
            <EmptyRow text="暂无用户" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px] text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs text-slate-400">
                    <th className="py-2 pr-3 font-medium">用户名</th>
                    <th className="py-2 pr-3 font-medium">渠道前缀</th>
                    <th className="py-2 pr-3 font-medium">窗口用量</th>
                    <th className="py-2 pr-3 font-medium">限速来源</th>
                    <th className="py-2 pr-3 font-medium">高优先级配额</th>
                  </tr>
                </thead>
                <tbody>
                  {data.users.map((u) => (
                    <tr key={u.id} className="border-b border-slate-100">
                      <td className="py-2 pr-3 text-slate-700">{u.username}</td>
                      <td className="py-2 pr-3 font-mono text-xs text-slate-500">
                        {u.channelName || "—"}
                      </td>
                      <td className="py-2 pr-3">
                        <Badge tone={usageTone(u)}>{usageText(u)}</Badge>
                      </td>
                      <td className="py-2 pr-3">
                        {u.isOverride ? (
                          <Badge tone="blue">自定义</Badge>
                        ) : (
                          <Badge tone="slate">全局默认</Badge>
                        )}
                      </td>
                      <td className="py-2 pr-3">
                        {!u.hpAllowed ? (
                          <Badge tone="slate">不可用</Badge>
                        ) : u.hpLimit != null ? (
                          <Badge tone={hpTone(u.hpUsed, u.hpLimit)}>
                            已用 {u.hpUsed} / {u.hpLimit}
                          </Badge>
                        ) : (
                          <Badge tone="blue">已用 {u.hpUsed} · 仅受全局</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

/* ============ 用户管理卡 ============ */

/** 列表行扩展：后端在 user 上附带的渠道动态字段（SafeUser 未必声明，按可选读取） */
interface AdminUserRow extends SafeUser {
  platformKeyCount?: number | null;
  deadKeyCount?: number | null;
  poolPending?: number;
  poolUploaded?: number;
  createdChannelCount?: number;
  /** 累计金额（美元），后端由缓存的聚合 used_quota 换算；null 表示尚无数据 */
  usedAmount?: number | null;
}

/** 美元金额展示：$ + 千分位 + 2 位小数（非数值按 $0.00）。 */
function fmtUsd(v?: number | null) {
  const n = typeof v === "number" && !Number.isNaN(v) ? v : 0;
  return `$${n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** 用户列表轮询间隔（毫秒）。该接口每轮 3 个全表扫描(getUsers+poolCountsAll+createdChannelCountsAll)，
 * 管理页常驻，30s 足够新鲜且把全表扫描频率减半。 */
const USERS_POLL_INTERVAL = 30000;

/**
 * 「可用/总数」单元格：可用 = 平台 Key − 禁用 Key。
 * 平台 Key 缺失显示「-」；可用为 0 且总数>0 时整体红色并附「自动禁用」小字，
 * 让 status 仍显示「启用」但 key 全死的渠道一眼可辨。
 */
function KeyUsageCell({ row }: { row: AdminUserRow }) {
  if (row.platformKeyCount == null) {
    return <span className="text-slate-400">-</span>;
  }
  const total = row.platformKeyCount;
  const alive = total - (row.deadKeyCount ?? 0);
  const exhausted = alive === 0 && total > 0;
  return (
    <span className={exhausted ? "text-rose-600" : "text-slate-600"}>
      <span className="font-medium">{alive}</span>
      <span className={exhausted ? "text-rose-400" : "text-slate-400"}>
        {" / "}
        {total}
      </span>
      {exhausted && (
        <span className="ml-1 align-middle text-[10px] font-medium text-rose-500">
          自动禁用
        </span>
      )}
    </span>
  );
}

function UsersCard() {
  const toast = useToast();
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<SafeUser | null>(null);

  const [uploadTarget, setUploadTarget] = useState<SafeUser | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SafeUser | null>(null);
  const [deleting, setDeleting] = useState(false);

  // 查看某用户渠道状态
  const [channelTarget, setChannelTarget] = useState<SafeUser | null>(null);
  const [channelData, setChannelData] = useState<ChannelStatus | null>(null);
  const [channelLoading, setChannelLoading] = useState(false);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // silent=true 用于后台轮询：不切整卡 loading，也不弹错误 toast
  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const data = await apiFetch("/api/admin/users");
        if (!mounted.current) return;
        setUsers(toArray<AdminUserRow>(data, "users"));
        setLastRefreshedAt(new Date());
      } catch (err) {
        if (!mounted.current) return;
        if (!silent) {
          toast.error(err instanceof Error ? err.message : "读取用户失败");
        }
      } finally {
        if (mounted.current && !silent) setLoading(false);
      }
    },
    [toast]
  );

  useEffect(() => {
    load(false);
  }, [load]);

  // 每 ~15s 静默轮询刷新列表（渠道动态/队列进度），卸载清 interval
  useEffect(() => {
    const timer = window.setInterval(() => {
      load(true);
    }, USERS_POLL_INTERVAL);
    return () => window.clearInterval(timer);
  }, [load]);

  function openCreate() {
    setEditTarget(null);
    setEditorOpen(true);
  }
  function openEdit(u: SafeUser) {
    setEditTarget(u);
    setEditorOpen(true);
  }

  async function openChannel(u: SafeUser) {
    setChannelTarget(u);
    setChannelData(null);
    setChannelLoading(true);
    try {
      const data = await apiFetch<{ channel: ChannelStatus }>(
        `/api/admin/users/${u.id}/channel`
      );
      setChannelData(data.channel);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "读取渠道状态失败");
    } finally {
      setChannelLoading(false);
    }
  }

  // 管理员手动一键回退优先级（6→5），完成后就地刷新弹窗里的渠道数据
  async function demoteChannel(channelId: number) {
    try {
      const res = await apiFetch<{
        channelName: string;
        from: number;
        to: number;
      }>("/api/admin/channels/demote", {
        method: "POST",
        body: JSON.stringify({ channelId }),
      });
      toast.success(`已回退 ${res.channelName} 优先级 ${res.from}→${res.to}`);
      if (channelTarget) {
        const data = await apiFetch<{ channel: ChannelStatus }>(
          `/api/admin/users/${channelTarget.id}/channel`
        );
        setChannelData(data.channel);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "回退优先级失败");
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await apiFetch(`/api/admin/users/${deleteTarget.id}`, { method: "DELETE" });
      toast.success("已删除");
      setDeleteTarget(null);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "删除失败");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Card
      title="用户管理"
      subtitle="每个用户对应一个访问密钥与一个渠道前缀"
      actions={
        <>
          {lastRefreshedAt && (
            <span className="hidden text-xs text-slate-400 sm:inline">
              自动刷新中 · 最后 {" "}
              {lastRefreshedAt.toLocaleTimeString("zh-CN", { hour12: false })}
            </span>
          )}
          <Button onClick={openCreate}>新建用户</Button>
        </>
      }
    >
      {loading ? (
        <LoadingRow />
      ) : users.length === 0 ? (
        <EmptyRow text="暂无用户" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1160px] text-sm">
            <thead className="text-left text-xs text-slate-500">
              <tr className="border-b border-slate-100">
                <th className="py-2 pr-3 font-medium">用户名</th>
                <th className="py-2 pr-3 font-medium">角色</th>
                <th className="py-2 pr-3 font-medium">渠道前缀</th>
                <th className="py-2 pr-3 text-right font-medium">已建渠道</th>
                <th className="py-2 pr-3 text-right font-medium">可用/平台Key</th>
                <th className="py-2 pr-3 text-right font-medium">禁用</th>
                <th className="py-2 pr-3 text-right font-medium">累计金额</th>
                <th className="py-2 pr-3 text-right font-medium">待上传</th>
                <th className="py-2 pr-3 text-right font-medium">已上传</th>
                <th className="py-2 pr-3 font-medium">访问密钥</th>
                <th className="py-2 pr-3 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {users.map((u) => (
                <tr key={u.id} className="align-middle">
                  <td className="py-2 pr-3 font-medium text-slate-800">
                    {u.username}
                  </td>
                  <td className="py-2 pr-3">
                    <Badge tone={u.role === "admin" ? "blue" : "slate"}>
                      {u.role}
                    </Badge>
                  </td>
                  <td className="py-2 pr-3 text-slate-600">{u.channelName}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {(u.createdChannelCount ?? 0) > 0 ? (
                      <Badge tone="green">{u.createdChannelCount}</Badge>
                    ) : (
                      <Badge tone="slate">0</Badge>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    <KeyUsageCell row={u} />
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {u.deadKeyCount == null ? (
                      <span className="text-slate-400">-</span>
                    ) : (
                      <span
                        className={
                          u.deadKeyCount > 0 ? "text-rose-600" : "text-slate-600"
                        }
                      >
                        {u.deadKeyCount}
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {u.usedAmount == null ? (
                      <span className="text-slate-400">-</span>
                    ) : (
                      <span className="font-medium text-emerald-600">
                        {fmtUsd(u.usedAmount)}
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    <span
                      className={
                        (u.poolPending ?? 0) > 0
                          ? "text-amber-600"
                          : "text-slate-600"
                      }
                    >
                      {u.poolPending ?? 0}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-slate-600">
                    {u.poolUploaded ?? 0}
                  </td>
                  <td className="py-2 pr-3">
                    {u.accessKey ? (
                      <div className="flex items-center gap-2">
                        <code className="rounded bg-slate-50 px-1.5 py-0.5 text-xs text-slate-500">
                          {maskKey(u.accessKey)}
                        </code>
                        <CopyButton value={u.accessKey} />
                      </div>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    <div className="flex items-center justify-end gap-1">
                      {u.channelName && (
                        <Button variant="ghost" onClick={() => openChannel(u)}>
                          渠道状态
                        </Button>
                      )}
                      <Button variant="ghost" onClick={() => setUploadTarget(u)}>
                        代传 Key
                      </Button>
                      <Button variant="ghost" onClick={() => openEdit(u)}>
                        编辑
                      </Button>
                      <Button variant="danger" onClick={() => setDeleteTarget(u)}>
                        删除
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <UserEditorModal
        open={editorOpen}
        target={editTarget}
        onClose={() => setEditorOpen(false)}
        onSaved={() => load()}
      />

      <UploadKeyModal
        open={!!uploadTarget}
        title={uploadTarget ? `代传 Key · ${uploadTarget.username}` : "代传 Key"}
        directEndpoint={
          uploadTarget ? `/api/admin/users/${uploadTarget.id}/upload-direct` : ""
        }
        onClose={() => setUploadTarget(null)}
        onUploaded={() => load()}
      />

      <Modal
        open={!!channelTarget}
        title={
          channelTarget ? `渠道状态 · ${channelTarget.username}` : "渠道状态"
        }
        width="max-w-2xl"
        onClose={() => setChannelTarget(null)}
      >
        {channelLoading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-slate-400">
            <Spinner className="h-4 w-4" /> 加载中…
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-slate-500">
              渠道前缀：
              <b className="text-slate-700">{channelTarget?.channelName}</b>
            </p>
            <ChannelStatusView channel={channelData} onDemote={demoteChannel} />
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!deleteTarget}
        title="删除用户"
        message={
          <>
            确认删除用户 <b>{deleteTarget?.username}</b>？其访问密钥将立即失效。
          </>
        }
        confirmText="删除"
        loading={deleting}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </Card>
  );
}

/* ============ 日志卡 ============ */

function LogsCard() {
  const toast = useToast();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch("/api/logs");
      if (!mounted.current) return;
      setLogs(toArray<LogEntry>(data, "logs"));
    } catch (err) {
      if (!mounted.current) return;
      toast.error(err instanceof Error ? err.message : "读取日志失败");
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <Card
      title="操作日志"
      actions={
        <Button variant="secondary" onClick={load}>
          刷新
        </Button>
      }
    >
      {loading ? (
        <LoadingRow />
      ) : logs.length === 0 ? (
        <EmptyRow text="暂无日志" />
      ) : (
        <ul className="divide-y divide-slate-100 text-sm">
          {logs.map((log) => (
            <li key={log.id} className="flex items-start gap-3 py-2">
              <LogDot level={log.level} />
              <div className="min-w-0 flex-1">
                <p className="text-slate-700">{log.message}</p>
                <p className="mt-0.5 text-xs text-slate-400">
                  {formatTime(log.at)} · {log.actor}
                  {log.channelName ? ` · ${log.channelName}` : ""}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ============ 小工具 ============ */

function LoadingRow() {
  return (
    <div className="flex items-center gap-2 py-6 text-sm text-slate-400">
      <Spinner className="h-4 w-4" /> 加载中…
    </div>
  );
}

function EmptyRow({ text }: { text: string }) {
  return <p className="py-6 text-center text-sm text-slate-400">{text}</p>;
}

function LogDot({ level }: { level: LogEntry["level"] }) {
  const color =
    level === "error"
      ? "bg-rose-400"
      : level === "warn"
        ? "bg-amber-400"
        : level === "success"
          ? "bg-emerald-400"
          : "bg-slate-300";
  return <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${color}`} />;
}

function maskKey(k: string) {
  if (k.length <= 10) return k;
  return `${k.slice(0, 6)}…${k.slice(-4)}`;
}

function formatTime(at: string) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at;
  return d.toLocaleString("zh-CN", { hour12: false });
}
