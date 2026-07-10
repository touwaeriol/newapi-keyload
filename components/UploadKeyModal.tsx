"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/client";
import { useToast } from "@/components/Toast";
import { Button, Modal } from "@/components/ui";

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

/**
 * 上传 Key 弹窗：粘贴多行 key（每行一个）→ POST directEndpoint（body {keys: 文本}），
 * 按「聚合 key 数量」拆分立即建成渠道（有名额建 P6，满则 P5）。
 * 旧「提交上传」（入队走定时引擎）已下线，仅保留禁用态占位按钮。
 * 成功后内联展示结果，并回调 onUploaded 刷新父级。
 */
export function UploadKeyModal({
  open,
  title,
  directEndpoint,
  onClose,
  onUploaded,
}: {
  open: boolean;
  title: string;
  directEndpoint: string;
  onClose: () => void;
  onUploaded?: () => void;
}) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [directLoading, setDirectLoading] = useState(false);
  const [result, setResult] = useState<DirectUploadResult | null>(null);

  function reset() {
    setText("");
    setResult(null);
    setDirectLoading(false);
  }

  function close() {
    reset();
    onClose();
  }

  // 直接上传：本批立即拆分建渠道推站点
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
      setResult(res);
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
            <Button variant="secondary" onClick={close} disabled={directLoading}>
              取消
            </Button>
            <Button
              variant="secondary"
              onClick={submitDirect}
              loading={directLoading}
            >
              直接上传站点
            </Button>
            {/* 占位：提交上传（入队）已下线，保留禁用态提示用户走直接上传 */}
            <Button disabled={true} title="提交上传已下线，请使用「直接上传站点」">
              提交上传（已禁用）
            </Button>
          </>
        )
      }
    >
      {result ? (
        <DirectResultView result={result} />
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-slate-500">
            每行粘贴一个 key，系统会自动去重去空。
            <b>直接上传站点</b>会按「聚合 key 数量」拆分，立即建成渠道推送到站点
            （有名额建 P6，满则 P5）。
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
