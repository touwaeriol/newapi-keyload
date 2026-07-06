// 定时补 key 引擎（按需补给 + 缓存刷新）：每 60s 遍历「所有已解析出 channelId 的绑定渠道」
// 与「所有仍有 pending key 的渠道」的并集，对每个渠道用只读端点 status-batch 检测一次
// （assessRefillNeed：既把真实 multiKeySize/deadCount 写回用户缓存，让管理员列表 ≤60s 新鲜，
// 又判断是否缺 key）。仅当该渠道「缺 key（不存在 / 存活 key=0 自动禁用）」**且有 pending key**
// 时，才从本地池取「配置的每批数量」个 key 批量 append 并重开三站；否则只刷新缓存、不补，
// 把 key 留在池里等下次真正缺 key 时再补。
//
// 单例守卫挂 globalThis，兼容 Next dev 热重载 / standalone 多次 import，避免重复启动定时器。
// 引擎内任何异常都被捕获，绝不让 tick 抛出而中断定时器或 crash 进程。
import { assessRefillNeed, pushBatchToChannel } from "./channelService";
import {
  addLog,
  channelsWithPending,
  clampBatchSize,
  getConfig,
  getUsers,
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
  level: "info" | "warn" | "error",
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
 * 单次调度（按需补给 + 缓存刷新）：遍历「已解析出 channelId 的绑定渠道」∪「有 pending 的渠道」，
 * 逐个（串行）用 assessRefillNeed 只读检测一次 status-batch：
 *   - 顺带把真实 key 统计写回用户缓存（让池已排空的渠道也保持新鲜，管理员列表 ≤60s 真实）；
 *   - 判定是否缺 key。仅当「缺 key」**且该渠道有 pending** 时才取一批上传；否则只刷新缓存不补。
 * isRunning 防重入；单渠道失败 try/catch 隔离（key 保持 pending，下轮重试）；naci 读失败保留缓存跳过。
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

    // 目标渠道 = 已解析出 channelId 的绑定渠道（需刷新缓存）∪ 有 pending 的渠道（可能需补/首建）。
    // 前者保证池已排空的渠道也每轮刷新真实统计；后者保证首次上传能创建、缺 key 能补。
    const users = await getUsers();
    const resolvedBound = users
      .filter((u) => u.channelName.trim().length > 0 && u.channelId != null)
      .map((u) => u.channelName.trim());
    const pendingChannels = await channelsWithPending();
    const pendingSet = new Set(pendingChannels);
    const targets = Array.from(
      new Set([...resolvedBound, ...pendingChannels])
    );

    for (const channelName of targets) {
      try {
        // 一次只读 status-batch：assessRefillNeed 内部既刷新真实统计缓存，又判定是否缺 key
        const decision = await assessRefillNeed(channelName);
        if (decision.status === "unreadable") {
          // 读失败：保留上次缓存，本轮跳过（不补、不清缓存），key 留 pending 下轮重试
          await safeLog(
            "warn",
            channelName,
            "只读检测渠道状态失败，本轮跳过（保留缓存，下轮重试）"
          );
          continue;
        }
        // 仅「缺 key」且「有 pending」才补一批；没 pending 的渠道只刷新缓存、不补
        if (!decision.needsKeys || !pendingSet.has(channelName)) continue;

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
          `补给失败：${err instanceof Error ? err.message : String(err)}`
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
