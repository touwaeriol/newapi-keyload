"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SafeUser, UploadResult } from "@/lib/types";
import { apiFetch } from "@/lib/client";
import { useToast } from "@/components/Toast";
import { Button, Card, Spinner } from "@/components/ui";
import { UploadResultView } from "@/components/UploadKeyModal";
import { ChannelStatusView, type ChannelStatus } from "@/components/ChannelStatusView";

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

  const loadChannel = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<{ channel: ChannelStatus }>("/api/my/channel");
      if (!mounted.current) return;
      setChannel(data.channel);
    } catch (err) {
      if (!mounted.current) return;
      toast.error(err instanceof Error ? err.message : "读取渠道失败");
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadChannel();
  }, [loadChannel]);

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <ChannelCard
        user={user}
        channel={channel}
        loading={loading}
        onRefresh={loadChannel}
      />
      <UploadCard onUploaded={loadChannel} />
    </div>
  );
}

/* ============ 我的渠道卡 ============ */

function ChannelCard({
  user,
  channel,
  loading,
  onRefresh,
}: {
  user: SafeUser;
  channel: ChannelStatus | null;
  loading: boolean;
  onRefresh: () => void;
}) {
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
        <ChannelStatusView channel={channel} />
      )}
    </Card>
  );
}

/* ============ 上传 Key 卡 ============ */

function UploadCard({ onUploaded }: { onUploaded: () => void }) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);

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
      const res = await apiFetch<UploadResult>("/api/my/upload", {
        method: "POST",
        body: JSON.stringify({ keys }),
      });
      setResult(res);
      setText("");
      toast.success(
        `${res.action === "created" ? "已创建渠道" : "已追加"} · 本次 ${res.keyCount} 个 key`
      );
      onUploaded();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "上传失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card title="上传 Key" subtitle="每行一个 key，提交后自动创建/追加到渠道">
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
