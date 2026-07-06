// 定时补 key 引擎：每 60s 从本地 key 池取「配置的每批数量」个 pending key，
// 批量 append 到对应 naci 渠道并启用全部三站，直到池排空。
//
// 单例守卫挂 globalThis，兼容 Next dev 热重载 / standalone 多次 import，避免重复启动定时器。
// 引擎内任何异常都被捕获，绝不让 tick 抛出而中断定时器或 crash 进程。
import { pushBatchToChannel } from "./channelService";
import {
  addLog,
  channelsWithPending,
  clampBatchSize,
  getConfig,
  markPoolUploaded,
  nextPendingBatch,
} from "./store";

const TICK_INTERVAL_MS = 60_000;
const INITIAL_DELAY_MS = 5_000;

interface EngineState {
  started: boolean;
  isRunning: boolean;
  timer: ReturnType<typeof setInterval> | null;
  lastTickAt: number | null; // 上次调度开始时间戳(ms)
  nextTickAt: number | null; // 预计下次调度时间戳(ms)
}

function engineState(): EngineState {
  const g = globalThis as unknown as { __keyloadEngine?: EngineState };
  if (!g.__keyloadEngine) {
    g.__keyloadEngine = {
      started: false,
      isRunning: false,
      timer: null,
      lastTickAt: null,
      nextTickAt: null,
    };
  }
  return g.__keyloadEngine;
}

/** 引擎调度状态：供前端展示「下一次检查」等。 */
export function getEngineStatus(): {
  intervalMs: number;
  lastTickAt: number | null;
  nextTickAt: number | null;
  running: boolean;
} {
  const s = engineState();
  return {
    intervalMs: TICK_INTERVAL_MS,
    lastTickAt: s.lastTickAt,
    nextTickAt: s.nextTickAt,
    running: s.isRunning,
  };
}

async function safeLog(
  level: "info" | "error",
  channelName: string | undefined,
  message: string
): Promise<void> {
  try {
    await addLog({ level, actor: "engine", channelName, message });
  } catch {
    // 日志写入失败不影响引擎主流程
  }
}

/**
 * 单次调度：遍历所有有 pending key 的渠道，逐个（串行）取一批上传。
 * isRunning 防重入；单渠道失败 try/catch 隔离（key 保持 pending，下轮重试）。
 */
export async function tick(): Promise<void> {
  const state = engineState();
  if (state.isRunning) return; // 上一轮未结束，跳过
  state.isRunning = true;
  state.lastTickAt = Date.now();
  try {
    const cfg = await getConfig();
    if (!cfg.autoRefillEnabled) return; // 自动补 key 关闭
    const batchSize = clampBatchSize(cfg.uploadBatchSize);

    const channels = await channelsWithPending();
    for (const channelName of channels) {
      try {
        const batch = await nextPendingBatch(channelName, batchSize);
        if (batch.length === 0) continue;
        await pushBatchToChannel(
          channelName,
          batch.map((b) => b.key)
        );
        await markPoolUploaded(batch.map((b) => b.id));
      } catch (err) {
        // 单渠道失败不影响其它渠道；key 未标记 uploaded，下轮重试
        await safeLog(
          "error",
          channelName,
          `批量上传失败：${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  } catch (err) {
    // 顶层兜底：绝不让 tick 抛出
    console.error("[engine] tick 失败:", err);
  } finally {
    state.isRunning = false;
    state.nextTickAt = Date.now() + TICK_INTERVAL_MS;
  }
}

/** 启动定时引擎（幂等，重复调用只启动一次）。 */
export function startEngine(): void {
  const state = engineState();
  if (state.started) return;
  state.started = true;

  // 启动后先延迟一小段跑一次（等 DB/首次请求初始化），之后每分钟一次
  state.nextTickAt = Date.now() + INITIAL_DELAY_MS;
  setTimeout(() => {
    void tick();
  }, INITIAL_DELAY_MS);
  state.timer = setInterval(() => {
    void tick();
  }, TICK_INTERVAL_MS);

  console.log("[engine] 定时补 key 引擎已启动（每 60s 调度一次）");
}
