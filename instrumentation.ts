// Next.js instrumentation hook：进程启动时（仅 Node.js 运行时）拉起定时补 key 引擎。
// 需在 next.config.mjs 开启 experimental.instrumentationHook（Next 14.2）。
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const m = await import("./lib/engine");
    m.startEngine();
  }
}
