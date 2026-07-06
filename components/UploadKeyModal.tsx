"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/client";
import { useToast } from "@/components/Toast";
import { Button, Modal } from "@/components/ui";

/**
 * 上传入队结果 shape（POST /api/my/upload 与 admin 代传均返回此结构）。
 * 上传不再即时推送到平台，而是先入本地队列，由定时引擎按「每批数量」批量上传。
 */
export interface UploadQueueResult {
  /** 本次去重去空后新录入本地库的 key 数 */
  added: number;
  /** 本地库中待上传站点的 key 数 */
  poolPending: number;
  /** 本地库中已上传站点的 key 数 */
  poolUploaded: number;
}

/**
 * 上传 Key 弹窗：粘贴多行 key（每行一个）→ POST 到指定 endpoint（body {keys: 文本}）。
 * 成功后内联展示入队结果（added / poolPending / poolUploaded），并回调 onUploaded 刷新父级。
 */
export function UploadKeyModal({
  open,
  title,
  endpoint,
  onClose,
  onUploaded,
}: {
  open: boolean;
  title: string;
  endpoint: string;
  onClose: () => void;
  onUploaded?: (result: UploadQueueResult) => void;
}) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<UploadQueueResult | null>(null);

  function reset() {
    setText("");
    setResult(null);
    setLoading(false);
  }

  function close() {
    reset();
    onClose();
  }

  async function submit() {
    const keys = text.trim();
    if (!keys) {
      toast.error("请粘贴至少一个 key");
      return;
    }
    setLoading(true);
    try {
      const res = await apiFetch<UploadQueueResult>(endpoint, {
        method: "POST",
        body: JSON.stringify({ keys }),
      });
      setResult(res);
      toast.success(
        `已录入 ${res.added} 个（待上传站点 ${res.poolPending}，已上传站点 ${res.poolUploaded}）`
      );
      onUploaded?.(res);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "上传失败");
    } finally {
      setLoading(false);
    }
  }

  const lineCount = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean).length;

  return (
    <Modal
      open={open}
      title={title}
      onClose={close}
      width="max-w-xl"
      footer={
        result ? (
          <Button variant="secondary" onClick={close}>
            完成
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={close} disabled={loading}>
              取消
            </Button>
            <Button onClick={submit} loading={loading}>
              提交上传
            </Button>
          </>
        )
      }
    >
      {result ? (
        <UploadResultView result={result} />
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-slate-500">
            每行粘贴一个 key，系统会自动去重去空并<b>录入本地库</b>，随后由定时引擎按「每批数量」<b>上传到站点</b>。
          </p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={8}
            placeholder={"sk-ant-api03-xxxx\nsk-ant-api03-yyyy"}
            className="w-full resize-y rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs text-slate-800 outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
          />
          <div className="text-right text-xs text-slate-400">
            识别到 {lineCount} 行有效 key
          </div>
        </div>
      )}
    </Modal>
  );
}

/** 入队结果视图：展示本次新增与队列进度，可复用于用户面板 */
export function UploadResultView({ result }: { result: UploadQueueResult }) {
  return (
    <div className="grid grid-cols-3 gap-3 text-sm">
      <Stat label="本次录入" value={result.added} />
      <Stat
        label="待上传站点"
        value={
          result.poolPending > 0 ? (
            <span className="text-amber-600">{result.poolPending}</span>
          ) : (
            result.poolPending
          )
        }
      />
      <Stat label="已上传站点" value={result.poolUploaded} />
    </div>
  );
}

function Stat({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2">
      <div className="text-xs text-slate-400">{label}</div>
      <div className="mt-0.5 text-sm font-medium text-slate-800">{value}</div>
    </div>
  );
}
