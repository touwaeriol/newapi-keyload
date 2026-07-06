// 核心业务：把 key 上传到用户绑定的 naci 渠道（创建或追加）。
// 逻辑严格按 docs/DESIGN.md 第 3 节。
import {
  createChannel,
  findChannelByName,
  getChannel,
  getKeyStats,
  reenableAllSites,
  updateChannel,
} from "./naci";
import { parseKeys } from "./supplier";
import {
  addLog,
  getUploadedKeyCount,
  recordUploadedKeys,
  upsertUser,
} from "./store";
import type {
  KeyStats,
  NaciChannel,
  SiteAmount,
  UploadResult,
  User,
} from "./types";

/**
 * 解析用户绑定渠道的 naci id：
 * 1. 若 user.channelId 有值 → getChannel 校验存在且名称一致；异常/不一致视为未解析。
 * 2. 未解析 → findChannelByName 按名称扫描。
 * 返回命中的渠道详情（含 id）或 null。
 */
async function resolveChannel(user: User): Promise<NaciChannel | null> {
  const name = user.channelName.trim();
  if (!name) return null;

  if (user.channelId != null) {
    try {
      const detail = await getChannel(user.channelId);
      if (detail && detail.name === name) return detail;
    } catch {
      // 缓存 id 失效，回退到按名称查找
    }
  }

  return findChannelByName(name);
}

/** 上传 key：解析渠道 → 追加或创建 → 回写 id → 拉详情取站点用量 → 记日志。 */
export async function uploadKeys(
  user: User,
  keys: string[]
): Promise<UploadResult> {
  const channelName = user.channelName.trim();
  if (!channelName) {
    throw new Error("当前用户未绑定渠道名称，无法上传 key");
  }

  // 再次去重去空，防御调用方传入脏数据
  const cleanKeys = parseKeys(keys.join("\n"));
  if (cleanKeys.length === 0) {
    throw new Error("没有有效的 key");
  }
  const keyText = cleanKeys.join("\n");

  const existing = await resolveChannel(user);

  let channelId: number;
  let action: UploadResult["action"];
  if (existing) {
    await updateChannel({ id: existing.id, name: channelName, keyText });
    channelId = existing.id;
    action = "updated";
  } else {
    const created = await createChannel({ name: channelName, keyText });
    channelId = created.id;
    action = "created";
  }

  // 上传即重开所有站点，并拿到平台上的真实 key 统计（multi_key_size / 禁用数）
  let keyStats: KeyStats | null = null;
  try {
    keyStats = await reenableAllSites(channelId);
  } catch (err) {
    // 重开失败不阻断上传主流程，记 warn 日志
    await addLog({
      level: "warn",
      actor: user.username,
      channelName,
      channelId,
      message: `重开站点失败：${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // 回写解析到的 channelId
  if (user.channelId !== channelId) {
    await upsertUser({
      ...user,
      channelId,
      updatedAt: new Date().toISOString(),
    });
  }

  // 拉最新详情取站点发布明细（admin-hub 详情未必带用量，容错处理）
  let siteAmounts: SiteAmount[] | undefined;
  try {
    const detail = await getChannel(channelId);
    siteAmounts = detail.site_amounts;
  } catch {
    // 详情拉取失败不影响上传结果本身
  }

  // 记录累计去重 key 数（naci 不返回 key 数量，本系统自行统计）
  const uploadedKeyCount = await recordUploadedKeys(channelName, cleanKeys);

  await addLog({
    level: "success",
    actor: user.username,
    channelName,
    channelId,
    message: `${action === "created" ? "创建渠道并上传" : "向渠道追加"} ${cleanKeys.length} 个 key（累计 ${uploadedKeyCount}${
      keyStats ? `，平台 ${keyStats.platformKeyCount} 个/禁用 ${keyStats.deadKeyCount}` : ""
    }）`,
  });

  return {
    action,
    channelId,
    channelName,
    keyCount: cleanKeys.length,
    uploadedKeyCount,
    siteAmounts,
    platformKeyCount: keyStats?.platformKeyCount,
    deadKeyCount: keyStats?.deadKeyCount,
  };
}

/** 供 GET /api/my/channel 用：解析并返回渠道详情，不写 key。 */
export async function resolveMyChannel(user: User) {
  const channelName = user.channelName.trim();
  if (!channelName) {
    return { exists: false as const, channelName: "", uploadedKeyCount: 0 };
  }

  const uploadedKeyCount = await getUploadedKeyCount(channelName);
  const detail = await resolveChannel(user);

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
    return { exists: false as const, channelName, uploadedKeyCount };
  }

  // 平台真实 key 统计：优先从详情解析，详情未带则不额外触发重开（读操作无副作用）
  let keyStats: KeyStats | null = null;
  try {
    keyStats = await getKeyStats(detail.id);
  } catch {
    // 统计失败不影响渠道详情展示
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
    platformKeyCount: keyStats?.platformKeyCount,
    deadKeyCount: keyStats?.deadKeyCount,
  };
}
