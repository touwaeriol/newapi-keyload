// 核心业务：本地 key 池 + 批量上传到 naci 渠道（创建或追加）。
//
// Phase 2 模型：上传入口只把 key 落本地池（enqueueKeys），由定时引擎
// （lib/engine.ts）每分钟取一批调 pushBatchToChannel 上传到 naci；每批上传后
// 一次性打开全部三站（reenableAllSites，单次 {all_sites:true,status:1} + 外层重试）保调度，
// 直到池排空。
import {
  createChannel,
  findChannelByName,
  getChannel,
  getChannelKeyStatus,
  getChannelSites,
  getChannelStatusFull,
  reenableAllSites,
  setSiteStatus,
  updateChannel,
} from "./naci";
import { parseKeys, SITES } from "./supplier";
import {
  addKeysToPool,
  addLog,
  findUserByChannelName,
  getConfig,
  getUploadedKeyCount,
  poolCounts,
  recordUploadedKeys,
  updateUserKeyStats,
  upsertUser,
} from "./store";
import type { EnqueueResult, KeyStats, NaciChannel, User } from "./types";

/** 单渠道最近一次检查结果（前端展示用）。 */
export interface LastCheckView {
  at: string; // ISO
  status: string;
  message: string;
}

/**
 * 读定时引擎调度状态（从 globalThis 读，避免与 engine.ts 循环依赖）：
 * 下一次检查时间、当前是否正在检查，以及该渠道最近一次检查的结果/执行说明。
 */
