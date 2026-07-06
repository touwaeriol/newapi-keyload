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

/** 单渠道最近一次检查结果（供前端展示「上次检查做了什么/结果如何」）。 */
export interface LastCheckResult {
  at: number; // 检查完成时间戳(ms)
  status: "missing" | "exhausted" | "alive" | "manual" | "unreadable";
  message: string; // 人类可读的结果/执行说明
}

interface EngineState {
  started: boolean;
  isRunning: boolean;
  timer: ReturnType<typeof setInterval> | null;
  lastTickAt: number | null; // 上次调度开始时间戳(ms)
  nextTickAt: number | null; // 预计下次调度时间戳(ms)
  lastResults: Record<string, LastCheckResult>; // 按渠道名记录最近一次检查结果
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
      lastResults: {},
    };
  } else if (!g.__keyloadEngine.lastResults) {
    // 兼容旧单例（热重载时已存在但无该字段）
    g.__keyloadEngine.lastResults = {};
  }
  return g.__keyloadEngine;
}

/** 记录某渠道本轮检查结果（覆盖上一轮）。 */
function recordResult(
  channelName: string,
  status: LastCheckResult["status"],
  message: string
): void {
  engineState().lastResults[channelName] = { at: Date.now(), status, message };
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
 * 处理单个渠道（只读检测 + 按需补一批）：assessRefillNeed 一次 status-batch 既刷新真实统计缓存、
 * 又判定是否缺 key；仅当「缺 key」且池里确有 pending（nextPendingBatch 非空）时才上传一批并重开三站，
 * 否则只记录检查结论。异常自行捕获记 error（不外抛，key 保持 pending 下轮/下次重试）。
 */
async function processChannel(
  channelName: string,
  batchSize: number
): Promise<void> {
  try {
    const decision = await assessRefillNeed(channelName);
    if (decision.status === "unreadable") {
      recordResult(
        channelName,
        "unreadable",
        "读取渠道状态失败，本轮跳过，稍后重试"
      );
      await safeLog(
        "warn",
        channelName,
        "只读检测渠道状态失败，本轮跳过（保留缓存，下轮重试）"
      );
      return;
    }

    const p = decision.platformKeyCount;
    const d = decision.deadKeyCount;
    const alive = decision.aliveKeyCount;
    const stats = p != null && d != null ? `（平台 ${p}/禁用 ${d}）` : "";

    // 缺 key 时才尝试取一批；nextPendingBatch 空即池无待上传，退回记录结论
    if (decision.needsKeys) {
      const batch = await nextPendingBatch(channelName, batchSize);
      if (batch.length > 0) {
        await pushBatchToChannel(
          channelName,
          batch.map((b) => b.key)
        );
        await markPoolUploaded(batch.map((b) => b.id));
        recordResult(
          channelName,
          decision.status,
          decision.status === "missing"
            ? `渠道原不存在，已创建并上传 ${batch.length} 个 key`
            : `无可用 key${stats}，已补充上传 ${batch.length} 个 key`
        );
        return;
      }
    }

    // 未上传：记录检查结论
    switch (decision.status) {
      case "alive":
        recordResult(channelName, "alive", `可用 ${alive} 个 key${stats}，无需补给`);
        break;
      case "exhausted":
        recordResult(
          channelName,
          "exhausted",
          `无可用 key${stats}，队列已空，等待新 key`
        );
        break;
      case "missing":
        recordResult(channelName, "missing", "渠道未创建，队列暂无可上传 key");
        break;
      case "manual":
        recordResult(
          channelName,
          "manual",
          `渠道被手动禁用${stats}，跳过自动补给`
        );
        break;
    }
  } catch (err) {
    // 单渠道失败不影响其它渠道；key 未标记 uploaded，下轮/下次重试
    recordResult(
      channelName,
      "unreadable",
      `补给失败：${err instanceof Error ? err.message : String(err)}`
    );
    await safeLog(
      "error",
      channelName,
      `补给失败：${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * 单次调度（按需补给 + 缓存刷新）：遍历「已解析出 channelId 的绑定渠道」∪「有 pending 的渠道」，
 * 逐个（串行）processChannel。isRunning 防重入。
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
    const users = await getUsers();
    const resolvedBound = users
      .filter((u) => u.channelName.trim().length > 0 && u.channelId != null)
      .map((u) => u.channelName.trim());
    const pendingChannels = await channelsWithPending();
    const targets = Array.from(
      new Set([...resolvedBound, ...pendingChannels])
    );

    for (const channelName of targets) {
      await processChannel(channelName, batchSize);
    }
  } catch (err) {
    // 顶层兜底：绝不让 tick 抛出
    console.error("[engine] tick 失败:", err);
  } finally {
    state.isRunning = false;
    state.nextTickAt = Date.now() + TICK_INTERVAL_MS;
  }
}

/**
 * 用户上传 key 后立即 kick 一次（只处理该渠道），避免等待整分钟定时轮。
 * **已有调度在跑（isRunning）则直接忽略**：交给当前那轮或下一轮处理（用户要求「除非已有任务再进行」）。
 * fire-and-forget：同步返回，实际补给在后台异步执行，不阻塞上传响应。
 */
export function kickEngine(channelName: string): void {
  const state = engineState();
  if (state.isRunning) return; // 已有任务在跑，交给它/下一轮
  const name = channelName.trim();
  if (!name) return;
  void (async () => {
    // 再次判重并同步置位（Node 单线程，置位前无 await，不会与 tick 并发）
    if (state.isRunning) return;
    state.isRunning = true;
    state.lastTickAt = Date.now();
    try {
      const cfg = await getConfig();
      if (!cfg.autoRefillEnabled) return; // 自动补 key 关闭
      const batchSize = clampBatchSize(cfg.uploadBatchSize);
      await processChannel(name, batchSize);
    } catch (err) {
      console.error("[engine] kick 失败:", err);
    } finally {
      state.isRunning = false;
    }
  })();
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
