"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/client";
import { useToast } from "@/components/Toast";
import { Button, Modal } from "@/components/ui";

/**
 * 上传入队结果 shape（POST …/upload 返回）。
 * 上传不即时推送到平台，而是先入本地队列，由定时引擎按「每批数量」批量上传。
 */
export interface UploadQueueResult {
  /** 本次去重去空后新录入本地库的 key 数 */
  added: number;
  /** 本地库中待上传站点的 key 数 */
  poolPending: number;
  /** 本地库中已上传站点的 key 数 */
  poolUploaded: number;
}

/** 直接上传结果 shape（POST …/upload-direct 返回）：录入并立即把 pending 逐批建成新渠道。 */
export interface DirectUploadResult {
  /** 本次去重去空后新录入本地库的 key 数 */
  added: number;
  /** 本次推送到站点的 key 数（含此前积压的 pending） */
  pushed: number;
  /** 本次新建的渠道数 */
  createdChannels: number;
  /** 本地库中仍待上传的 key 数 */
  poolPending: number;
  /** 本地库中已上传的 key 数 */
  poolUploaded: number;
  /** 多渠道聚合无单一值，恒为 null（前端不再依赖） */
  platformKeyCount: number | null;
  /** 恒为 null */
  deadKeyCount: number | null;
  /** 是否因上传限速未推完（剩余 pending 等窗口滚动后由引擎续传） */
  limited?: boolean;
  limitedMessage?: string;
  /** 是否因「仅高优先级」无空闲名额未推完（剩余 pending 等回收后由引擎续建） */
  waitingSlot?: boolean;
  waitingMessage?: string;
}

/** 上传弹窗内联结果：入队 or 直传，用 mode 区分展示。 */
type ModalResult =
  | { mode: "queue"; data: UploadQueueResult }
  | { mode: "direct"; data: DirectUploadResult };

/**
 * 上传 Key 弹窗：粘贴多行 key（每行一个）→ POST 到指定 endpoint（body {keys: 文本}）。
 * - 「提交上传」POST endpoint（入队，定时引擎分批补给）。
 * - 若传入 directEndpoint，则额外渲染「直接上传站点」按钮，POST directEndpoint（跳过队列立即推站点）。
 * 成功后内联展示结果，并回调 onUploaded 刷新父级。
 */
export function UploadKeyModal({
  open,
  title,
  endpoint,
  directEndpoint,
  onClose,
  onUploaded,
}: {
  open: boolean;
  title: string;
  endpoint: string;
  directEndpoint?: string;
  onClose: () => void;
  onUploaded?: () => void;
}) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [directLoading, setDirectLoading] = useState(false);
  const [result, setResult] = useState<ModalResult | null>(null);

  const busy = loading || directLoading;

  function reset() {
    setText("");
    setResult(null);
    setLoading(false);
    setDirectLoading(false);
  }

  function close() {
    reset();
    onClose();
  }

  // 入队上传：录入本地库，由定时引擎分批补给
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
      setResult({ mode: "queue", data: res });
      toast.success(
        `已录入 ${res.added} 个（待上传站点 ${res.poolPending}，已上传站点 ${res.poolUploaded}）`
      );
      onUploaded?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "上传失败");
    } finally {
      setLoading(false);
    }
  }

  // 直接上传：跳过队列，本批立即推站点
  async function submitDirect() {
    if (!directEndpoint) return;
    const keys = text.trim();
    if (!keys) {
      toast.error("请粘贴至少一个 key");
      return;
    }
    setDirectLoading(true);
    try {
      const res = await apiFetch<DirectUploadResult>(directEndpoint, {
        method: "POST",
        body: JSON.stringify({ keys }),
      });
      setResult({ mode: "direct", data: res });
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
      onUploaded?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "直接上传失败");
    } finally {
      setDirectLoading(false);
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
            <Button variant="secondary" onClick={close} disabled={busy}>
              取消
            </Button>
            {directEndpoint && (
              <Button
                variant="secondary"
                onClick={submitDirect}
                loading={directLoading}
                disabled={busy}
              >
                直接上传站点
              </Button>
            )}
            <Button onClick={submit} loading={loading} disabled={busy}>
              提交上传
            </Button>
          </>
        )
      }
    >
      {result ? (
        result.mode === "queue" ? (
          <UploadResultView result={result.data} />
        ) : (
          <DirectResultView result={result.data} />
        )
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-slate-500">
            每行粘贴一个 key，系统会自动去重去空并<b>录入本地库</b>。
            <b>提交上传</b>由定时引擎按「每批数量」分批推送到站点；
            {directEndpoint && (
              <>
                <b>直接上传站点</b>则跳过队列、把本批 key 立即推送到站点。
              </>
            )}
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

/** 直接上传结果视图：突出「新建渠道数 / 本次上传数」，并给出录入/剩余概况。 */
export function DirectResultView({ result }: { result: DirectUploadResult }) {
  return (
    <div className="space-y-2">
      {result.limited && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
          ⚠️ {result.limitedMessage ?? "已触发上传限速"}
          ，剩余待上传的 key 会在窗口滚动后由定时引擎自动续传。
        </p>
      )}
      {result.waitingSlot && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
          ⚠️{" "}
          {result.waitingMessage ??
            "仅高优先级模式：key 已入池，由定时任务在各用户间公平分配高优先级渠道。"}
        </p>
      )}
      <div className="grid grid-cols-3 gap-3 text-sm">
      <Stat
        label="新建渠道数"
        value={<span className="text-emerald-600">{result.createdChannels}</span>}
      />
      <Stat label="本次上传 key" value={result.pushed} />
      <Stat label="新录入本地库" value={result.added} />
      <Stat
        label="剩余待上传"
        value={
          result.poolPending > 0 ? (
            <span className="text-amber-600">{result.poolPending}</span>
          ) : (
            result.poolPending
          )
        }
      />
      </div>
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
