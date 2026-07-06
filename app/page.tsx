"use client";

import { useEffect, useState } from "react";
import type { SafeUser } from "@/lib/types";
import {
  apiFetch,
  clearStoredKey,
  getStoredKey,
  UNAUTHORIZED_EVENT,
} from "@/lib/client";
import { ToastProvider } from "@/components/Toast";
import { KeyGate } from "@/components/KeyGate";
import { AdminPanel } from "@/components/AdminPanel";
import { UserPanel } from "@/components/UserPanel";
import { Badge, Button, Spinner } from "@/components/ui";

type Phase = "checking" | "gate" | "ready";

export default function Page() {
  const [phase, setPhase] = useState<Phase>("checking");
  const [user, setUser] = useState<SafeUser | null>(null);

  // 挂载时：有本机 key 则校验，无 key 直接进入登录门
  useEffect(() => {
    const key = getStoredKey();
    if (!key) {
      setPhase("gate");
      return;
    }
    let alive = true;
    (async () => {
      try {
        const { user } = await apiFetch<{ user: SafeUser }>("/api/me");
        if (!alive) return;
        setUser(user);
        setPhase("ready");
      } catch {
        if (!alive) return;
        clearStoredKey();
        setPhase("gate");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // 任意请求收到 401 → apiFetch 已清 key 并广播事件；这里回到登录门
  useEffect(() => {
    function onUnauthorized() {
      setUser(null);
      setPhase("gate");
    }
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  function handleAuthed(u: SafeUser) {
    setUser(u);
    setPhase("ready");
  }

  function logout() {
    clearStoredKey();
    setUser(null);
    setPhase("gate");
  }

  return (
    <ToastProvider>
      {phase === "checking" && (
        <div className="flex min-h-screen items-center justify-center text-slate-400">
          <Spinner /> <span className="ml-2 text-sm">校验登录中…</span>
        </div>
      )}

      {phase === "gate" && <KeyGate onAuthed={handleAuthed} />}

      {phase === "ready" && user && (
        <div className="min-h-screen">
          <Header user={user} onLogout={logout} />
          <main className="mx-auto max-w-6xl px-4 py-6">
            {user.role === "admin" ? <AdminPanel /> : <UserPanel user={user} />}
          </main>
        </div>
      )}
    </ToastProvider>
  );
}

function Header({
  user,
  onLogout,
}: {
  user: SafeUser;
  onLogout: () => void;
}) {
  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white">
            K
          </div>
          <div>
            <h1 className="text-sm font-semibold leading-tight text-slate-800">
              供应商 Key 上渠道系统
            </h1>
            <p className="text-xs text-slate-400">
              {user.role === "admin" ? "管理员控制台" : "我的渠道"}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium text-slate-700">{user.username}</span>
            <Badge tone={user.role === "admin" ? "blue" : "slate"}>
              {user.role}
            </Badge>
          </div>
          <Button variant="secondary" onClick={onLogout}>
            退出登录
          </Button>
        </div>
      </div>
    </header>
  );
}
