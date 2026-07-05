"use client";

import { useEffect, useState } from "react";
import type { Role, SafeUser } from "@/lib/types";
import { apiFetch } from "@/lib/client";
import { useToast } from "@/components/Toast";
import { Button, Field, Modal, TextInput } from "@/components/ui";

/**
 * 新建 / 编辑用户弹窗。
 * - target 为空 → 新建（POST /api/admin/users）
 * - target 有值 → 编辑（PUT /api/admin/users/[id]，含「重置密钥」开关）
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

  // 每次打开时用目标数据初始化
  useEffect(() => {
    if (!open) return;
    setUsername(target?.username ?? "");
    setRole(target?.role ?? "user");
    setChannelName(target?.channelName ?? "");
    setRegenerateKey(false);
  }, [open, target]);

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
        await apiFetch(`/api/admin/users/${target.id}`, {
          method: "PUT",
          body: JSON.stringify({
            username: username.trim(),
            role,
            channelName: channelName.trim(),
            regenerateKey,
          }),
        });
        toast.success("已保存");
      } else {
        await apiFetch("/api/admin/users", {
          method: "POST",
          body: JSON.stringify({
            username: username.trim(),
            role,
            channelName: channelName.trim(),
          }),
        });
        toast.success("已创建用户");
      }
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal
      open={open}
      title={isEdit ? "编辑用户" : "新建用户"}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={loading}>
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
          hint="naci 平台上唯一标识渠道；首次上传 key 时按此名解析/创建"
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
