// 定时引擎（新模型：自动建新渠道 + 缓存刷新）：每 N 分钟遍历「仍有 pending key 的前缀」
// 与「已建过渠道的前缀」的并集。对有 pending 的前缀，当自动补给开启时从本地池逐批建新渠道
//（每批数量=配置 uploadBatchSize，单轮上限防止一次建太多）；对无 pending 的前缀只刷新其
// 已建渠道的实时缓存（让管理员列表 key 统计 ≤N 分钟新鲜）。
//
// 单例守卫挂 globalThis，兼容 Next dev 热重载 / standalone 多次 import，避免重复启动定时器。
// 引擎内任何异常都被捕获，绝不让 tick 抛出而中断定时器或 crash 进程。
import {
  createChannelsDrain,
  refreshPrefixRealtime,
  MAX_CHANNELS_PER_DRAIN,
} from "./channelService";
import {
  channelsWithPending,
  clampIntervalMinutes,
  findUserByChannelName,
  getConfig,
  poolCounts,
  prefixesWithCreatedChannels,
  reclaimStaleClaimed,
} from "./store";

/** 补给间隔默认值（分钟）——首个 tick 读到配置前的兜底，与 store 的 seed 一致。 */
const DEFAULT_INTERVAL_MS = 60_000;
const INITIAL_DELAY_MS = 5_000;
/** 单轮单前缀最多自动新建的渠道数（防止一次 paste 太多把 naci 打爆）。与直传共用同一上限。 */
const MAX_CHANNELS_PER_TICK = MAX_CHANNELS_PER_DRAIN;
/** claimed 死行回收阈值（分钟）：超过则视为进程崩溃残留，退回 pending 重试。 */
const CLAIM_STALE_MINUTES = 10;

/** 单前缀最近一次检查结果（供前端展示「上次检查做了什么/结果如何」）。 */
export interface LastCheckResult {
  at: number; // 检查完成时间戳(ms)
  status: "created" | "empty" | "paused" | "error";
  message: string; // 人类可读的结果/执行说明
}

interface EngineState {
  started: boolean;
  isRunning: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  lastTickAt: number | null; // 上次调度开始时间戳(ms)
  nextTickAt: number | null; // 预计下次调度时间戳(ms)
  intervalMs: number; // 当前生效的补给间隔(ms)，每轮 tick 从配置刷新
  lastResults: Record<string, LastCheckResult>; // 按前缀记录最近一次检查结果
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
      intervalMs: DEFAULT_INTERVAL_MS,
      lastResults: {},
    };
  } else {
    if (!g.__keyloadEngine.lastResults) g.__keyloadEngine.lastResults = {};
    if (!g.__keyloadEngine.intervalMs)
      g.__keyloadEngine.intervalMs = DEFAULT_INTERVAL_MS;
  }
  return g.__keyloadEngine;
}

/** 记录某前缀本轮检查结果（覆盖上一轮）。 */
function recordResult(
  prefix: string,
  status: LastCheckResult["status"],
  message: string
): void {
  engineState().lastResults[prefix] = { at: Date.now(), status, message };
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
    intervalMs: s.intervalMs,
    lastTickAt: s.lastTickAt,
    nextTickAt: s.nextTickAt,
    running: s.isRunning,
  };
}

async function safeLog(
  level: "info" | "warn" | "error",
  prefix: string | undefined,
  message: string
): Promise<void> {
  try {
    const { addLog } = await import("./store");
    await addLog({ level, actor: "engine", channelName: prefix, message });
  } catch {
    // 日志写入失败不影响引擎主流程
  }
}

/**
 * 处理单个前缀：
 * - 有 pending 且自动补给开启 → 从池逐批建新渠道（单轮上限 MAX_CHANNELS_PER_TICK）。
 * - 有 pending 但自动补给关闭 → 不建，仅记录（等用户手动上传）。
 * - 无 pending → 刷新已建渠道实时缓存。
 * 异常自行捕获记 error（不外抛，key 保持 pending 下轮/手动重试）。
 */
