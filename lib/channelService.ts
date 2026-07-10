// 核心业务（新模型）：本地 key 池 + 每上传一批就**新建一个** naci 渠道并发布。
//
// 用户不再绑定固定渠道名，而是配置**前缀**（存 users.channel_name）。
// 上传入口 enqueueKeys 只把 key 落本地池；createChannelFromNextBatch 从池取「下一批」
//（数量=管理员 uploadBatchSize），分配递增序号，建渠道名 `${prefix}-0001`，创建并发布
//（发布站点为 PUBLISH_SITES，已排除 ai 站），记录到 created_channels。
// 定时引擎（lib/engine.ts）在开启自动补给时，把仍有 pending 的前缀逐批建成新渠道。
import {
  createChannel,
  getChannelSites,
  getChannelsStatusBatch,
  getChannelsUsedQuota,
  QUOTA_PER_USD,
  setChannelPriority,
  setSiteStatus,
} from "./naci";
import {
  DEMOTED_PRIORITY,
  FIXED_PRIORITY,
  parseKeys,
  PUBLISH_SITES,
} from "./supplier";
import {
  addKeysToPool,
  addLog,
  allocateCreatedChannel,
  claimPendingBatch,
  countChannelsAtPriority,
  countChannelsAtPriorityForPrefix,
  createdChannelIds,
  createdChannelSitesByChannel,
  deleteCreatedChannel,
  finalizeCreatedChannel,
  findUserByChannelName,
  getConfig,
  getCreatedChannelByChannelId,
  getUploadedKeyCount,
  listChannelsAbovePriority,
  listChannelsNeedingUsageRefresh,
  listCreatedChannels,
  markPoolUploaded,
  poolCounts,
  recordChannelUsage,
  recordCreatedChannelSites,
  recordUploadedKeys,
  releaseClaim,
  setChannelStatusByChannelId,
  setChannelUsage,
  sumChannelUsedQuotaByPrefix,
  updateCreatedChannelPriority,
  updateUserKeyStats,
  updateUserUsedQuota,
  upsertUser,
  type CreatedChannelSite,
} from "./store";
import {
  effectiveUserLimit,
  GLOBAL_SCOPE,
  peekBucket,
  releaseBucket,
  reserveBucket,
  userScope,
} from "./rateLimit";
import type { User } from "./types";

/** 单次「逐批建渠道」的渠道数硬上限（安全阀，防极端 paste 打爆 naci）。实际处理量由 maxKeys 控制。 */
export const MAX_CHANNELS_PER_DRAIN = 500;

/** 是否为「优先级 N 配额已满」错误（如「优先级6已达到最多6个启用渠道限制」）→ 需回退更低优先级。 */
function isPriorityQuotaError(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return (
    m.includes("启用渠道限制") ||
    (m.includes("优先级") && (m.includes("已达") || m.includes("上限")))
  );
}

/** 单前缀最近一次检查结果（前端展示用）。 */
export interface LastCheckView {
  at: string; // ISO
  status: string;
  message: string;
}

/**
 * 读定时引擎调度状态（从 globalThis 读，避免与 engine.ts 循环依赖）：
 * 下一次检查时间、当前是否正在检查，以及该前缀最近一次检查的结果/执行说明。
 */
function engineViewState(prefix?: string): {
  nextCheckAt: string | null;
  checking: boolean;
  lastCheck: LastCheckView | null;
} {
  const g = globalThis as unknown as {
    __keyloadEngine?: {
      nextTickAt: number | null;
      isRunning: boolean;
      lastResults?: Record<
        string,
        { at: number; status: string; message: string }
      >;
    };
  };
  const e = g.__keyloadEngine;
  const r = prefix ? e?.lastResults?.[prefix.trim()] : undefined;
  return {
    nextCheckAt: e?.nextTickAt ? new Date(e.nextTickAt).toISOString() : null,
    checking: e?.isRunning ?? false,
    lastCheck: r
      ? { at: new Date(r.at).toISOString(), status: r.status, message: r.message }
      : null,
  };
}

/** 单站调度状态（供前端展示 / 手动开关）：status=null 表示平台未返回该站。 */
export interface SiteSchedule {
  site_id: number;
  site_name: string;
  /** 1=开启，3=自动禁用，0=关闭，2=手动禁用；null=平台未返回 */
  status: number | null;
}

/**
 * 以发布站点（PUBLISH_SITES，已排除 ai 站）为基准，套上平台返回的每站 status：
 * 平台返回了该站 → 用其 status；未返回 → status=null。
 */
function sitesWithNames(
  statuses: { site_id: number; status: number }[]
): SiteSchedule[] {
  const statusMap = new Map(statuses.map((s) => [s.site_id, s.status]));
  return PUBLISH_SITES.map((s) => ({
    site_id: s.site_id,
    site_name: s.site_name,
    status: statusMap.has(s.site_id) ? statusMap.get(s.site_id)! : null,
  }));
}

/** 上传入口：只把 key 落本地池（按前缀归组），不直接建渠道（由手动按钮 / 定时引擎逐批建）。 */
export async function enqueueKeys(
  user: User,
  keys: string[]
): Promise<{ added: number; poolPending: number; poolUploaded: number }> {
  const prefix = user.channelName.trim();
  if (!prefix) {
    throw new Error("当前用户未配置渠道前缀，无法上传 key");
  }

  const cleanKeys = parseKeys(keys.join("\n"));
  if (cleanKeys.length === 0) {
    throw new Error("没有有效的 key");
  }

  const { added, pending, uploaded } = await addKeysToPool(prefix, cleanKeys);

  await addLog({
    level: "info",
    actor: user.username,
    channelName: prefix,
    message: `入队 ${added} 个新 key（待上传 ${pending}，已上传 ${uploaded}）`,
  });

  return { added, poolPending: pending, poolUploaded: uploaded };
}

/** 「新建一批渠道」结果。 */
export interface CreateBatchResult {
  /** 是否新建了渠道（池无 pending 时为 false）。 */
  created: boolean;
  channelName?: string;
  channelId?: number;
  /** 本批上传的 key 数。 */
  keyCount?: number;
  /** 本系统累计去重上传数（该前缀）。 */
  uploadedKeyCount?: number;
  /** 是否因上传限速被拦下（此时 created:false 且池里仍有 pending）。 */
  limited?: boolean;
  /** 限速说明（供前端 toast / 日志展示）。 */
  limitedMessage?: string;
  /** 是否因「仅高优先级」模式无空闲优先级6名额被拦下（created:false，key 留池等回收）。 */
  waitingSlot?: boolean;
  /** 等待名额说明。 */
  waitingMessage?: string;
  poolPending: number;
  poolUploaded: number;
  platformKeyCount: number | null;
  deadKeyCount: number | null;
}

