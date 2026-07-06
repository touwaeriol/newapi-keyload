"use client";

import { useState } from "react";
import type { SafeUser } from "@/lib/types";
import { apiFetch, clearStoredKey, setStoredKey } from "@/lib/client";
import { Button, Field, TextInput } from "@/components/ui";

/**
 * 登录门：输入访问密钥 + 「在本机记住」；提交时用该 key 调 /api/me 校验，
 * 成功则把 key 写入存储并回调登录用户。跳过独立登录页，直接弹窗。
 */
export function KeyGate({ onAuthed }: { onAuthed: (user: SafeUser) => void }) {
  const [key, setKey] = useState("");
  const [remember, setRemember] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = key.trim();
    if (!trimmed) {
      setError("请输入访问密钥");
      return;
    }
    setLoading(true);
    setError(null);
    // 先写入存储，apiFetch 会自动带上；校验失败再清掉
    setStoredKey(trimmed, remember);
    try {
      const { user } = await apiFetch<{ user: SafeUser }>("/api/me");
      onAuthed(user);
    } catch (err) {
      // 校验失败：清掉刚写入的无效 key（401 时 apiFetch 也已清一次）
      clearStoredKey();
      setError(err instanceof Error ? err.message : "登录失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-slate-50 to-slate-100 p-4">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-7 shadow-xl">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-brand-600 text-lg font-bold text-white">
            K
          </div>
          <h1 className="text-lg font-semibold text-slate-800">
            供应商 Key 上渠道系统
          </h1>
          <p className="mt-1 text-sm text-slate-500">请输入访问密钥登录</p>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <Field label="访问密钥">
            <TextInput
              type="password"
              autoFocus
              value={key}
              onChange={(e) => {
                setKey(e.target.value);
                if (error) setError(null);
              }}
              placeholder="粘贴管理员分发的访问密钥"
              autoComplete="off"
            />
          </Field>

          <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-400"
            />
            在本机记住
          </label>

          {error && (
            <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600">
              {error}
            </p>
          )}

          <Button type="submit" loading={loading} className="w-full">
            登录
          </Button>
        </form>
      </div>
    </div>
  );
}
