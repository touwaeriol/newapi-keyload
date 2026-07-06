// 核心业务：本地 key 池 + 批量上传到 naci 渠道（创建或追加）。
//
// Phase 2 模型：上传入口只把 key 落本地池（enqueueKeys），由定时引擎
// （lib/engine.ts）每分钟取一批调 pushBatchToChannel 上传到 naci；每批上传后
// 启用全部三站（reenableAllSites, all_sites:true）保调度，直到池排空。
import {
  createChannel,
  findChannelByName,
  getChannel,
  reenableAllSites,
  updateChannel,
} from "./naci";
import { parseKeys } from "./supplier";
import {
  addKeysToPool,
  addLog,
  findUserByChannelName,
  getUploadedKeyCount,
  poolCounts,
  recordUploadedKeys,
  updateUserKeyStats,
  upsertUser,
} from "./store";
import type { EnqueueResult, KeyStats, NaciChannel, User } from "./types";

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

  // 每批上传后启用全部三站（all_sites:true,status:1）保调度，并取真实 key 统计
  let keyStats: KeyStats | null = null;
  try {
    keyStats = await reenableAllSites(channelId);
  } catch (err) {
    await addLog({
      level: "warn",
      actor: user?.username ?? "engine",
      channelName: name,
      channelId,
      message: `重开站点失败：${err instanceof Error ? err.message : String(err)}`,
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

/** 供 GET /api/my/channel 用：解析并返回渠道详情 + 本地池进度，不写 key。 */
export async function resolveMyChannel(user: User) {
  const channelName = user.channelName.trim();
  if (!channelName) {
    return {
      exists: false as const,
      channelName: "",
      uploadedKeyCount: 0,
      poolPending: 0,
      poolUploaded: 0,
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
    };
  }

  // 平台真实 key 统计：读上传时落库的缓存，GET 不触发有副作用的重开/额外拉取
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
    platformKeyCount: user.platformKeyCount ?? undefined,
    deadKeyCount: user.deadKeyCount ?? undefined,
  };
}