/**
 * 「仅高优先级」模式名额门控：返回不可建的原因串（无空闲优先级6名额），有名额则返回 null。
 *
 * **统一优先级**：所有用户同等对待，只受**全局**高优先级名额（priority6Limit）门控，
 * 不再区分每用户的高优先级权限(allowHighPriority)/独立配额(highPriorityLimit)——那两项仅在非本模式下生效。
 * 各用户之间的公平由定时任务的轮转分配器（最少者优先）保证，而非在此按用户配额限制。
 * 依赖 countChannelsAtPriority(6) 准确（已由对账保证）。
 */
async function highPrioritySlotBlock(
  cfg: Awaited<ReturnType<typeof getConfig>>
): Promise<string | null> {
  const g6 = await countChannelsAtPriority(FIXED_PRIORITY);
  if (g6 >= cfg.priority6Limit) {
    return `仅高优先级模式：全局高优先级已满（${g6}/${cfg.priority6Limit}），等待名额回收`;
  }
  return null;
}

/**
 * 从本地池取「下一批」（数量=管理员 uploadBatchSize）建成一个新 naci 渠道并发布：
 * 1. 池无 pending → created:false（返回池计数）。
 * 2. **原子认领**该批 key（claimPendingBatch：pending→claimed，FOR UPDATE SKIP LOCKED），
 *    并发调用各自认领不相交批次；再原子分配序号+占位行 → createChannel(prefix-0001)。
 *    naci 创建失败 → releaseClaim(claimed→pending) + 删除占位行（回滚序号）并抛出。
 * 3. naci 成功后**先 markPoolUploaded**（claimed→uploaded，保证 key 不再被重传），
 *    再 best-effort finalize（回填 channel_id/key_count + 各站远程 id；失败只记日志不抛，
 *    避免让已建成的渠道把 key 退回 pending 造成重传）；记累计去重；回写用户缓存；失效实时缓存。
 */
