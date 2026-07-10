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
  // 单用户上传限速覆盖（字符串态，空串=跟随全局默认→提交 null）
  const [limitCount, setLimitCount] = useState("");
  const [limitWindow, setLimitWindow] = useState("");
  // 按用户高优先级配额
  const [allowHighPriority, setAllowHighPriority] = useState(true);
  const [highPriorityLimit, setHighPriorityLimit] = useState("");
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
    setLimitCount(
      target?.uploadLimitCount == null ? "" : String(target.uploadLimitCount)
    );
    setLimitWindow(
      target?.uploadLimitWindowMinutes == null
        ? ""
        : String(target.uploadLimitWindowMinutes)
    );
    setAllowHighPriority(target?.allowHighPriority !== false);
    setHighPriorityLimit(
      target?.highPriorityLimit == null ? "" : String(target.highPriorityLimit)
    );
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
      toast.error("请输入渠道前缀");
      return;
    }
    // 单用户限速覆盖：空串=null（跟随全局默认），否则必须是合法数字
    let uploadLimitCount: number | null = null;
    if (limitCount.trim() !== "") {
      const v = Math.floor(Number(limitCount));
      if (!Number.isFinite(v) || v < 0) {
        toast.error("上传限速·个数需为 ≥0 的整数（0=不限速）");
        return;
      }
      uploadLimitCount = v;
    }
    let uploadLimitWindowMinutes: number | null = null;
    if (limitWindow.trim() !== "") {
      const v = Math.floor(Number(limitWindow));
      if (!Number.isFinite(v) || v < 1 || v > 1440) {
        toast.error("上传限速·窗口需为 1~1440 分钟");
        return;
      }
      uploadLimitWindowMinutes = v;
    }
    // 独立优先级6数量：空串=null（不设独立上限），否则 ≥0 整数
    let highPriorityLimitVal: number | null = null;
    if (highPriorityLimit.trim() !== "") {
      const v = Math.floor(Number(highPriorityLimit));
      if (!Number.isFinite(v) || v < 0) {
        toast.error("独立优先级6数量需为 ≥0 的整数");
        return;
      }
      highPriorityLimitVal = v;
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
              uploadLimitCount,
              uploadLimitWindowMinutes,
              allowHighPriority,
              highPriorityLimit: highPriorityLimitVal,
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
          label="渠道前缀"
          hint="每次上传新建渠道，渠道名 = 前缀 + 4 位序号（如 前缀-0001）。访问密钥将在保存后自动生成并展示。"
        >
          <TextInput
            value={channelName}
            onChange={(e) => setChannelName(e.target.value)}
            placeholder="如 0708-ANTH-LIU-HAN"
            autoComplete="off"
          />
        </Field>

        {isEdit && (
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="上传限速·个数"
              hint="窗口内最多上传 key 数；0=不限速；留空=跟随全局默认"
            >
              <TextInput
                type="number"
                min={0}
                max={1000000}
                value={limitCount}
                onChange={(e) => setLimitCount(e.target.value)}
                placeholder="留空=全局默认"
              />
            </Field>
            <Field
              label="上传限速·窗口（分钟）"
              hint="滚动窗口长度 1~1440；留空=跟随全局默认"
            >
              <TextInput
                type="number"
                min={1}
                max={1440}
                value={limitWindow}
                onChange={(e) => setLimitWindow(e.target.value)}
                placeholder="留空=全局默认"
              />
            </Field>
          </div>
        )}

        {isEdit && (
          <div className="space-y-3 rounded-lg bg-slate-50 px-3 py-3">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={allowHighPriority}
                onChange={(e) => setAllowHighPriority(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-400"
              />
              可用高优先级（优先级6）渠道
            </label>
            <Field
              label="独立优先级6数量"
              hint="该用户最多占用几个优先级6渠道（全局6的子上限）；留空=不设独立上限，仅受全局约束"
            >
              <TextInput
                type="number"
                min={0}
                max={1000}
                value={highPriorityLimit}
                onChange={(e) => setHighPriorityLimit(e.target.value)}
                placeholder="留空=仅受全局"
                disabled={!allowHighPriority}
              />
            </Field>
          </div>
        )}

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
