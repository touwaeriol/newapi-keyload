"use client";

import { useState } from "react";
import type { UploadResult } from "@/lib/types";
import { apiFetch } from "@/lib/client";
import { useToast } from "@/components/Toast";
import { Badge, Button, Modal } from "@/components/ui";

/**
 * 上传 Key 弹窗：粘贴多行 key（每行一个）→ POST 到指定 endpoint（body {keys: 文本}）。
 * 成功后内联展示 UploadResult（action + keyCount + 各站点发布），并回调 onUploaded 刷新父级。
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
  onUploaded?: (result: UploadResult) => void;
}) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);

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
      const res = await apiFetch<UploadResult>(endpoint, {
        method: "POST",
        body: JSON.stringify({ keys }),
      });
      setResult(res);
      toast.success(
        `${res.action === "created" ? "已创建渠道" : "已追加"} · ${res.keyCount} 个 key`
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
            每行粘贴一个 key，系统会自动去重去空并追加到渠道。
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

/** 上传结果视图：可复用于渠道刷新展示 */
export function UploadResultView({ result }: { result: UploadResult }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone={result.action === "created" ? "green" : "blue"}>
          {result.action === "created" ? "新建渠道" : "追加更新"}
        </Badge>
        <span className="text-slate-600">
          渠道 <b className="text-slate-800">{result.channelName}</b>
        </span>
        <span className="text-slate-400">·</span>
        <span className="text-slate-600">channelId {result.channelId}</span>
        <span className="text-slate-400">·</span>
        <span className="text-slate-600">本次 {result.keyCount} 个 key</span>
        <span className="text-slate-400">·</span>
        <span className="text-slate-600">累计 {result.uploadedKeyCount} 个</span>
        {result.platformKeyCount != null && (
          <>
            <span className="text-slate-400">·</span>
            <span className="text-slate-600">
              平台 {result.platformKeyCount} 个
            </span>
          </>
        )}
        {result.deadKeyCount != null && (
          <>
            <span className="text-slate-400">·</span>
            <span
              className={
                result.deadKeyCount > 0 ? "text-rose-600" : "text-slate-600"
              }
            >
              禁用 {result.deadKeyCount} 个
            </span>
          </>
        )}
      </div>

      <div>
        <div className="mb-1 text-xs font-medium text-slate-500">站点发布</div>
        {result.siteAmounts && result.siteAmounts.length > 0 ? (
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
                {result.siteAmounts.map((s) => (
                  <tr key={s.site_id}>
                    <td className="px-3 py-2 text-slate-700">{s.site_name}</td>
                    <td className="px-3 py-2 text-slate-500">{s.remote_channel_id}</td>
                    <td className="px-3 py-2 text-right text-slate-600">
                      {s.used_quota}
                    </td>
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
