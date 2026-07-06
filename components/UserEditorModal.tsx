"use client";

import { useEffect, useState } from "react";
import type { Role, SafeUser } from "@/lib/types";
import { apiFetch } from "@/lib/client";
import { useToast } from "@/components/Toast";
import { Button, CopyButton, Field, Modal, TextInput } from "@/components/ui";

/**
 * 新建 / 编辑用户弹窗。
 * - target 为空 → 新建（POST /api/admin/users）
 * - target 有值 → 编辑（PUT /api/admin/users/[id]，含「重置密钥」开关）
 *
 * 访问密钥由后端自动生成。新建成功、或编辑时重置密钥后，
 * 会切换到「密钥展示」步骤，显示完整密钥供管理员复制分发
 * （关闭后仅能在用户表格查看脱敏值）。
 */
export function UserEditorModal({
  open,
  target,
  onClose,
  onSaved,
}: {
  open: boolean;
  target: SafeUser | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const isEdit = !!target;

  const [username, setUsername] = useState("");
  const [role, setRole] = useState<Role>("user");
  const [channelName, setChannelName] = useState("");
  const [regenerateKey, setRegenerateKey] = useState(false);
  const [loading, setLoading] = useState(false);

  // 保存成功后要展示的完整密钥（新建 / 重置密钥）
  const [revealed, setRevealed] = useState<{
    username: string;
    accessKey: string;
    isNew: boolean;
  } | null>(null);

  // 每次打开时用目标数据初始化
  useEffect(() => {
    if (!open) return;
    setUsername(target?.username ?? "");
    setRole(target?.role ?? "user");
    setChannelName(target?.channelName ?? "");
    setRegenerateKey(false);
    setRevealed(null);
  }, [open, target]);

  function handleClose() {
    setRevealed(null);
    onClose();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim()) {
      toast.error("请输入用户名");
      return;
    }
    if (!channelName.trim()) {
      toast.error("请输入绑定渠道名");
      return;
    }
    setLoading(true);
    try {
      if (isEdit && target) {
        const data = await apiFetch<{ user: { accessKey: string } }>(
          `/api/admin/users/${target.id}`,
          {
            method: "PUT",
            body: JSON.stringify({
              username: username.trim(),
              role,
              channelName: channelName.trim(),
              regenerateKey,
            }),
          }
        );
        onSaved();
        if (regenerateKey && data.user?.accessKey) {
          // 展示新密钥，不直接关闭
          setRevealed({
            username: username.trim(),
            accessKey: data.user.accessKey,
            isNew: false,
          });
        } else {
          toast.success("已保存");
          onClose();
        }
      } else {
        const data = await apiFetch<{ user: { accessKey: string } }>(
          "/api/admin/users",
          {
            method: "POST",
            body: JSON.stringify({
              username: username.trim(),
              role,
              channelName: channelName.trim(),
            }),
          }
        );
        onSaved();
        setRevealed({
          username: username.trim(),
          accessKey: data.user.accessKey,
          isNew: true,
        });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存失败");
    } finally {
      setLoading(false);
    }
  }

  // —— 密钥展示步骤 ——
  if (revealed) {
    return (
      <Modal
        open={open}
        title={revealed.isNew ? "用户已创建" : "密钥已重置"}
        onClose={handleClose}
        footer={
          <>
            <CopyButton value={revealed.accessKey} label="复制密钥" />
            <Button onClick={handleClose}>完成</Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-slate-600">
            用户 <span className="font-medium text-slate-800">{revealed.username}</span>{" "}
            的访问密钥（请立即复制并分发给该用户）：
          </p>
          <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <code className="flex-1 break-all font-mono text-sm text-slate-800">
              {revealed.accessKey}
            </code>
            <CopyButton value={revealed.accessKey} />
          </div>
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
            ⚠️ 关闭后此完整密钥不再展示，表格中仅显示脱敏值。用户用此密钥登录本系统。
          </p>
        </div>
      </Modal>
    );
  }

  // —— 编辑 / 新建表单 ——
  return (
    <Modal
      open={open}
      title={isEdit ? "编辑用户" : "新建用户"}
      onClose={handleClose}
      footer={
        <>
          <Button variant="secondary" onClick={handleClose} disabled={loading}>
            取消
          </Button>
          <Button onClick={submit} loading={loading}>
            保存
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="用户名">
          <TextInput
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="如 team-a"
            autoComplete="off"
          />
        </Field>

        <Field label="角色">
          <div className="flex gap-2">
            {(["user", "admin"] as Role[]).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRole(r)}
                className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition ${
                  role === r
                    ? "border-brand-400 bg-brand-50 text-brand-700"
                    : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
                }`}
              >
                {r === "admin" ? "管理员 admin" : "普通用户 user"}
              </button>
            ))}
          </div>
        </Field>

        <Field
          label="绑定渠道名"
          hint="naci 平台上唯一标识渠道；首次上传 key 时按此名解析/创建。访问密钥将在保存后自动生成并展示。"
        >
          <TextInput
            value={channelName}
            onChange={(e) => setChannelName(e.target.value)}
            placeholder="如 TEST-TEAM-01"
            autoComplete="off"
          />
        </Field>

        {isEdit && (
          <label className="flex cursor-pointer items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={regenerateKey}
              onChange={(e) => setRegenerateKey(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-400"
            />
            重置访问密钥（旧密钥立即失效）
          </label>
        )}
      </form>
    </Modal>
  );
}
