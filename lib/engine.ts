// 定时引擎（新模型：自动建新渠道 + 缓存刷新）：每 N 分钟遍历「仍有 pending key 的前缀」
// 与「已建过渠道的前缀」的并集。对有 pending 的前缀，当自动补给开启时从本地池逐批建新渠道
//（每批数量=配置 uploadBatchSize，单轮上限防止一次建太多）；对无 pending 的前缀只刷新其
// 已建渠道的实时缓存（让管理员列表 key 统计 ≤N 分钟新鲜）。
//
// 单例守卫挂 globalThis，兼容 Next dev 热重载 / standalone 多次 import，避免重复启动定时器。
// 引擎内任何异常都被捕获，绝不让 tick 抛出而中断定时器或 crash 进程。
import {
  createChannelFromNextBatch,
  createChannelsDrain,
  demoteAllDegradedChannels,
  reconcileTrackedPriorities,
  refreshChannelUsage,
  refreshPrefixRealtime,
} from "./channelService";
import {
  channelsWithPending,
  clampDemoteIntervalSeconds,
  clampIntervalMinutes,
  clampPriorityTaskIntervalMinutes,
  clampUsageRefreshIntervalMinutes,
  countChannelsAtPriorityForPrefix,
  findUserByChannelName,
  getConfig,
  poolCounts,
  prefixesWithCreatedChannels,
  reclaimStaleClaimed,
} from "./store";
import { FIXED_PRIORITY } from "./supplier";

/** 补给间隔默认值（分钟）——首个 tick 读到配置前的兜底，与 store 的 seed 一致。 */
const DEFAULT_INTERVAL_MS = 60_000;
const INITIAL_DELAY_MS = 5_000;
/** 优先级降级全局任务默认间隔（ms）——首轮读到配置前的兜底，与 store seed(5 分钟)一致。 */
const DEFAULT_PRIORITY_INTERVAL_MS = 5 * 60_000;
/** 优先级对账任务首次延迟（ms）：错开补给引擎首轮，避开建渠道与对账同时抢 naci。 */
const PRIORITY_INITIAL_DELAY_MS = 20_000;
/** 退化降级快循环默认间隔（ms）：读到配置(demoteIntervalSeconds)前的兜底，与 store seed(30s)一致。 */
const DEMOTE_FAST_INTERVAL_MS = 30_000;
/** 退化降级快循环首次延迟（ms）：错开补给(5s)与对账(20s)首轮。 */
const DEMOTE_INITIAL_DELAY_MS = 30_000;
/** 用量刷新默认间隔（ms）——读到配置(usageRefreshIntervalMinutes)前的兜底，与 store seed(10 分钟)一致。 */
const DEFAULT_USAGE_INTERVAL_MS = 10 * 60_000;
/** 用量刷新首次延迟（ms）：错开其它首轮。 */
const USAGE_INITIAL_DELAY_MS = 45_000;
/** claimed 死行回收阈值（分钟）：超过则视为进程崩溃残留，退回 pending 重试。 */
const CLAIM_STALE_MINUTES = 10;