function engineViewState(channelName?: string): {
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
  const r = channelName ? e?.lastResults?.[channelName.trim()] : undefined;
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
 * 以固定三站（supplier.SITES）为基准，套上平台返回的每站 status 生成展示用列表：
 * 平台返回了该站 → 用其 status；平台没返回（或渠道未创建，传 []）→ status=null。
 */
function sitesWithNames(
  statuses: { site_id: number; status: number }[]
): SiteSchedule[] {
  const statusMap = new Map(statuses.map((s) => [s.site_id, s.status]));
  return SITES.map((s) => ({
    site_id: s.site_id,
    site_name: s.site_name,
    status: statusMap.has(s.site_id) ? statusMap.get(s.site_id)! : null,
  }));
}

/**
 * 按渠道名解析 naci 渠道：
 * 1. 若有缓存 channelId → getChannel 校验存在且名称一致；异常/不一致视为未解析。
 * 2. 未解析 → findChannelByName 按名称扫描。
 * 返回命中的渠道详情（含 id）或 null。
 */
async function resolveChannelByName(
  name: string,
  cachedId?: number | null
): Promise<NaciChannel | null> {
  const target = name.trim();
  if (!target) return null;

  if (cachedId != null) {
    try {
      const detail = await getChannel(cachedId);
      if (detail && detail.name === target) return detail;
    } catch {
      // 缓存 id 失效，回退到按名称查找
    }
  }

  return findChannelByName(target);
}

/** 上传入口：只把 key 落本地池，不直接调 naci（由定时引擎逐批上传）。 */
export async function enqueueKeys(
  user: User,
  keys: string[]
): Promise<EnqueueResult> {
  const channelName = user.channelName.trim();
  if (!channelName) {
    throw new Error("当前用户未绑定渠道名称，无法上传 key");
  }

  const cleanKeys = parseKeys(keys.join("\n"));
  if (cleanKeys.length === 0) {
    throw new Error("没有有效的 key");
  }

  const { added, pending, uploaded } = await addKeysToPool(
    channelName,
    cleanKeys
  );

  await addLog({
    level: "info",
    actor: user.username,
    channelName,
    message: `入队 ${added} 个新 key（待上传 ${pending}，已上传 ${uploaded}）`,
  });

  return { added, poolPending: pending, poolUploaded: uploaded };
}

/** 批量推送结果（供引擎/手动触发使用）。 */
export interface BatchPushResult {
  action: "created" | "updated";
  channelId: number;
  platformKeyCount?: number;
  deadKeyCount?: number;
}

/**
 * 把一批 key 追加到指定渠道（核心上传逻辑，供定时引擎调用）：
 * 解析渠道（缺则创建聚合渠道 / 有则追加）→ 重开全部三站取真实 key 统计 →
 * 回写渠道 id 与统计缓存到绑定用户 → 记录累计去重数 → 记日志。
 */
export async function pushBatchToChannel(
  channelName: string,
  keys: string[]
): Promise<BatchPushResult> {
  const name = channelName.trim();
  if (!name) throw new Error("渠道名称为空，无法上传");

  const cleanKeys = parseKeys(keys.join("\n"));
  if (cleanKeys.length === 0) throw new Error("没有有效的 key");
  const keyText = cleanKeys.join("\n");

  // 绑定该渠道的用户：用于复用 channelId 缓存 + 回写统计（渠道名全局唯一）
  const user = await findUserByChannelName(name);

  const existing = await resolveChannelByName(name, user?.channelId);

  let channelId: number;
  let action: BatchPushResult["action"];
  if (existing) {
    await updateChannel({ id: existing.id, name, keyText });
    channelId = existing.id;
    action = "updated";
  } else {
    const created = await createChannel({ name, keyText });
    channelId = created.id;
    action = "created";
  }

  // 每批上传后一次性打开全部三站调度并取真实 key 统计。
  // reenableAllSites 单次 {all_sites:true,status:1} 调用带外层 3 次重试、失败记 error 且不抛，
  // 故此处直接调用；保留 try/catch 仅作防御（理论上不抛），确保引擎不 crash。
  let keyStats: KeyStats | null = null;
  try {
    keyStats = await reenableAllSites(channelId);
  } catch (err) {
    await addLog({
      level: "error",
      actor: user?.username ?? "engine",
      channelName: name,
      channelId,
      message: `打开站点调度异常：${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // 回写 channelId 与 key 统计缓存到绑定用户
  if (user) {
    if (user.channelId !== channelId) {
      await upsertUser({
        ...user,
        channelId,
        updatedAt: new Date().toISOString(),
      });
    }
    if (keyStats) {
      await updateUserKeyStats(user.id, {
        platformKeyCount: keyStats.platformKeyCount,
        deadKeyCount: keyStats.deadKeyCount,
      });
    }
  }

  // 记录累计去重 key 数（naci 不返回 key 数量，本系统自行统计）
  const uploadedKeyCount = await recordUploadedKeys(name, cleanKeys);

  await addLog({
    level: "success",
    actor: user?.username ?? "engine",
    channelName: name,
    channelId,
    message: `${action === "created" ? "创建渠道并上传" : "向渠道追加"} ${cleanKeys.length} 个 key（累计 ${uploadedKeyCount}${
      keyStats ? `，平台 ${keyStats.platformKeyCount} 个/禁用 ${keyStats.deadKeyCount}` : ""
    }）`,
  });

  return {
    action,
    channelId,
    platformKeyCount: keyStats?.platformKeyCount,
    deadKeyCount: keyStats?.deadKeyCount,
  };
}

/** 补给判定结果（供定时引擎「按需补给」用）。 */
export interface RefillDecision {
  /** 是否需要本轮补一批 key。 */
  needsKeys: boolean;
  /**
   * missing   —— 渠道尚不存在，需创建首批；
   * exhausted —— 渠道存在、启用，但存活 key=0（自动禁用态），需补一批；
   * alive     —— 渠道存在且仍有存活 key，key 留在池里；
   * manual    —— 渠道被手动禁用（channel.status===2），不补，key 留在池里；
   * unreadable—— 只读检测失败（naci 读异常/空），本轮跳过下轮重试。
   */
  status: "missing" | "exhausted" | "alive" | "manual" | "unreadable";
  /** 已解析的渠道 id（渠道存在时），否则 null。 */
  channelId: number | null;
  /** 平台真实 key 数（multi_key_size）；渠道不存在/读失败时为 null。 */
  platformKeyCount: number | null;
  /** 被禁用（status=3）的 key 数；渠道不存在/读失败时为 null。 */
  deadKeyCount: number | null;
  /** 存活可用 key 数（platform-dead）；渠道不存在/读失败时为 null。 */
  aliveKeyCount: number | null;
}

/**
 * 判定某渠道是否需要补给（只读，不写 naci key）：
 * 1. 解析渠道（复用绑定用户的 channelId 缓存）；不存在 → missing（needsKeys）；回写 channelId。
 * 2. getChannelKeyStatus 只读检测（对所有已存在渠道都读，含手动禁用的）：
 *    - 读失败（null）→ unreadable（本轮跳过，保留旧缓存）。
 * 3. 用读到的**真实** multiKeySize/deadCount 刷新用户表缓存
 *    （platformKeyCount=multiKeySize、deadKeyCount=deadCount，无需 reenable），
 *    保证「不补的那些轮」（含池已排空 / 手动禁用）前端也能看到真实「可用=platform-dead」（如 0/280）。
 * 4. 判定（缓存已刷新后）：
 *    - 手动禁用（channel.status===2）→ manual（不补；人工干预不覆盖）。
 *    - aliveCount===0 → exhausted（needsKeys，即「启用但 0 可用」的自动禁用态）。
 *    - 否则 alive（无需补）。
 */
export async function assessRefillNeed(
  channelName: string
): Promise<RefillDecision> {
  const noStats = {
    platformKeyCount: null,
    deadKeyCount: null,
    aliveKeyCount: null,
  };

  const name = channelName.trim();
  if (!name)
    return { needsKeys: false, status: "unreadable", channelId: null, ...noStats };

  const user = await findUserByChannelName(name);
  const existing = await resolveChannelByName(name, user?.channelId);

  if (!existing) {
    return { needsKeys: true, status: "missing", channelId: null, ...noStats };
  }

  // 回写 channelId 缓存（渠道已解析到 id）
  if (user && user.channelId !== existing.id) {
    await upsertUser({
      ...user,
      channelId: existing.id,
      updatedAt: new Date().toISOString(),
    });
  }

  // 先只读检测真实 key 统计（对所有已存在渠道都读，含手动禁用的，保证缓存新鲜）。
  const stat = await getChannelKeyStatus(existing.id);
  if (!stat) {
    return {
      needsKeys: false,
      status: "unreadable",
      channelId: existing.id,
      ...noStats,
    };
  }

  // 用只读检测读到的真实统计刷新缓存（补与不补、含手动禁用的轮次都刷新，让前端始终显示真实可用数）
  if (user) {
    await updateUserKeyStats(user.id, {
      platformKeyCount: stat.multiKeySize,
      deadKeyCount: stat.deadCount,
    });
  }

  const stats = {
    platformKeyCount: stat.multiKeySize,
    deadKeyCount: stat.deadCount,
    aliveKeyCount: stat.aliveCount,
  };

  // 手动禁用（status===2）：人工干预，缓存已刷新但不自动补 key。
  // 注：keys 全 status=3 时渠道 status 仍为 1（启用），那是「自动禁用」态，需补。
  if (typeof existing.status === "number" && existing.status === 2) {
    return { needsKeys: false, status: "manual", channelId: existing.id, ...stats };
  }

  if (stat.aliveCount === 0) {
    return { needsKeys: true, status: "exhausted", channelId: existing.id, ...stats };
  }
  return { needsKeys: false, status: "alive", channelId: existing.id, ...stats };
}

/** 供 GET /api/my/channel 用：解析并返回渠道详情 + 本地池进度，不写 key。 */
export async function resolveMyChannel(user: User) {
  const cfg = await getConfig();
  const uploadBatchSize = cfg.uploadBatchSize;
  const autoRefillEnabled = cfg.autoRefillEnabled;

  const channelName = user.channelName.trim();
  const { nextCheckAt, checking, lastCheck } = engineViewState(channelName);

  if (!channelName) {
    return {
      exists: false as const,
      channelName: "",
      uploadedKeyCount: 0,
      poolPending: 0,
      poolUploaded: 0,
      uploadBatchSize,
      autoRefillEnabled,
      nextCheckAt,
      checking,
      lastCheck,
      sites: sitesWithNames([]),
    };
  }

  const uploadedKeyCount = await getUploadedKeyCount(channelName);
  const { pending: poolPending, uploaded: poolUploaded } =
    await poolCounts(channelName);
  const detail = await resolveChannelByName(channelName, user.channelId);

  // 顺带把解析结果缓存回用户，保持 channelId 与平台一致
  const resolvedId = detail ? detail.id : null;
  if (user.channelId !== resolvedId) {
    await upsertUser({
      ...user,
      channelId: resolvedId,
      updatedAt: new Date().toISOString(),
    });
  }

  if (!detail) {
    return {
      exists: false as const,
      channelName,
      uploadedKeyCount,
      poolPending,
      poolUploaded,
      uploadBatchSize,
      autoRefillEnabled,
      nextCheckAt,
      checking,
      lastCheck,
      sites: sitesWithNames([]),
    };
  }

  // 一次 status-batch 只读同时拿「每站调度状态」+「真实 key 统计」（避免读两次）。
  // 注：这给 GET /api/my/channel 增加一次 status-batch 调用（可接受）。读失败退回缓存、不 crash。
  let realtime: Awaited<ReturnType<typeof getChannelStatusFull>> = null;
  try {
    realtime = await getChannelStatusFull(detail.id);
  } catch {
    realtime = null;
  }

  // 平台真实 key 统计：优先用实时 status-batch 读到的值（覆盖旧缓存）并写回缓存；
  // 读失败 / 无 key 信息时退回 user 缓存。这样即使池已排空，「可用=platform-dead」也保持真实（全死=0）。
  let platformKeyCount = user.platformKeyCount ?? undefined;
  let deadKeyCount = user.deadKeyCount ?? undefined;
  if (realtime && realtime.hasKeyInfo) {
    platformKeyCount = realtime.multiKeySize;
    deadKeyCount = realtime.deadCount;
    await updateUserKeyStats(user.id, {
      platformKeyCount: realtime.multiKeySize,
      deadKeyCount: realtime.deadCount,
    });
  }

  return {
    exists: true as const,
    channelName,
    channelId: detail.id,
    status: detail.status as number | undefined,
    type: detail.type,
    models: detail.models,
    priority: detail.priority,
    group: detail.group,
    usedQuota: detail.used_quota,
    usedAmount: detail.used_amount,
    siteAmounts: detail.site_amounts,
    uploadedKeyCount,
    poolPending,
    poolUploaded,
    uploadBatchSize,
    autoRefillEnabled,
    nextCheckAt,
    checking,
    lastCheck,
    platformKeyCount,
    deadKeyCount,
    sites: sitesWithNames(realtime?.sites ?? []),
  };
}

/**
 * 手动设置调用者绑定渠道某站点的调度状态（供 POST /api/my/site-status）：
 * 解析调用者自己的渠道（复用 channelId 缓存）→ 渠道未创建返回 null（路由转 fail 文案）→
 * setSiteStatus(channelId, siteId, status) 透传 status → 记 info 日志 →
 * 重新只读 getChannelSites 返回更新后的三站状态。
 * siteId / status 的合法性由路由校验（siteId∈SITES、status∈{0,1,2,3}）。
 */
export async function setMySiteStatus(
  user: User,
  siteId: number,
  status: number
): Promise<SiteSchedule[] | null> {
  const name = user.channelName.trim();
  if (!name) return null;

  const detail = await resolveChannelByName(name, user.channelId);
  if (!detail) return null;

  // 顺带回写 channelId 缓存
  if (user.channelId !== detail.id) {
    await upsertUser({
      ...user,
      channelId: detail.id,
      updatedAt: new Date().toISOString(),
    });
  }

  await setSiteStatus(detail.id, siteId, status);

  const siteName =
    SITES.find((s) => s.site_id === siteId)?.site_name ?? String(siteId);
  await addLog({
    level: "info",
    actor: user.username,
    channelName: name,
    channelId: detail.id,
    message: `手动设置站点 ${siteName}(${siteId}) 调度状态为 ${status}`,
  });

  const siteStatuses = await getChannelSites(detail.id);
  return sitesWithNames(siteStatuses);
}
