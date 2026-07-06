"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type ToastLevel = "info" | "success" | "error";

interface ToastItem {
  id: number;
  level: ToastLevel;
  message: string;
}

interface ToastApi {
  push: (message: string, level?: ToastLevel) => void;
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

const ToastCtx = createContext<ToastApi | null>(null);

const LEVEL_STYLE: Record<ToastLevel, string> = {
  info: "border-slate-200 bg-white text-slate-700",
  success: "border-emerald-200 bg-emerald-50 text-emerald-700",
  error: "border-rose-200 bg-rose-50 text-rose-700",
};

const LEVEL_ICON: Record<ToastLevel, string> = {
  info: "•",
  success: "✓",
  error: "✕",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const remove = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (message: string, level: ToastLevel = "info") => {
      const id = ++seq.current;
      setItems((prev) => [...prev, { id, level, message }]);
      window.setTimeout(() => remove(id), 4000);
    },
    [remove]
  );

  const success = useCallback((m: string) => push(m, "success"), [push]);
  const error = useCallback((m: string) => push(m, "error"), [push]);
  const info = useCallback((m: string) => push(m, "info"), [push]);

  const api = useMemo<ToastApi>(
    () => ({ push, success, error, info }),
    [push, success, error, info]
  );

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed right-4 top-4 z-[100] flex w-full max-w-sm flex-col gap-2">
        {items.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto flex items-start gap-2 rounded-lg border px-4 py-3 text-sm shadow-lg ${LEVEL_STYLE[t.level]}`}
          >
            <span className="mt-0.5 font-bold">{LEVEL_ICON[t.level]}</span>
            <span className="flex-1 whitespace-pre-wrap break-words">{t.message}</span>
            <button
              onClick={() => remove(t.id)}
              className="text-slate-400 transition hover:text-slate-600"
              aria-label="关闭"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error("useToast 必须在 <ToastProvider> 内使用");
  return ctx;
}
