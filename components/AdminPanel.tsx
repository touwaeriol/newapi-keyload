"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LogEntry, SafeUser } from "@/lib/types";
import { apiFetch } from "@/lib/client";
import { useToast } from "@/components/Toast";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  CopyButton,
  Field,
  Modal,
  Spinner,
  TextInput,
} from "@/components/ui";
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

export function AdminPanel() {
  return (
    <div className="space-y-6">
      <ConfigCard />
      <UsersCard />
      <LogsCard />
    </div>
  );
}

/* ============ 系统配置卡 ============ */

/** GET /api/admin/config 返回 shape（密码不回传明文，仅返回是否已设置） */
interface ConfigResponse {
  naciBaseUrl: string;
  naciUsername: string;
  hasNaciPassword: boolean;
  /** 每批上传数量（定时引擎每分钟从队列取的批量大小） */
  uploadBatchSize: number;
  /** 是否启用自动补 key（每分钟从本地队列批量上传） */
  autoRefillEnabled: boolean;
}

const DEFAULT_BATCH_SIZE = 20;

function ConfigCard() {
  const toast = useToast();
  const [baseUrl, setBaseUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [hasPassword, setHasPassword] = useState(false);
  const [batchSize, setBatchSize] = useState<number>(DEFAULT_BATCH_SIZE);
  const [autoRefill, setAutoRefill] = useState(true);
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
      setBatchSize(
        typeof data.uploadBatchSize === "number" && data.uploadBatchSize > 0
          ? data.uploadBatchSize
          : DEFAULT_BATCH_SIZE
      );
      setAutoRefill(Boolean(data.autoRefillEnabled));
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
    // 每批数量夹到 1~1000
    const safeBatch = Math.min(
      1000,
      Math.max(1, Math.round(Number(batchSize) || DEFAULT_BATCH_SIZE))
    );
    setSaving(true);
    try {
      // naciPassword 留空 = 保持原密码不变（后端约定）
      await apiFetch("/api/admin/config", {
        method: "PUT",
        body: JSON.stringify({
          naciBaseUrl,
          naciUsername: username.trim(),
          naciPassword: password,
          uploadBatchSize: safeBatch,
          autoRefillEnabled: autoRefill,
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
      subtitle="naci 账号密码（后端登录用，仅管理员可配）"
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
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="naciBaseUrl">
              <TextInput
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://open.naci-tech.com"
              />
            </Field>
            <Field label="登录用户名">
              <TextInput
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="naci 登录用户名"
                autoComplete="off"
              />
            </Field>
            <Field
              label="登录密码"
              hint={hasPassword ? "已设置（留空则不修改）" : "未设置"}
            >
              <div className="flex gap-2">
                <TextInput
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={hasPassword ? "已设置（留空不改）" : "未设置"}
                  autoComplete="new-password"
                />
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                >
                  {showPassword ? "隐藏" : "显示"}
                </Button>
              </div>
            </Field>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Field
              label="每批上传数量"
              hint="后端每分钟从本地队列批量上传，每批 N 个，上传后自动启用三站"
            >
              <TextInput
                type="number"
                min={1}
                max={1000}
                value={Number.isNaN(batchSize) ? "" : batchSize}
                onChange={(e) => setBatchSize(e.target.valueAsNumber)}
                placeholder={String(DEFAULT_BATCH_SIZE)}
              />
            </Field>
            <Field label="自动补 key" hint="关闭后队列不再自动上传，仅入池">
              <label className="flex cursor-pointer items-center gap-2 py-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={autoRefill}
                  onChange={(e) => setAutoRefill(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-400"
                />
                {autoRefill ? "已开启" : "已关闭"}
              </label>
            </Field>
          </div>

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

/* ============ 用户管理卡 ============ */

function UsersCard() {
  const toast = useToast();
  const [users, setUsers] = useState<SafeUser[]>([]);
  const [loading, setLoading] = useState(true);

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

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch("/api/admin/users");
      if (!mounted.current) return;
      setUsers(toArray<SafeUser>(data, "users"));
    } catch (err) {
      if (!mounted.current) return;
      toast.error(err instanceof Error ? err.message : "读取用户失败");
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
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
      subtitle="每个用户对应一个访问密钥与一个绑定渠道"
      actions={<Button onClick={openCreate}>新建用户</Button>}
    >
      {loading ? (
        <LoadingRow />
      ) : users.length === 0 ? (
        <EmptyRow text="暂无用户" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="text-left text-xs text-slate-500">
              <tr className="border-b border-slate-100">
                <th className="py-2 pr-3 font-medium">用户名</th>
                <th className="py-2 pr-3 font-medium">角色</th>
                <th className="py-2 pr-3 font-medium">绑定渠道</th>
                <th className="py-2 pr-3 font-medium">渠道状态</th>
                <th className="py-2 pr-3 font-medium">访问密钥</th>
                <th className="py-2 pr-3 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {users.map((u) => (
                <tr key={u.id} className="align-middle">
                  <td className="py-2.5 pr-3 font-medium text-slate-800">
                    {u.username}
                  </td>
                  <td className="py-2.5 pr-3">
                    <Badge tone={u.role === "admin" ? "blue" : "slate"}>
                      {u.role}
                    </Badge>
                  </td>
                  <td className="py-2.5 pr-3 text-slate-600">{u.channelName}</td>
                  <td className="py-2.5 pr-3">
                    {u.channelId ? (
                      <Badge tone="green">#{u.channelId}</Badge>
                    ) : (
                      <Badge tone="amber">未创建</Badge>
                    )}
                  </td>
                  <td className="py-2.5 pr-3">
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
                  <td className="py-2.5 pr-3">
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
        onSaved={load}
      />

      <UploadKeyModal
        open={!!uploadTarget}
        title={uploadTarget ? `代传 Key · ${uploadTarget.username}` : "代传 Key"}
        endpoint={uploadTarget ? `/api/admin/users/${uploadTarget.id}/upload` : ""}
        onClose={() => setUploadTarget(null)}
        onUploaded={load}
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
              绑定渠道名：
              <b className="text-slate-700">{channelTarget?.channelName}</b>
            </p>
            <ChannelStatusView channel={channelData} />
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