/** 单前缀最近一次检查结果（供前端展示「上次检查做了什么/结果如何」）。 */
export interface LastCheckResult {
  at: number; // 检查完成时间戳(ms)
  status: "created" | "empty" | "paused" | "limited" | "waiting" | "error";
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
  // —— 优先级对账全局任务（独立自调度定时器，间隔由 priorityTaskIntervalMinutes 配置） ——
  priorityRunning: boolean; // 防重入（对账）
  priorityTimer: ReturnType<typeof setTimeout> | null;
  priorityIntervalMs: number; // 当前生效的对账任务间隔(ms)
  lastPriorityRunAt: number | null; // 上次对账任务完成时间戳(ms)
  // —— 退化降级快循环（间隔由 demoteIntervalSeconds 配置，独立定时器） ——
  demoteRunning: boolean; // 防重入（降级）
  demoteTimer: ReturnType<typeof setTimeout> | null;
  demoteIntervalMs: number; // 当前生效的降级检测间隔(ms)，每轮从配置刷新
  lastDemoteRunAt: number | null; // 上次降级任务完成时间戳(ms)
  // —— 用量刷新任务（间隔由 usageRefreshIntervalMinutes 配置，独立定时器） ——
  usageRunning: boolean; // 防重入（用量刷新）
  usageTimer: ReturnType<typeof setTimeout> | null;
  usageIntervalMs: number; // 当前生效的用量刷新间隔(ms)，每轮从配置刷新
  lastUsageRunAt: number | null; // 上次用量刷新完成时间戳(ms)
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
      priorityRunning: false,
      priorityTimer: null,
      priorityIntervalMs: DEFAULT_PRIORITY_INTERVAL_MS,
      lastPriorityRunAt: null,
      demoteRunning: false,
      demoteTimer: null,
      demoteIntervalMs: DEMOTE_FAST_INTERVAL_MS,
      lastDemoteRunAt: null,
      usageRunning: false,
      usageTimer: null,
      usageIntervalMs: DEFAULT_USAGE_INTERVAL_MS,
      lastUsageRunAt: null,
    };
  } else {
    if (!g.__keyloadEngine.lastResults) g.__keyloadEngine.lastResults = {};
    if (!g.__keyloadEngine.intervalMs)
      g.__keyloadEngine.intervalMs = DEFAULT_INTERVAL_MS;
    if (!g.__keyloadEngine.priorityIntervalMs)
      g.__keyloadEngine.priorityIntervalMs = DEFAULT_PRIORITY_INTERVAL_MS;
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
  autoRefill: boolean,
  processBatchSize: number
): Promise<void> {
  try {
    const user = await findUserByChannelName(prefix);
    if (!user) {
      // 池里有 key 但没有绑定该前缀的用户：跳过（无法回写统计）
      recordResult(prefix, "empty", "无绑定用户，跳过");
      return;
    }

    // 注：退化降级已抽出为**全局单一定时任务**（runPriorityTaskAndReschedule），
    // 不再在此每前缀/每轮各自处理。

    const { pending } = await poolCounts(prefix);

    if (pending > 0 && autoRefill) {
      // 本轮最多处理 processBatchSize 个 key（拆成 ⌈processBatchSize/聚合数⌉ 个渠道）
      const drain = await createChannelsDrain(user, processBatchSize);
      if (drain.limited) {
        recordResult(
          prefix,
          "limited",
          drain.createdChannels > 0
            ? `自动新建 ${drain.createdChannels} 个渠道后触发上传限速（剩余待上传 ${drain.poolPending}，等窗口滚动续传）`
            : drain.limitedMessage ?? "上传限速中，等窗口滚动后续传"
        );
      } else if (drain.createdChannels > 0) {
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

/** 轮转分配器单轮硬上限（安全阀，防极端情况死循环）。 */
const RR_HARD_CAP = 5000;

/**
 * 逐前缀刷新实时缓存之间的节流（毫秒）：每前缀刷新要发 2 次 naci 请求
 *（getChannelsStatusBatch + getChannelsUsedQuota），前缀多时若背靠背发送会瞬时打爆 naci 触发 429。
 * 加此间隔把 `2×前缀数` 个请求在时间上摊开（如 50 前缀×350ms≈18s，仍在默认 60s 轮内）。
 */
const REFRESH_THROTTLE_MS = 350;

/**
 * 刷新「有已建渠道的前缀」实时缓存（保持管理端统计新鲜），**前缀之间节流**削峰。
 * 供 tick / kick 的「仅高优先级」分支复用，避免各自重复写循环。
 */
async function refreshCreatedPrefixes(): Promise<void> {
  const prefixes = await prefixesWithCreatedChannels();
  for (let i = 0; i < prefixes.length; i++) {
    const user = await findUserByChannelName(prefixes[i]);
    if (user) await refreshPrefixRealtime(user);
    if (i < prefixes.length - 1) {
      await new Promise((r) => setTimeout(r, REFRESH_THROTTLE_MS));
    }
  }
}

/**
 * 「仅高优先级」模式的公平分配器：把空闲优先级6名额按**最少者优先的轮转**统一分给所有有待上传的用户。
 *
 * **统一优先级**：所有用户同等对待，不区分每用户的高优先级权限/独立配额，只受全局名额（priority6Limit）限制；
 * 用户之间的公平完全由这里的轮转保证。公平算法：**每一轮**都按各用户「当前持有的优先级6渠道数」升序排序
 *（持有最少者先分），每轮给每个前缀各建 1 个渠道。稀缺名额中途用尽时，本轮排在后面（已持有较多）的用户先被拒，
 * 于是空闲/回收出来的名额总是优先流向享受最少的用户 → 长期看各用户尽量均等（max-min 公平）。
 *
 * 依赖 createChannelFromNextBatch 内部名额门控：全局名额满时返回 waitingSlot，本前缀退出本次轮转；
 * 全局名额耗尽时所有前缀下一轮都 waitingSlot → active 清空、循环结束。返回本次建成的渠道数。
 */
async function distributeHighPriorityRoundRobin(): Promise<number> {
  const prefixes = await channelsWithPending();
  const active: { prefix: string; user: Awaited<ReturnType<typeof findUserByChannelName>> }[] =
    [];
  for (const p of prefixes) {
    const user = await findUserByChannelName(p);
    if (user) active.push({ prefix: p, user });
    else recordResult(p, "empty", "无绑定用户，跳过");
  }
  let built = 0;
  let guard = 0;
  while (active.length > 0 && guard++ < RR_HARD_CAP) {
    // 本轮开始：按当前高优先级持有数升序排序（持有最少者优先拿到稀缺名额）。
    const counts = new Map<string, number>();
    for (const e of active) {
      counts.set(e.prefix, await countChannelsAtPriorityForPrefix(e.prefix, FIXED_PRIORITY));
    }
    active.sort((a, b) => (counts.get(a.prefix) ?? 0) - (counts.get(b.prefix) ?? 0));

    let progressed = false;
    for (const entry of [...active]) {
      let r;
      try {
        // viaScheduler:true —— 仅定时任务可建渠道，手动/直接路径一律入池（见 createChannelFromNextBatch 门控）。
        r = await createChannelFromNextBatch(entry.user!, { viaScheduler: true });
      } catch (err) {
        recordResult(
          entry.prefix,
          "error",
          `处理失败：${err instanceof Error ? err.message : String(err)}`
        );
        const idx = active.indexOf(entry);
        if (idx >= 0) active.splice(idx, 1);
        continue;
      }
      if (r.created) {
        built += 1;
        progressed = true;
        recordResult(
          entry.prefix,
          "created",
          `自动新建高优先级渠道 ${r.channelName}（本批 ${r.keyCount} 个，剩余待上传 ${r.poolPending}）`
        );
      } else {
        // waitingSlot（名额满/用户配额满）或 池空 → 退出本前缀轮转
        recordResult(
          entry.prefix,
          r.waitingSlot ? "waiting" : "empty",
          r.waitingMessage ?? "队列已空，等待新 key"
        );
        const idx = active.indexOf(entry);
        if (idx >= 0) active.splice(idx, 1);
      }
    }
    if (!progressed) break; // 一整轮没建成（名额用尽/池都空）→ 结束
  }
  return built;
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
    const processBatchSize = cfg.processBatchSize;

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

    // 「仅高优先级」模式：用轮转分配器公平分配空闲名额，再刷新已建渠道缓存；
    // 否则走原有「每前缀 drain 到底」逻辑。
    if (cfg.onlyHighPriorityEnabled && autoRefill) {
      await distributeHighPriorityRoundRobin();
      // 刷新有已建渠道的前缀缓存（保持管理端统计新鲜），前缀间节流削峰
      await refreshCreatedPrefixes();
      return;
    }

    const pendingPrefixes = await channelsWithPending();
    const createdPrefixes = await prefixesWithCreatedChannels();
    const targets = Array.from(
      new Set([...pendingPrefixes, ...createdPrefixes])
    );

    for (let i = 0; i < targets.length; i++) {
      await processPrefix(targets[i], autoRefill, processBatchSize);
      // 前缀间节流：无 pending 的前缀在 processPrefix 内会刷新实时缓存(2 次 naci)，
      // 背靠背发送易触发 naci 429，摊开发送。
      if (i < targets.length - 1) {
        await new Promise((r) => setTimeout(r, REFRESH_THROTTLE_MS));
      }
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
      // 仅高优先级模式：kick 也走**公平轮转**（不针对单一前缀），避免触发上传的用户抢光名额；
      // 其余模式按原逻辑只处理该前缀。
      if (cfg.onlyHighPriorityEnabled && cfg.autoRefillEnabled) {
        await distributeHighPriorityRoundRobin();
        await refreshCreatedPrefixes();
      } else {
        await processPrefix(name, cfg.autoRefillEnabled, cfg.processBatchSize);
      }
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

/**
 * 优先级对账任务（慢循环，分钟级）：把本地「假6」同步为 naci 真实优先级
 * （naci 静默降级会留下漂移，卡死配额）。对账后本地计数准确，退化降级(快循环)只处理真正还在优先级6的渠道。
 * 独立于补给引擎，间隔由 priorityTaskIntervalMinutes 配置；priorityRunning 防重入。
 */
async function runReconcileTask(): Promise<void> {
  const state = engineState();
  if (state.priorityRunning) return;
  state.priorityRunning = true;
  try {
    const cfg = await getConfig();
    state.priorityIntervalMs =
      clampPriorityTaskIntervalMinutes(cfg.priorityTaskIntervalMinutes) * 60_000;
    const reconciled = await reconcileTrackedPriorities();
    if (reconciled > 0) {
      await safeLog(
        "info",
        undefined,
        `优先级对账：修正 ${reconciled} 个渠道的本地优先级（同步 naci 实际值，释放被假6占用的配额）`
      );
    }
  } catch (err) {
    console.error("[engine] 优先级对账任务失败:", err);
  } finally {
    state.priorityRunning = false;
    state.lastPriorityRunAt = Date.now();
  }
}

/**
 * 退化降级快循环（间隔由 demoteIntervalSeconds 配置，默认 30s）：直接用一次 status-batch 读
 * 「本地记为高优先级(>5)」的渠道状态，任一站点被禁用即降到 5，腾出稀缺的优先级配额。
 * 仅高优先级模式下降级后立即补建。demoteRunning 防重入。
 */
async function runDemoteTask(): Promise<void> {
  const state = engineState();
  if (state.demoteRunning) return;
  state.demoteRunning = true;
  try {
    const cfg = await getConfig();
    state.demoteIntervalMs = clampDemoteIntervalSeconds(cfg.demoteIntervalSeconds) * 1000;
    const demoted = await demoteAllDegradedChannels();
    if (demoted > 0) {
      await safeLog(
        "info",
        undefined,
        `退化降级：本轮降级 ${demoted} 个退化渠道（6→5，腾出优先级配额）`
      );
      // 仅高优先级模式：刚回收了名额 → 立即把池里等待的 key 补进空出的名额，无需等下一个补给间隔。
      if (cfg.onlyHighPriorityEnabled && cfg.autoRefillEnabled) {
        try {
          const built = await distributeHighPriorityRoundRobin();
          if (built > 0) {
            await safeLog(
              "info",
              undefined,
              `退化降级：回收后立即补建 ${built} 个高优先级渠道`
            );
          }
        } catch (err) {
          console.error("[engine] 回收后补建失败:", err);
        }
      }
    }
  } catch (err) {
    console.error("[engine] 退化降级任务失败:", err);
  } finally {
    state.demoteRunning = false;
    state.lastDemoteRunAt = Date.now();
  }
}

/** 跑一次优先级对账并按当前生效间隔安排下一次（自调度 setTimeout 链）。 */
async function runReconcileAndReschedule(): Promise<void> {
  const state = engineState();
  try {
    await runReconcileTask();
  } finally {
    const delay =
      state.priorityIntervalMs > 0
        ? state.priorityIntervalMs
        : DEFAULT_PRIORITY_INTERVAL_MS;
    if (state.priorityTimer) clearTimeout(state.priorityTimer);
    state.priorityTimer = setTimeout(() => {
      void runReconcileAndReschedule();
    }, delay);
  }
}

/** 跑一次退化降级并按当前生效间隔安排下一次（自调度 setTimeout 链）。 */
async function runDemoteAndReschedule(): Promise<void> {
  const state = engineState();
  try {
    await runDemoteTask();
  } finally {
    const delay =
      state.demoteIntervalMs > 0 ? state.demoteIntervalMs : DEMOTE_FAST_INTERVAL_MS;
    if (state.demoteTimer) clearTimeout(state.demoteTimer);
    state.demoteTimer = setTimeout(() => {
      void runDemoteAndReschedule();
    }, delay);
  }
}

/**
 * 用量刷新任务（间隔由 usageRefreshIntervalMinutes 配置）：按频率批量刷新未刷满次数的渠道用量。
 * 每渠道刷够 usageMaxUpdates 次即冻结，避免持续对老渠道拉 used-quota 造成雪崩。usageRunning 防重入。
 */
async function runUsageTask(): Promise<void> {
  const state = engineState();
  if (state.usageRunning) return;
  state.usageRunning = true;
  try {
    const cfg = await getConfig();
    state.usageIntervalMs =
      clampUsageRefreshIntervalMinutes(cfg.usageRefreshIntervalMinutes) * 60_000;
    const updated = await refreshChannelUsage();
    if (updated > 0) {
      await safeLog(
        "info",
        undefined,
        `用量刷新：本轮更新 ${updated} 个渠道用量缓存`
      );
    }
  } catch (err) {
    console.error("[engine] 用量刷新任务失败:", err);
  } finally {
    state.usageRunning = false;
    state.lastUsageRunAt = Date.now();
  }
}

/** 跑一次用量刷新并按当前生效间隔安排下一次（自调度 setTimeout 链）。 */
async function runUsageAndReschedule(): Promise<void> {
  const state = engineState();
  try {
    await runUsageTask();
  } finally {
    const delay =
      state.usageIntervalMs > 0 ? state.usageIntervalMs : DEFAULT_USAGE_INTERVAL_MS;
    if (state.usageTimer) clearTimeout(state.usageTimer);
    state.usageTimer = setTimeout(() => {
      void runUsageAndReschedule();
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

  // 优先级对账任务（慢循环，分钟级；独立定时器，错开补给首轮）
  state.priorityTimer = setTimeout(() => {
    void runReconcileAndReschedule();
  }, PRIORITY_INITIAL_DELAY_MS);

  // 退化降级快循环（间隔按配置 demoteIntervalSeconds；独立定时器，错开补给与对账首轮）
  state.demoteTimer = setTimeout(() => {
    void runDemoteAndReschedule();
  }, DEMOTE_INITIAL_DELAY_MS);

  // 用量刷新任务（间隔按配置 usageRefreshIntervalMinutes；每渠道刷够上限即冻结防雪崩）
  state.usageTimer = setTimeout(() => {
    void runUsageAndReschedule();
  }, USAGE_INITIAL_DELAY_MS);

  console.log(
    "[engine] 定时建渠道引擎 + 优先级对账(分钟级) + 退化降级(可配秒级) + 用量刷新(可配分钟级) 已启动"
  );
}