export async function createChannelFromNextBatch(
  user: User,
  opts: { viaScheduler?: boolean; forceNormalPriority?: boolean; bypassPriorityGate?: boolean } = {}
): Promise<CreateBatchResult> {
  const prefix = user.channelName.trim();
  if (!prefix) throw new Error("当前用户未配置渠道前缀，无法上传 key");

  const cfg = await getConfig();
  const eff = effectiveUserLimit(user, cfg);

  // —— 仅高优先级模式：入口区别对待 ——
  // - 定时任务(viaScheduler)：建高优先级(优先级6)渠道，受名额门控 + 公平轮转。
  // - 手动路径（「上传一批」）：不抢名额，入池排队，由定时任务在各用户间公平分配 → waitingSlot。
  // - 直接上传(bypassPriorityGate)：不受 onlyHighPriorityEnabled 门控，正常优先级逻辑（P6有空就6，满则5）。
  // - 强制普通(forceNormalPriority)：跳过门控，直接建普通(优先级5)渠道（当前无调用方，作为保留能力）。
  if (cfg.onlyHighPriorityEnabled && !opts.forceNormalPriority && !opts.bypassPriorityGate) {
    if (!opts.viaScheduler) {
      const { pending, uploaded } = await poolCounts(prefix);
      return {
        created: false,
        waitingSlot: true,
        waitingMessage:
          "仅高优先级模式：高优先级渠道由定时任务在各用户间公平分配，key 已在本地库排队，等待名额回收后自动创建",
        poolPending: pending,
        poolUploaded: uploaded,
        platformKeyCount: null,
        deadKeyCount: null,
      };
    }
    // 无空闲优先级6名额则不建（不认领、不占限速额度），key 留池等回收。
    const block = await highPrioritySlotBlock(cfg);
    if (block) {
      const { pending, uploaded } = await poolCounts(prefix);
      return {
        created: false,
        waitingSlot: true,
        waitingMessage: block,
        poolPending: pending,
        poolUploaded: uploaded,
        platformKeyCount: null,
        deadKeyCount: null,
      };
    }
  }

  // —— 上传限速：原子「预占」额度（事前扣，让在途上传即时占住桶，杜绝并发双超额）。 ——
  // 依次预占全局桶、用户桶（用户只在全局已批额度内再占）；不足一整批 → 允许小批（避免限额<聚合数死锁）。
  const want = cfg.uploadBatchSize;
  const g = await reserveBucket(
    GLOBAL_SCOPE,
    cfg.globalUploadLimitCount,
    want,
    cfg.globalUploadLimitWindowMinutes
  );
  const u = await reserveBucket(
    userScope(user.id),
    eff.limit,
    g.granted,
    eff.windowMinutes
  );
  // 找零①：用户批得比全局少 → 退还全局多占的部分
  let reservedG = g.members;
  if (u.granted < g.granted) {
    const extra = g.members.slice(u.granted);
    await releaseBucket(GLOBAL_SCOPE, extra);
    reservedG = g.members.slice(0, u.granted);
  }
  let reservedU = u.members;
  const final = u.granted;

  if (final <= 0) {
    // 额度耗尽：退还两桶已占（正常为空），记日志，返回 limited
    await releaseBucket(GLOBAL_SCOPE, reservedG);
    await releaseBucket(userScope(user.id), reservedU);
    const blocker =
      g.granted <= 0
        ? `全局限速窗口已满（${cfg.globalUploadLimitWindowMinutes} 分钟内 ${cfg.globalUploadLimitCount} 个）`
        : `用户限速窗口已满（${eff.windowMinutes} 分钟内 ${eff.limit} 个）`;
    const limitedMessage = `上传限速中：${blocker}，等待窗口滚动后自动续传`;
    const { pending, uploaded } = await poolCounts(prefix);
    if (pending > 0) {
      await addLog({
        level: "info",
        actor: user.username,
        channelName: prefix,
        message: `${limitedMessage}（待上传 ${pending}）`,
      });
    }
    return {
      created: false,
      limited: true,
      limitedMessage,
      poolPending: pending,
      poolUploaded: uploaded,
      platformKeyCount: null,
      deadKeyCount: null,
    };
  }

  // 原子认领：并发（双击 / 双标签页 / kick 撞手动 / admin+user）各自拿到不相交批次
  const batch = await claimPendingBatch(prefix, final);
  // 找零②：池里 pending 少于预占额度 → 退还两桶尾部多占的 (final-actual) 个
  const actual = batch.length;
  if (actual < final) {
    await releaseBucket(GLOBAL_SCOPE, reservedG.slice(actual));
    await releaseBucket(userScope(user.id), reservedU.slice(actual));
    reservedG = reservedG.slice(0, actual);
    reservedU = reservedU.slice(0, actual);
  }
  if (actual === 0) {
    // 池空（非限速）：预占全部退还
    const { pending, uploaded } = await poolCounts(prefix);
    return {
      created: false,
      poolPending: pending,
      poolUploaded: uploaded,
      platformKeyCount: null,
      deadKeyCount: null,
    };
  }
  // 建渠道链路任一步失败时，退还本批预占额度（连同认领与占位行回滚）
  const releaseReservation = async () => {
    await releaseBucket(GLOBAL_SCOPE, reservedG);
    await releaseBucket(userScope(user.id), reservedU);
  };
  const batchIds = batch.map((b) => b.id);

  const cleanKeys = batch.map((b) => b.key);
  const keyText = cleanKeys.join("\n");

  // 原子分配序号 + 占位行（同前缀并发串行化，避免序号冲突）。
  // 失败时立即把已认领的 key 退回 pending，避免它们滞留 claimed 到 reclaim 才回收。
  let alloc: Awaited<ReturnType<typeof allocateCreatedChannel>>;
  try {
    alloc = await allocateCreatedChannel(prefix);
  } catch (err) {
    await releaseClaim(batchIds);
    await releaseReservation();
    throw err;
  }

  // —— 优先级判定：按用户高优先级配额 + 本地全局配额（省去「先试6→服务器报错→再试5」往返）。 ——
  // 用户被禁高优先级 → 直接 5；否则若全局优先级6已满 或 用户独立优先级6数量已满 → 5。服务器报错仍作兜底。
  // 仅高优先级模式：已在函数入口门控过名额，此处**强制优先级6**，不走降级到5。
  let desiredPriority = FIXED_PRIORITY;
  let demoteReason = "";
  if (opts.forceNormalPriority) {
    // 直接上传：**任何模式**下都不占用稀缺的高优先级名额，直接建普通(优先级5)渠道立即上传。
    desiredPriority = DEMOTED_PRIORITY;
    demoteReason = "直接上传（不占用高优先级名额，建普通渠道）";
  } else if (cfg.onlyHighPriorityEnabled && !opts.bypassPriorityGate) {
    // 仅高优先级模式的定时任务路径：已在入口门控过名额，此处保持优先级6，不走降级。
  } else {
    const priority6Count = await countChannelsAtPriority(FIXED_PRIORITY);
    if (user.allowHighPriority === false) {
      desiredPriority = DEMOTED_PRIORITY;
      demoteReason = "该用户被禁用高优先级";
    } else if (priority6Count >= cfg.priority6Limit) {
      desiredPriority = DEMOTED_PRIORITY;
      demoteReason = `全局优先级 ${FIXED_PRIORITY} 已满（${priority6Count}/${cfg.priority6Limit}）`;
    } else if (user.highPriorityLimit != null) {
      const userP6 = await countChannelsAtPriorityForPrefix(prefix, FIXED_PRIORITY);
      if (userP6 >= user.highPriorityLimit) {
        desiredPriority = DEMOTED_PRIORITY;
        demoteReason = `该用户独立优先级 ${FIXED_PRIORITY} 配额已满（${userP6}/${user.highPriorityLimit}）`;
      }
    }
  }

  let channelId: number;
  let usedPriority = desiredPriority; // 请求/兜底后使用的优先级
  let actualPriority: number | undefined; // naci 创建响应里回读的**实际**优先级（可能被服务端静默降级）
  let publishSites: CreatedChannelSite[] = [];
  try {
    let created;
    try {
      created = await createChannel({
        name: alloc.channelName,
        keyText,
        models: cfg.models,
        priority: desiredPriority,
      });
      // 直接上传(forceNormalPriority)按批必然是 5，逐渠道记日志太吵，由 directUploadKeys 汇总记一条
      if (desiredPriority === DEMOTED_PRIORITY && !opts.forceNormalPriority) {
        await addLog({
          level: "info",
          actor: user.username,
          channelName: alloc.channelName,
          message: `${demoteReason}，直接用优先级 ${DEMOTED_PRIORITY} 创建`,
        });
      }
    } catch (err) {
      if (desiredPriority === FIXED_PRIORITY && isPriorityQuotaError(err)) {
        if (cfg.onlyHighPriorityEnabled && !opts.bypassPriorityGate) {
          // 仅高优先级模式：naci 报优先级6已满（与本地计数竞态）→ **不回退到5**，回滚并留池等回收。
          await releaseClaim(batchIds);
          await deleteCreatedChannel(alloc.id);
          await releaseReservation();
          const { pending, uploaded } = await poolCounts(prefix);
          await addLog({
            level: "info",
            actor: user.username,
            channelName: alloc.channelName,
            message: `仅高优先级模式：naci 报优先级 ${FIXED_PRIORITY} 已满，本批 key 留池等待名额回收`,
          });
          return {
            created: false,
            waitingSlot: true,
            waitingMessage: `仅高优先级模式：全局高优先级已满，等待名额回收`,
            poolPending: pending,
            poolUploaded: uploaded,
            platformKeyCount: null,
            deadKeyCount: null,
          };
        }
        // 非该模式：本地计数与服务器不一致时撞「优先级6已达上限」→ 回退优先级 5
        usedPriority = DEMOTED_PRIORITY;
        created = await createChannel({
          name: alloc.channelName,
          keyText,
          models: cfg.models,
          priority: DEMOTED_PRIORITY,
        });
        await addLog({
          level: "info",
          actor: user.username,
          channelName: alloc.channelName,
          message: `优先级 ${FIXED_PRIORITY} 配额已满（服务器兜底），改用优先级 ${DEMOTED_PRIORITY} 创建`,
        });
      } else {
        throw err;
      }
    }
    channelId = created.id;
    // 回读 naci 实际赋予的优先级：naci 在优先级6配额满时可能**不报错**、静默按 5 建，
    // 若响应里带真实 priority 则以它为准落库，避免本地记「假6」（拿不到则退回 usedPriority）。
    {
      const p = Number((created as { priority?: unknown }).priority);
      if (Number.isFinite(p)) actualPriority = p;
    }
    // 建渠道即已发布并自动启用站点调度，无需再调 reenableAllSites（旧「手动打开调度」逻辑已移除）。
    // 各站远程渠道 id（publish_results）→ 落库入参（只留拿到 remote id 的站）
    publishSites = created.publishResults
      .filter((p) => p.remote_channel_id > 0)
      .map((p) => ({
        siteId: p.site_id,
        remoteChannelId: p.remote_channel_id,
        remoteChannelName: p.remote_channel_name,
      }));
  } catch (err) {
    // naci 创建失败：认领退回 pending + 删除占位行（释放序号）+ 退还本批预占额度
    await releaseClaim(batchIds);
    await deleteCreatedChannel(alloc.id);
    await releaseReservation();
    throw err;
  }

  // naci 已成功：先把 key 标记已上传（claimed→uploaded），确保后续任一步失败也不会重传本批。
  // 限速额度已在预占（reserveBucket）时扣除，此处不再计数。
  await markPoolUploaded(batchIds);

  // best-effort 回填渠道信息 + 各站远程 id：失败只记 error 不抛（渠道已建成、key 已锁定）。
  try {
    await finalizeCreatedChannel(alloc.id, {
      channelId,
      keyCount: cleanKeys.length,
      priority: actualPriority ?? usedPriority,
    });
    if (publishSites.length > 0) {
      await recordCreatedChannelSites(alloc.id, publishSites);
    }
  } catch (err) {
    await addLog({
      level: "error",
      actor: user.username,
      channelName: alloc.channelName,
      channelId,
      message: `回填渠道信息失败（渠道已建成，key 已标记上传，不影响使用）：${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }

  const uploadedKeyCount = await recordUploadedKeys(prefix, cleanKeys);

  // 回写用户 channelId=最新渠道（key 统计由实时视图 status-batch 刷新，不在建渠道时取）
  await upsertUser({
    ...user,
    channelId,
    updatedAt: new Date().toISOString(),
  });

  invalidateChannelCache(prefix);

  await addLog({
    level: "success",
    actor: user.username,
    channelName: alloc.channelName,
    channelId,
    message: `新建渠道 ${alloc.channelName} 并上传 ${cleanKeys.length} 个 key（累计 ${uploadedKeyCount}）`,
  });

  const { pending, uploaded } = await poolCounts(prefix);
  return {
    created: true,
    channelName: alloc.channelName,
    channelId,
    keyCount: cleanKeys.length,
    uploadedKeyCount,
    poolPending: pending,
    poolUploaded: uploaded,
    platformKeyCount: null,
    deadKeyCount: null,
  };
}

/**
 * 把某用户池里的 pending key 处理成新渠道：每个渠道聚合 uploadBatchSize 个 key，
 * 本次最多处理 maxKeys 个 key（=「每批处理数量」），池排空或达到 maxKeys / 硬安全阀即停。
 * 供「直接上传」与定时引擎复用，两者都传 cfg.processBatchSize 作为 maxKeys。
 */
export async function createChannelsDrain(
  user: User,
  maxKeys: number,
  opts: { viaScheduler?: boolean; forceNormalPriority?: boolean; bypassPriorityGate?: boolean } = {}
): Promise<{
  createdChannels: number;
  pushed: number;
  poolPending: number;
  poolUploaded: number;
  /** 是否因上传限速提前停止（池里还有 pending，等窗口滚动） */
  limited: boolean;
  limitedMessage?: string;
  /** 是否因「仅高优先级」无空闲名额提前停止（池里还有 pending，等回收） */
  waitingSlot: boolean;
  waitingMessage?: string;
}> {
  let createdChannels = 0;
  let pushed = 0;
  let last: CreateBatchResult | null = null;
  for (let i = 0; i < MAX_CHANNELS_PER_DRAIN; i++) {
    if (pushed >= maxKeys) break; // 本次已处理够「每批处理数量」个 key
    const r = await createChannelFromNextBatch(user, opts);
    last = r;
    if (!r.created) break; // 池空 / 被限速(limited) / 无名额(waitingSlot) 都停止本轮
    createdChannels += 1;
    pushed += r.keyCount ?? 0;
  }
  if (last) {
    return {
      createdChannels,
      pushed,
      poolPending: last.poolPending,
      poolUploaded: last.poolUploaded,
      limited: Boolean(last.limited),
      limitedMessage: last.limitedMessage,
      waitingSlot: Boolean(last.waitingSlot),
      waitingMessage: last.waitingMessage,
    };
  }
  const { pending, uploaded } = await poolCounts(user.channelName.trim());
  return {
    createdChannels,
    pushed,
    poolPending: pending,
    poolUploaded: uploaded,
    limited: false,
    waitingSlot: false,
  };
}

/** 直接上传结果（跳过定时轮，本次提交立即建渠道）。 */
export interface DirectUploadResult {
  /** 本次去重去空后新录入本地库的 key 数 */
  added: number;
  /** 本次直接推送到站点的 key 数（含此前积压的 pending） */
  pushed: number;
  /** 本次新建的渠道数 */
  createdChannels: number;
  /** 本地库中仍待上传的 key 数 */
  poolPending: number;
  /** 本地库中已上传的 key 数 */
  poolUploaded: number;
  /** 多渠道聚合无单一值，保留字段但恒为 null（前端不再依赖） */
  platformKeyCount: number | null;
  deadKeyCount: number | null;
  /** 是否因上传限速未推完（剩余 pending 等窗口滚动后由引擎续传） */
  limited?: boolean;
  limitedMessage?: string;
  /** 是否因「仅高优先级」无空闲名额未推完（剩余 pending 等回收后由引擎续建） */
  waitingSlot?: boolean;
  waitingMessage?: string;
}

/**
 * 直接上传：先把本批 key 落本地池去重，再把池里的 pending **一次性清空**——
 * 按管理员「聚合 key 数量」(uploadBatchSize) 拆分成多个渠道，尾批不足一整批也照建（少量上传）。
 * 与「提交上传」（只落池、等引擎/手动按钮）区别在于立即建完。
 * 优先级：与「上传一批」一致按配额判定——**有空闲高优先级名额就建优先级6渠道**，
 * 全局/用户配额已满或用户被禁高优先级才降到普通(优先级5)。
 * （仅高优先级模式下，直接上传同样受名额门控：无空闲名额时 key 留池、等定时任务公平分配。）
 */
export async function directUploadKeys(
  user: User,
  keys: string[]
): Promise<DirectUploadResult> {
  const prefix = user.channelName.trim();
  if (!prefix) {
    throw new Error("当前用户未配置渠道前缀，无法上传 key");
  }

  const cleanKeys = parseKeys(keys.join("\n"));
  if (cleanKeys.length === 0) {
    throw new Error("没有有效的 key");
  }

  const { added } = await addKeysToPool(prefix, cleanKeys);

  // 直接上传 = 立即传完：不设本轮 key 数上限（安全阀 MAX_CHANNELS_PER_DRAIN 兜底），
  // 每渠道按「聚合 key 数量」拆分，尾批不足一整批也照建；优先级按配额判定
  //（有空闲高优先级名额即建优先级6，否则普通优先级5）；上传限速仍生效，触发后剩余留池由引擎续传。
  // bypassPriorityGate —— 直接上传不受 onlyHighPriorityEnabled 门控，用户主动触发应直接建渠道。
  const drain = await createChannelsDrain(user, Number.MAX_SAFE_INTEGER, { bypassPriorityGate: true });

  await addLog({
    level: "info",
    actor: user.username,
    channelName: prefix,
    message: `直接上传：新录入 ${added} 个，建 ${drain.createdChannels} 个新渠道共传 ${drain.pushed} 个 key（剩余待上传 ${drain.poolPending}）${
      drain.limited ? "，已触发上传限速，剩余等窗口滚动自动续传" : ""
    }`,
  });

  return {
    added,
    pushed: drain.pushed,
    createdChannels: drain.createdChannels,
    poolPending: drain.poolPending,
    poolUploaded: drain.poolUploaded,
    platformKeyCount: null,
    deadKeyCount: null,
    limited: drain.limited,
    limitedMessage: drain.limitedMessage,
    waitingSlot: drain.waitingSlot,
    waitingMessage: drain.waitingMessage,
  };
}

// —— 已建渠道实时视图（带缓存 + 并发合并，按前缀） ——

/** 单个已建渠道的实时视图（供前端列表展示 / 站点开关）。 */
export interface CreatedChannelView {
  /** created_channels 行 id */
  id: string;
  channelId: number;
  channelName: string;
  suffix: number;
  /** 建渠道时记录的本批 key 数 */
  keyCount: number;
  /** 本系统记录的当前优先级（6=新建，5=退化后降级） */
  priority: number;
  /** 派生状态：3=自动禁用（有 key 但可用为 0），1=正常，null=无 key 信息 */
  status: number | null;
  platformKeyCount: number | null;
  deadKeyCount: number | null;
  aliveKeyCount: number | null;
  usedQuota: number;
  usedAmount: number;
  sites: SiteSchedule[];
  /** 建渠道时 naci 返回的各站远程渠道 id（本地落库，publish_results）。 */
  remoteSites: { siteId: number; remoteChannelId: number; remoteChannelName: string }[];
}

interface PrefixRealtime {
  cachedAt: number;
  channels: CreatedChannelView[];
  totalPlatformKey: number;
  totalDeadKey: number;
  totalAliveKey: number;
  totalUsedQuota: number;
  totalUsedAmount: number;
}

const CHANNEL_RT_TTL_MS = 60_000;

interface RtCacheEntry {
  at: number;
  value: PrefixRealtime;
}

function rtCache(): {
  data: Map<string, RtCacheEntry>;
  inflight: Map<string, Promise<PrefixRealtime>>;
} {
  const g = globalThis as unknown as {
    __keyloadChanRt?: {
      data: Map<string, RtCacheEntry>;
      inflight: Map<string, Promise<PrefixRealtime>>;
    };
  };
  if (!g.__keyloadChanRt) {
    g.__keyloadChanRt = { data: new Map(), inflight: new Map() };
  }
  return g.__keyloadChanRt;
}

/**
 * 组装某前缀所有已建渠道的实时视图。**不再实时打 naci**——站点/key 状态与用量都改读
 * created_channels 缓存列（status_json / used_quota，由后台任务按频率+次数上限刷新、降级/手动同步顺带刷）。
 * 一个前缀可能有成千上万个渠道，若每次翻页/轮询都对全部渠道实时拉 status-batch + used-quota，会把 naci 打爆；
 * 缓存 + 有限次数冻结（像用量那样）后，视图变成纯本地库读取。usedAmount = 缓存 used_quota / QUOTA_PER_USD。
 */
async function fetchPrefixRealtime(user: User): Promise<PrefixRealtime> {
  const prefix = user.channelName.trim();
  const created = await listCreatedChannels(prefix);
  const ids = created
    .map((c) => c.channelId)
    .filter((id): id is number => typeof id === "number");

  // 各已建渠道的每站远程 id（本地库，publish_results 落库）
  const siteMap = await createdChannelSitesByChannel(created.map((c) => c.id));

  let totalPlatformKey = 0;
  let totalDeadKey = 0;
  let totalAliveKey = 0;
  let totalUsedQuota = 0;
  let totalUsedAmount = 0;

  const channels: CreatedChannelView[] = created.map((c) => {
    // 状态取缓存快照（后台任务/降级/手动同步写入）；null=尚未刷新，展示为「无 key 信息」。
    const st = c.statusJson;
    const hasKey = !!st && st.hasKeyInfo;
    const platformKeyCount = hasKey ? st!.multiKeySize : null;
    const deadKeyCount = hasKey ? st!.deadCount : null;
    const aliveKeyCount = hasKey ? st!.aliveCount : null;
    // 用量取缓存列（后台任务刷新）；null=尚未刷新，展示为 0。
    const usedQuota = c.usedQuota ?? 0;
    const usedAmount = usedQuota / QUOTA_PER_USD;

    if (platformKeyCount != null) totalPlatformKey += platformKeyCount;
    if (deadKeyCount != null) totalDeadKey += deadKeyCount;
    if (aliveKeyCount != null) totalAliveKey += aliveKeyCount;
    totalUsedQuota += usedQuota;
    totalUsedAmount += usedAmount;

    // 派生状态：有 key 且可用为 0 → 自动禁用(3)；有 key 且可用>0 → 正常(1)；无 key 信息 → null
    let status: number | null = null;
    if (platformKeyCount != null) {
      status = platformKeyCount > 0 && aliveKeyCount === 0 ? 3 : 1;
    }

    return {
      id: c.id,
      channelId: c.channelId as number,
      channelName: c.channelName,
      suffix: c.suffix,
      keyCount: c.keyCount,
      priority: c.priority,
      status,
      platformKeyCount,
      deadKeyCount,
      aliveKeyCount,
      usedQuota,
      usedAmount,
      sites: sitesWithNames(st?.sites ?? []),
      remoteSites: siteMap.get(c.id) ?? [],
    };
  });

  // 聚合统计写回用户缓存（供管理员列表复用）——均来自缓存列（后台任务维护），直接写回。
  if (ids.length > 0) {
    await updateUserKeyStats(user.id, {
      platformKeyCount: totalPlatformKey,
      deadKeyCount: totalDeadKey,
    });
    await updateUserUsedQuota(user.id, totalUsedQuota);
  }

  return {
    cachedAt: Date.now(),
    channels,
    totalPlatformKey,
    totalDeadKey,
    totalAliveKey,
    totalUsedQuota,
    totalUsedAmount,
  };
}

/** 带缓存 + 并发合并的前缀实时视图。 */
async function getPrefixRealtimeCached(user: User): Promise<PrefixRealtime> {
  const key = user.channelName.trim();
  const empty: PrefixRealtime = {
    cachedAt: Date.now(),
    channels: [],
    totalPlatformKey: 0,
    totalDeadKey: 0,
    totalAliveKey: 0,
    totalUsedQuota: 0,
    totalUsedAmount: 0,
  };
  if (!key) return empty;

  const c = rtCache();
  const hit = c.data.get(key);
  if (hit && Date.now() - hit.at < CHANNEL_RT_TTL_MS) return hit.value;

  const existing = c.inflight.get(key);
  if (existing) return existing;

  const p = (async () => {
    try {
      const value = await fetchPrefixRealtime(user);
      c.data.set(key, { at: Date.now(), value });
      return value;
    } catch (err) {
      const stale = c.data.get(key);
      if (stale) return stale.value;
      throw err;
    } finally {
      c.inflight.delete(key);
    }
  })();
  c.inflight.set(key, p);
  return p;
}

/**
 * 全局退化降级（供**单一全局定时任务**调用，不再每个前缀/每轮各自处理）：
 * 一次性取**所有前缀**下「已过宽限期、仍高于 DEMOTED_PRIORITY(5)」的渠道，用一次 status-batch
 * 批量读站点状态；满足退化条件的用 setChannelPriority 降到 5（GET→改→PUT）并回写本地记录，
 * 腾出稀缺的优先级 6 配额。返回本轮降级的渠道数。异常自行捕获、不外抛。
 *
 * 退化判定（满足其一即降级）：
 * 1) 渠道级自动禁用：有 key 但可用为 0（naci 列表显示「自动禁用 0/N」）；
 * 2) 站点级退化：**任意一个站点**为禁用(2)/自动禁用(3)（含 AGT —— 运营要求「任一站掉即降级」）。
 */
export async function demoteAllDegradedChannels(): Promise<number> {
  const cfg = await getConfig();
  const graceMs = cfg.demoteGraceSeconds * 1000;
  const now = Date.now();
  const all = await listChannelsAbovePriority(DEMOTED_PRIORITY);
  const candidates = all.filter(
    (c) =>
      c.channelId != null &&
      now - new Date(c.createdAt).getTime() > graceMs
  );
  if (candidates.length === 0) return 0;

  const ids = candidates.map((c) => c.channelId as number);
  let statusMap: Awaited<ReturnType<typeof getChannelsStatusBatch>>;
  try {
    statusMap = await getChannelsStatusBatch(ids);
  } catch (err) {
    // 读站点状态失败（naci 常见 429 限流）→ 本轮跳过，但必须留痕，否则任务看似在跑实则一直空转
    await addLog({
      level: "warn",
      actor: "engine",
      message: `优先级任务：读取 ${ids.length} 个渠道站点状态失败，本轮跳过：${
        err instanceof Error ? err.message : String(err)
      }`,
    });
    return 0;
  }

  let demoted = 0;
  const affectedPrefixes = new Set<string>();
  for (const c of candidates) {
    const st = statusMap.get(c.channelId as number);
    if (!st) continue;
    // 顺带把刚读到的状态快照落缓存，让实时视图里的 P6 渠道保持新鲜（不额外发请求）。
    try {
      await setChannelStatusByChannelId(c.channelId as number, st);
      affectedPrefixes.add(c.prefix);
    } catch {
      // 状态缓存写入失败不影响降级主流程
    }
    const channelExhausted =
      st.hasKeyInfo && st.multiKeySize > 0 && st.aliveCount === 0;
    // 运营决策：**任意一个站点**被禁用(2)/自动禁用(3)即视为退化 → 降级。
    // 不再只看 AC/61；只要有一站掉了就腾出高优先级名额（P6 只留三站全健康的渠道）。
    const degradedSites = st.sites.filter(
      (s) => s.status === 2 || s.status === 3
    );
    const siteDegraded = degradedSites.length > 0;
    if (!channelExhausted && !siteDegraded) continue;

    try {
      // 逐渠道间隔 600ms：setChannelPriority 是 GET+PUT 两次请求，连发易触发 naci 429
      if (demoted > 0) await new Promise((r) => setTimeout(r, 600));
      await setChannelPriority(c.channelId as number, DEMOTED_PRIORITY);
      await updateCreatedChannelPriority(c.channelId as number, DEMOTED_PRIORITY);
      demoted += 1;
      affectedPrefixes.add(c.prefix);
      await addLog({
        level: "info",
        actor: "engine",
        channelName: c.prefix,
        channelId: c.channelId,
        message: `渠道 ${c.channelName} 退化（${
          siteDegraded
            ? `站点禁用 site=${degradedSites.map((s) => s.site_id).join(",")}`
            : `key 全禁 ${st.multiKeySize}/${st.multiKeySize}`
        }），优先级 ${c.priority}→${DEMOTED_PRIORITY}（腾出优先级配额）`,
      });
    } catch (err) {
      await addLog({
        level: "error",
        actor: "engine",
        channelName: c.prefix,
        channelId: c.channelId,
        message: `渠道 ${c.channelName} 降级失败：${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }
  }

  for (const p of affectedPrefixes) invalidateChannelCache(p);
  return demoted;
}

/**
 * 手动一键回退优先级：把某已建渠道在 naci 上的优先级设为 DEMOTED_PRIORITY(5)，
 * 并同步回写本地 created_channels（立即释放优先级 6 名额，不依赖定时任务的退化判定）。
 * expectedPrefix 非空时校验渠道属于该前缀（用户只能回退自己的渠道）；管理员传 null 跳过校验。
 * 返回 { channelName, from, to }；渠道不存在或不属于该前缀返回 null。naci 调用失败向上抛。
 */
export async function demoteChannelManually(
  actor: string,
  channelId: number,
  expectedPrefix: string | null
): Promise<{ channelName: string; from: number; to: number } | null> {
  const rec = await getCreatedChannelByChannelId(channelId);
  if (!rec) return null;
  if (expectedPrefix != null && rec.prefix !== expectedPrefix.trim()) return null;

  // 即使本地已记 5 也照常下发（可顺带纠正 naci/本地漂移，幂等）
  await setChannelPriority(channelId, DEMOTED_PRIORITY);
  await updateCreatedChannelPriority(channelId, DEMOTED_PRIORITY);
  invalidateChannelCache(rec.prefix);

  await addLog({
    level: "info",
    actor,
    channelName: rec.prefix,
    channelId,
    message: `手动回退渠道 ${rec.channelName} 优先级 ${rec.priority}→${DEMOTED_PRIORITY}（释放优先级配额）`,
  });
  return { channelName: rec.channelName, from: rec.priority, to: DEMOTED_PRIORITY };
}

// 注：旧的「优先级对账」任务（逐个 getChannel 读 naci 真实优先级找漂移）已移除。
// 原因：① 建渠道时已回读 naci 实际优先级落库（createChannel 响应的 priority），建时静默降级当场就抓；
//       ② 我们自己的降级会同步本地；naci 不会自行改 channel_json.priority（只自动禁用站点/key）。
// 因此逐个 GET 的对账价值已趋近于零，却随 priority6Limit 线性放大 naci 请求；直接删除。
// 残留漂移（本地6/naci5 的「假6」）交由降级任务的批量 status-batch + 建时回读兜底。

/** 刷新某用户前缀的已建渠道实时缓存（供引擎定时刷新，让管理员列表 key 统计保持新鲜）。 */
export async function refreshPrefixRealtime(user: User): Promise<void> {
  try {
    await getPrefixRealtimeCached(user);
  } catch {
    // 刷新失败忽略（保留旧缓存）
  }
}

/** 使某前缀的实时视图缓存立即失效（建渠道 / 开关站点等写操作后调用）。 */
export function invalidateChannelCache(prefix: string): void {
  const key = prefix.trim();
  if (!key) return;
  const c = rtCache();
  c.data.delete(key);
  // 同时清在途 fetch，否则并发合并会用失效前的旧结果回填缓存（M-3）。
  c.inflight.delete(key);
}

/** 单次用量刷新最多处理的渠道数（分摊到多轮，避免首轮把全部渠道一次刷完）。 */
const USAGE_REFRESH_BATCH_LIMIT = 300;
/** used-quota 单请求 id 分块大小（避免单请求过大 + 降低 naci 429）。 */
const USAGE_QUOTA_CHUNK = 40;
/** 分块之间的节流（ms）。 */
const USAGE_CHUNK_DELAY_MS = 300;

/**
 * 后台用量+状态刷新任务：挑「刷新次数 < usageMaxUpdates」的已建渠道，分块**同时**批量拉 used-quota
 * 与 status-batch，写回 created_channels.used_quota / status_json 缓存并计数 +1；某渠道刷够上限即冻结、
 * 不再拉，避免雪崩。实时视图直接读这两份缓存，不再自己打 naci。
 * 刷新后重算受影响前缀的用户用量聚合缓存（users.used_quota = 该前缀各渠道缓存 used_quota 之和）。
 * 返回本轮成功刷新的渠道数。异常自行捕获、不外抛。
 */
export async function refreshChannelUsage(): Promise<number> {
  const cfg = await getConfig();
  if (cfg.usageMaxUpdates <= 0) return 0; // 0=关闭用量刷新
  const targets = await listChannelsNeedingUsageRefresh(
    cfg.usageMaxUpdates,
    USAGE_REFRESH_BATCH_LIMIT
  );
  if (targets.length === 0) return 0;

  const idToPrefix = new Map<number, string>();
  for (const c of targets) idToPrefix.set(c.channelId as number, c.prefix);
  const ids = targets.map((c) => c.channelId as number);
  const affectedPrefixes = new Set<string>();
  let updated = 0;

  for (let i = 0; i < ids.length; i += USAGE_QUOTA_CHUNK) {
    const chunk = ids.slice(i, i + USAGE_QUOTA_CHUNK);
    let usageMap: Awaited<ReturnType<typeof getChannelsUsedQuota>>;
    try {
      usageMap = await getChannelsUsedQuota(chunk);
    } catch (err) {
      // 本块失败（常见 naci 429）→ 保留旧值、不计数，下轮再试。
      await addLog({
        level: "warn",
        actor: "engine",
        message: `用量刷新：读取 ${chunk.length} 个渠道 used-quota 失败，本块跳过：${
          err instanceof Error ? err.message : String(err)
        }`,
      });
      continue;
    }
    // 同块顺带拉状态快照（best-effort）：失败不影响用量落库，状态保留旧快照（传 undefined 不覆盖）。
    let statusMap: Awaited<ReturnType<typeof getChannelsStatusBatch>> = new Map();
    try {
      statusMap = await getChannelsStatusBatch(chunk);
    } catch {
      statusMap = new Map();
    }
    for (const id of chunk) {
      const us = usageMap.get(id);
      if (!us) continue; // 读不到该渠道 → 不写、不计数，下轮再试
      await recordChannelUsage(id, us.usedQuota, statusMap.get(id));
      const p = idToPrefix.get(id);
      if (p) affectedPrefixes.add(p);
      updated += 1;
    }
    if (i + USAGE_QUOTA_CHUNK < ids.length) {
      await new Promise((r) => setTimeout(r, USAGE_CHUNK_DELAY_MS));
    }
  }

  // 重算受影响前缀的用户用量聚合缓存，并失效实时视图缓存。
  for (const p of affectedPrefixes) {
    try {
      const u = await findUserByChannelName(p);
      if (u) {
        const sum = await sumChannelUsedQuotaByPrefix(p);
        await updateUserUsedQuota(u.id, sum);
      }
      invalidateChannelCache(p);
    } catch {
      // 单前缀聚合失败不影响整体
    }
  }
  return updated;
}

/** 手动同步用量的最小间隔（ms）：防止用户狂点把 naci 打爆。 */
const MANUAL_USAGE_SYNC_COOLDOWN_MS = 8_000;
/** 前缀 → 上次手动同步时间戳(ms)，进程内冷却。 */
function manualUsageSyncStore(): Map<string, number> {
  const g = globalThis as unknown as { __keyloadUsageSync?: Map<string, number> };
  if (!g.__keyloadUsageSync) g.__keyloadUsageSync = new Map();
  return g.__keyloadUsageSync;
}

export interface SyncUsageResult {
  channelCount: number; // 成功刷新的渠道数
  totalUsedQuota: number;
  totalUsedAmount: number;
}

/**
 * 用户手动同步：**立即**对某前缀所有已建渠道实时拉一次 used-quota、写回缓存并重算聚合。
 * 不受后台「自动最多刷 N 次」上限约束（不消耗计数）。带进程内冷却，避免狂点打爆 naci。
 * 无已建渠道返回全 0；冷却期内抛出友好错误。
 */
export async function syncPrefixUsage(user: User): Promise<SyncUsageResult> {
  const prefix = user.channelName.trim();
  if (!prefix) return { channelCount: 0, totalUsedQuota: 0, totalUsedAmount: 0 };

  const store = manualUsageSyncStore();
  const last = store.get(prefix) ?? 0;
  const now = Date.now();
  if (now - last < MANUAL_USAGE_SYNC_COOLDOWN_MS) {
    throw new Error("同步过于频繁，请稍候几秒再试");
  }
  store.set(prefix, now);

  const created = await listCreatedChannels(prefix);
  const ids = created
    .map((c) => c.channelId)
    .filter((id): id is number => typeof id === "number");
  if (ids.length === 0) {
    return { channelCount: 0, totalUsedQuota: 0, totalUsedAmount: 0 };
  }

  let channelCount = 0;
  for (let i = 0; i < ids.length; i += USAGE_QUOTA_CHUNK) {
    const chunk = ids.slice(i, i + USAGE_QUOTA_CHUNK);
    const usageMap = await getChannelsUsedQuota(chunk); // 手动触发：失败直接抛给调用方提示
    // 顺带实时刷状态快照（best-effort，不因状态读失败而中断用量同步）
    let statusMap: Awaited<ReturnType<typeof getChannelsStatusBatch>> = new Map();
    try {
      statusMap = await getChannelsStatusBatch(chunk);
    } catch {
      statusMap = new Map();
    }
    for (const id of chunk) {
      const us = usageMap.get(id);
      if (!us) continue;
      await setChannelUsage(id, us.usedQuota, statusMap.get(id));
      channelCount += 1;
    }
    if (i + USAGE_QUOTA_CHUNK < ids.length) {
      await new Promise((r) => setTimeout(r, USAGE_CHUNK_DELAY_MS));
    }
  }

  const totalUsedQuota = await sumChannelUsedQuotaByPrefix(prefix);
  await updateUserUsedQuota(user.id, totalUsedQuota);
  invalidateChannelCache(prefix);
  return {
    channelCount,
    totalUsedQuota,
    totalUsedAmount: totalUsedQuota / QUOTA_PER_USD,
  };
}

/**
 * 供 GET /api/my/channel 用：返回前缀的本地池进度 + 引擎调度 + 已建渠道列表与聚合统计。
 */
export async function resolveMyChannel(user: User) {
  const cfg = await getConfig();
  const uploadBatchSize = cfg.uploadBatchSize;
  const autoRefillEnabled = cfg.autoRefillEnabled;

  const prefix = user.channelName.trim();
  const { nextCheckAt, checking, lastCheck } = engineViewState(prefix);

  // 该用户生效的上传限速状态（个人覆盖 ?? 全局默认；随轮询定时刷新）
  const eff = effectiveUserLimit(user, cfg);
  const uUsage = await peekBucket(userScope(user.id), eff.limit, eff.windowMinutes);
  const uploadLimit = {
    used: uUsage.used,
    limit: uUsage.limit,
    windowMinutes: uUsage.windowMinutes,
    unlimited: uUsage.unlimited,
    isOverride: eff.isOverride,
  };
  // 是否允许手动上传（全局开关；管理员不受限，普通用户看全局配置）
  const manualUploadEnabled =
    user.role === "admin" ? true : cfg.userManualUploadEnabled;
  // 高优先级(优先级6)配额：全局已用/上限（跨所有用户）+ 本用户已用/独立上限
  const hpGlobalUsed = await countChannelsAtPriority(FIXED_PRIORITY);
  const hpGlobalLimit = cfg.priority6Limit;

  if (!prefix) {
    return {
      exists: false as const,
      prefix: "",
      channelName: "",
      createdCount: 0,
      channels: [] as CreatedChannelView[],
      uploadedKeyCount: 0,
      poolPending: 0,
      poolUploaded: 0,
      uploadBatchSize,
      autoRefillEnabled,
      uploadLimit,
      manualUploadEnabled,
      onlyHighPriority: cfg.onlyHighPriorityEnabled,
      highPriority: {
        allowed: user.allowHighPriority !== false,
        limit: user.highPriorityLimit ?? null,
        used: 0,
        globalUsed: hpGlobalUsed,
        globalLimit: hpGlobalLimit,
      },
      nextCheckAt,
      checking,
      lastCheck,
      cachedAt: null as string | null,
      cacheTtlMs: CHANNEL_RT_TTL_MS,
    };
  }

  const uploadedKeyCount = await getUploadedKeyCount(prefix);
  const { pending: poolPending, uploaded: poolUploaded } =
    await poolCounts(prefix);
  const rt = await getPrefixRealtimeCached(user);
  // 该用户已建的优先级6渠道数（供「高优先级 已用/上限」展示）
  const highPriorityUsed = await countChannelsAtPriorityForPrefix(
    prefix,
    FIXED_PRIORITY
  );

  return {
    exists: rt.channels.length > 0,
    prefix,
    channelName: prefix,
    createdCount: rt.channels.length,
    channels: rt.channels,
    uploadedKeyCount,
    poolPending,
    poolUploaded,
    uploadBatchSize,
    autoRefillEnabled,
    uploadLimit,
    manualUploadEnabled,
    onlyHighPriority: cfg.onlyHighPriorityEnabled,
    highPriority: {
      allowed: user.allowHighPriority !== false,
      limit: user.highPriorityLimit ?? null,
      used: highPriorityUsed,
      globalUsed: hpGlobalUsed,
      globalLimit: hpGlobalLimit,
    },
    nextCheckAt,
    checking,
    lastCheck,
    cachedAt: new Date(rt.cachedAt).toISOString(),
    cacheTtlMs: CHANNEL_RT_TTL_MS,
    // 聚合，供上传进度卡「可用/平台 Key」与金额展示
    platformKeyCount: rt.totalPlatformKey,
    deadKeyCount: rt.totalDeadKey,
    aliveKeyCount: rt.totalAliveKey,
    usedQuota: rt.totalUsedQuota,
    usedAmount: rt.totalUsedAmount,
  };
}

/**
 * 手动设置某个**已建渠道**某站点的调度状态（供 POST /api/my/site-status）：
 * 校验 channelId 属于调用者前缀 → setSiteStatus 透传 → 失效缓存 → 记日志 →
 * 重新只读该渠道站点状态返回。channelId 不属于该前缀返回 null。
 */
export async function setMySiteStatus(
  user: User,
  channelId: number,
  siteId: number,
  status: number
): Promise<SiteSchedule[] | null> {
  const prefix = user.channelName.trim();
  if (!prefix) return null;

  const ids = await createdChannelIds(prefix);
  if (!ids.includes(channelId)) return null;

  await setSiteStatus(channelId, siteId, status);
  invalidateChannelCache(prefix);

  const siteName =
    PUBLISH_SITES.find((s) => s.site_id === siteId)?.site_name ?? String(siteId);
  await addLog({
    level: "info",
    actor: user.username,
    channelName: prefix,
    channelId,
    message: `手动设置渠道 #${channelId} 站点 ${siteName}(${siteId}) 调度状态为 ${status}`,
  });

  const siteStatuses = await getChannelSites(channelId);
  return sitesWithNames(siteStatuses);
}
