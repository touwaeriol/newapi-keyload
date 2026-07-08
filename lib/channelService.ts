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
  setSiteStatus,
} from "./naci";
import { parseKeys, PUBLISH_SITES } from "./supplier";
import {
  addKeysToPool,
  addLog,
  allocateCreatedChannel,
  claimPendingBatch,
  createdChannelIds,
  createdChannelSitesByChannel,
  deleteCreatedChannel,
  finalizeCreatedChannel,
  getConfig,
  getUploadedKeyCount,
  listCreatedChannels,
  markPoolUploaded,
  poolCounts,
  recordCreatedChannelSites,
  recordUploadedKeys,
  releaseClaim,
  updateUserKeyStats,
  updateUserUsedQuota,
  upsertUser,
  type CreatedChannelSite,
} from "./store";
import type { User } from "./types";

/** 单次「逐批建渠道」的渠道数硬上限（安全阀，防极端 paste 打爆 naci）。实际处理量由 maxKeys 控制。 */
export const MAX_CHANNELS_PER_DRAIN = 500;

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
  poolPending: number;
  poolUploaded: number;
  platformKeyCount: number | null;
  deadKeyCount: number | null;
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
  user: User
): Promise<CreateBatchResult> {
  const prefix = user.channelName.trim();
  if (!prefix) throw new Error("当前用户未配置渠道前缀，无法上传 key");

  const cfg = await getConfig();
  // 原子认领：并发（双击 / 双标签页 / kick 撞手动 / admin+user）各自拿到不相交批次
  const batch = await claimPendingBatch(prefix, cfg.uploadBatchSize);
  if (batch.length === 0) {
    const { pending, uploaded } = await poolCounts(prefix);
    return {
      created: false,
      poolPending: pending,
      poolUploaded: uploaded,
      platformKeyCount: null,
      deadKeyCount: null,
    };
  }
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
    throw err;
  }

  let channelId: number;
  let publishSites: CreatedChannelSite[] = [];
  try {
    const created = await createChannel({ name: alloc.channelName, keyText });
    channelId = created.id;
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
    // naci 创建失败：认领退回 pending + 删除占位行（释放序号，下次可复用）
    await releaseClaim(batchIds);
    await deleteCreatedChannel(alloc.id);
    throw err;
  }

  // naci 已成功：先把 key 标记已上传（claimed→uploaded），确保后续任一步失败也不会重传本批。
  await markPoolUploaded(batchIds);

  // best-effort 回填渠道信息 + 各站远程 id：失败只记 error 不抛（渠道已建成、key 已锁定）。
  try {
    await finalizeCreatedChannel(alloc.id, {
      channelId,
      keyCount: cleanKeys.length,
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
  maxKeys: number
): Promise<{
  createdChannels: number;
  pushed: number;
  poolPending: number;
  poolUploaded: number;
}> {
  let createdChannels = 0;
  let pushed = 0;
  let last: CreateBatchResult | null = null;
  for (let i = 0; i < MAX_CHANNELS_PER_DRAIN; i++) {
    if (pushed >= maxKeys) break; // 本次已处理够「每批处理数量」个 key
    const r = await createChannelFromNextBatch(user);
    last = r;
    if (!r.created) break;
    createdChannels += 1;
    pushed += r.keyCount ?? 0;
  }
  if (last) {
    return {
      createdChannels,
      pushed,
      poolPending: last.poolPending,
      poolUploaded: last.poolUploaded,
    };
  }
  const { pending, uploaded } = await poolCounts(user.channelName.trim());
  return { createdChannels, pushed, poolPending: pending, poolUploaded: uploaded };
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
}

/**
 * 直接上传：先把本批 key 落本地池去重，再把池里的 pending 逐批建成新渠道（一次性清空）。
 * 与「提交上传」（只落池、等引擎/手动按钮）区别在于立即建渠道。
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
  const cfg = await getConfig();
  const drain = await createChannelsDrain(user, cfg.processBatchSize);

  await addLog({
    level: "info",
    actor: user.username,
    channelName: prefix,
    message: `直接上传：新录入 ${added} 个，建 ${drain.createdChannels} 个新渠道共传 ${drain.pushed} 个 key（剩余待上传 ${drain.poolPending}）`,
  });

  return {
    added,
    pushed: drain.pushed,
    createdChannels: drain.createdChannels,
    poolPending: drain.poolPending,
    poolUploaded: drain.poolUploaded,
    platformKeyCount: null,
    deadKeyCount: null,
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

const CHANNEL_RT_TTL_MS = 30_000;

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

/** 真实拉取某前缀所有已建渠道的实时视图（一次 status-batch + 一次 used-quota 批量取）。 */
async function fetchPrefixRealtime(user: User): Promise<PrefixRealtime> {
  const prefix = user.channelName.trim();
  const created = await listCreatedChannels(prefix);
  const ids = created
    .map((c) => c.channelId)
    .filter((id): id is number => typeof id === "number");

  let statusMap: Awaited<ReturnType<typeof getChannelsStatusBatch>> = new Map();
  let usageMap: Awaited<ReturnType<typeof getChannelsUsedQuota>> = new Map();
  // 分别记录两路是否**真正成功**：失败(catch)返回空 map，但不得据此把已缓存统计清零(M-1)。
  let statusOk = false;
  let usageOk = false;
  // 各已建渠道的每站远程 id（本地库，publish_results 落库）
  const siteMap = await createdChannelSitesByChannel(created.map((c) => c.id));
  if (ids.length > 0) {
    const [s, u] = await Promise.all([
      getChannelsStatusBatch(ids)
        .then((m) => {
          statusOk = true;
          return m;
        })
        .catch(() => new Map()),
      getChannelsUsedQuota(ids)
        .then((m) => {
          usageOk = true;
          return m;
        })
        .catch(() => new Map()),
    ]);
    statusMap = s;
    usageMap = u;
  }

  let totalPlatformKey = 0;
  let totalDeadKey = 0;
  let totalAliveKey = 0;
  let totalUsedQuota = 0;
  let totalUsedAmount = 0;

  const channels: CreatedChannelView[] = created.map((c) => {
    const st = c.channelId != null ? statusMap.get(c.channelId) : undefined;
    const us = c.channelId != null ? usageMap.get(c.channelId) : undefined;

    const hasKey = !!st && st.hasKeyInfo;
    const platformKeyCount = hasKey ? st!.multiKeySize : null;
    const deadKeyCount = hasKey ? st!.deadCount : null;
    const aliveKeyCount = hasKey ? st!.aliveCount : null;
    const usedQuota = us?.usedQuota ?? 0;
    const usedAmount = us?.usedAmount ?? 0;

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

  // 聚合统计写回用户缓存（供管理员列表复用）——仅在对应拉取**真正成功**时写，
  // 失败(catch 空 map) 保留旧缓存值，避免瞬时故障把正常统计清成 0（M-1）。
  if (ids.length > 0 && statusOk) {
    await updateUserKeyStats(user.id, {
      platformKeyCount: totalPlatformKey,
      deadKeyCount: totalDeadKey,
    });
  }
  if (ids.length > 0 && usageOk) {
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

/**
 * 供 GET /api/my/channel 用：返回前缀的本地池进度 + 引擎调度 + 已建渠道列表与聚合统计。
 */
export async function resolveMyChannel(user: User) {
  const cfg = await getConfig();
  const uploadBatchSize = cfg.uploadBatchSize;
  const autoRefillEnabled = cfg.autoRefillEnabled;

  const prefix = user.channelName.trim();
  const { nextCheckAt, checking, lastCheck } = engineViewState(prefix);

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