async function processPrefix(
  prefix: string,
  autoRefill: boolean
): Promise<void> {
  try {
    const user = await findUserByChannelName(prefix);
    if (!user) {
      // 池里有 key 但没有绑定该前缀的用户：跳过（无法回写统计）
      recordResult(prefix, "empty", "无绑定用户，跳过");
      return;
    }

    const { pending } = await poolCounts(prefix);

    if (pending > 0 && autoRefill) {
      const drain = await createChannelsDrain(user, MAX_CHANNELS_PER_TICK);
      if (drain.createdChannels > 0) {
        recordResult(
          prefix,
          "created",
          `自动新建 ${drain.createdChannels} 个渠道，共上传 ${drain.pushed} 个 key（剩余待上传 ${drain.poolPending}）`
        );
      } else {
        recordResult(prefix, "empty", "队列已空，等待新 key");
      }
      return;
    }

    if (pending > 0 && !autoRefill) {
      recordResult(
        prefix,
        "paused",
        `自动补给已关闭，${pending} 个待上传，等待手动上传`
      );
      // 仍刷新已建渠道缓存
      await refreshPrefixRealtime(user);
      return;
    }

    // 无 pending：刷新已建渠道实时缓存（让管理员列表统计保持新鲜）
    await refreshPrefixRealtime(user);
    recordResult(prefix, "empty", "队列已空，无需新建渠道");
  } catch (err) {
    recordResult(
      prefix,
      "error",
      `处理失败：${err instanceof Error ? err.message : String(err)}`
    );
    await safeLog(
      "error",
      prefix,
      `处理失败：${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * 单次调度：遍历「有 pending 的前缀」∪「已建过渠道的前缀」，逐个（串行）processPrefix。
 * isRunning 防重入。
 */
export async function tick(): Promise<void> {
  const state = engineState();
  if (state.isRunning) return;
  state.isRunning = true;
  state.lastTickAt = Date.now();
  try {
    const cfg = await getConfig();
    state.intervalMs = clampIntervalMinutes(cfg.refillIntervalMinutes) * 60_000;
    const autoRefill = cfg.autoRefillEnabled;

    // 回收崩溃残留的 claimed 死行（退回 pending），再统计待处理前缀。
    try {
      const reclaimed = await reclaimStaleClaimed(CLAIM_STALE_MINUTES);
      if (reclaimed > 0) {
        await safeLog(
          "warn",
          undefined,
          `回收 ${reclaimed} 个滞留认领(claimed>${CLAIM_STALE_MINUTES}分钟)的 key，已退回待上传`
        );
      }
    } catch (err) {
      console.error("[engine] reclaimStaleClaimed 失败:", err);
    }

    const pendingPrefixes = await channelsWithPending();
    const createdPrefixes = await prefixesWithCreatedChannels();
    const targets = Array.from(
      new Set([...pendingPrefixes, ...createdPrefixes])
    );

    for (const prefix of targets) {
      await processPrefix(prefix, autoRefill);
    }
  } catch (err) {
    console.error("[engine] tick 失败:", err);
  } finally {
    state.isRunning = false;
  }
}

/**
 * 用户上传 key 后立即 kick 一次（只处理该前缀），避免等待整分钟定时轮。
 * **已有调度在跑（isRunning）则直接忽略**：交给当前那轮或下一轮处理。
 * fire-and-forget：同步返回，实际建渠道在后台异步执行，不阻塞上传响应。
 */
export function kickEngine(prefix: string): void {
  const state = engineState();
  if (state.isRunning) return;
  const name = prefix.trim();
  if (!name) return;
  void (async () => {
    if (state.isRunning) return;
    state.isRunning = true;
    state.lastTickAt = Date.now();
    try {
      const cfg = await getConfig();
      await processPrefix(name, cfg.autoRefillEnabled);
    } catch (err) {
      console.error("[engine] kick 失败:", err);
    } finally {
      state.isRunning = false;
    }
  })();
}

/**
 * 跑一次 tick 并按「当前生效间隔」安排下一次（自调度 setTimeout 链）。
 */
async function runAndReschedule(): Promise<void> {
  const state = engineState();
  try {
    await tick();
  } finally {
    const delay = state.intervalMs > 0 ? state.intervalMs : DEFAULT_INTERVAL_MS;
    state.nextTickAt = Date.now() + delay;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      void runAndReschedule();
    }, delay);
  }
}

/** 启动定时引擎（幂等，重复调用只启动一次）。 */
export function startEngine(): void {
  const state = engineState();
  if (state.started) return;
  state.started = true;

  state.nextTickAt = Date.now() + INITIAL_DELAY_MS;
  state.timer = setTimeout(() => {
    void runAndReschedule();
  }, INITIAL_DELAY_MS);

  console.log("[engine] 定时建渠道引擎已启动（间隔按系统配置，可在后台调整）");
}
