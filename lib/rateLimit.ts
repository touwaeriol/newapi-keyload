// 上传限速滚动桶：Redis ZSET 滑动窗口（上传一个计一个，窗口外自动失效）。
// Redis 不可用（未配 REDIS_URL / 连接故障）时自动降级为进程内存桶——本系统单进程，
// 限速仍然生效；Redis 恢复后自动切回（切换时只记一条日志，不刷屏）。
import crypto from "crypto";
import Redis from "ioredis";
import { addLog } from "./store";

export interface BucketUsage {
  /** 当前窗口内已上传的 key 数 */
  used: number;
  /** 窗口内上限（0=不限速） */
  limit: number;
  /** 窗口长度（分钟） */
  windowMinutes: number;
  /** 是否不限速（limit<=0） */
  unlimited: boolean;
}

/** 全局桶 scope */
export const GLOBAL_SCOPE = "global";

/** 单用户桶 scope */
export function userScope(userId: string): string {
  return `user:${userId}`;
}

/** 计算某用户生效的限速（个人覆盖 ?? 全局默认） */
export function effectiveUserLimit(
  user: { uploadLimitCount?: number | null; uploadLimitWindowMinutes?: number | null },
  cfg: { userUploadLimitCount: number; userUploadLimitWindowMinutes: number },
): { limit: number; windowMinutes: number; isOverride: boolean } {
  const isOverride =
    user.uploadLimitCount != null || user.uploadLimitWindowMinutes != null;
  return {
    limit: user.uploadLimitCount ?? cfg.userUploadLimitCount,
    windowMinutes: user.uploadLimitWindowMinutes ?? cfg.userUploadLimitWindowMinutes,
    isOverride,
  };
}

const KEY_PREFIX = "keyload:upl:";

// —— Redis 客户端（单例，兼容 Next dev 热重载；命令快速失败以便降级） ——
function getRedis(): Redis | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  const g = globalThis as unknown as { __keyloadRedis?: Redis };
  if (!g.__keyloadRedis) {
    g.__keyloadRedis = new Redis(url, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false, // 断连时命令立刻抛错 → 走内存桶，不排队阻塞
      retryStrategy: (times) => Math.min(times * 1000, 15_000),
    });
    // 必须挂 error 监听，否则断连会抛未处理异常拖垮进程；降级在调用处处理
    g.__keyloadRedis.on("error", () => {});
  }
  return g.__keyloadRedis;
}

// —— 内存桶（降级用；逐条 {ts,id}，便于按 member 精确释放/找零） ——
interface MemEntry {
  ts: number;
  id: string;
}

function memStore(): Map<string, MemEntry[]> {
  const g = globalThis as unknown as { __keyloadRateMem?: Map<string, MemEntry[]> };
  if (!g.__keyloadRateMem) g.__keyloadRateMem = new Map();
  return g.__keyloadRateMem;
}

/** 裁掉窗口外条目并回写，返回该 scope 存活条目列表。 */
function memPrune(scope: string, windowMs: number): MemEntry[] {
  const store = memStore();
  const cutoff = Date.now() - windowMs;
  const list = (store.get(scope) ?? []).filter((e) => e.ts > cutoff);
  if (list.length > 0) store.set(scope, list);
  else store.delete(scope);
  return list;
}

function memCount(scope: string, windowMs: number): number {
  return memPrune(scope, windowMs).length;
}

/** 内存桶原子预占（单进程，无并发交错）：返回实际占到的数量与 member id 列表。 */
function memReserve(
  scope: string,
  limit: number,
  want: number,
  windowMs: number
): { granted: number; members: string[] } {
  const list = memPrune(scope, windowMs);
  const granted = limit <= 0 ? want : Math.max(0, Math.min(want, limit - list.length));
  if (granted <= 0) return { granted: 0, members: [] };
  const now = Date.now();
  const rand = crypto.randomBytes(6).toString("hex");
  const members: string[] = [];
  for (let i = 0; i < granted; i++) {
    const id = `${now}:${rand}:${i}`;
    list.push({ ts: now, id });
    members.push(id);
  }
  memStore().set(scope, list);
  return { granted, members };
}

function memRelease(scope: string, members: string[]): void {
  if (members.length === 0) return;
  const store = memStore();
  const drop = new Set(members);
  const list = (store.get(scope) ?? []).filter((e) => !drop.has(e.id));
  if (list.length > 0) store.set(scope, list);
  else store.delete(scope);
}

// —— 后端切换记录（只在 redis↔memory 切换瞬间各记一条日志） ——
let currentBackend: "redis" | "memory" | null = null;

function noteBackend(backend: "redis" | "memory", err?: unknown): void {
  if (currentBackend === backend) return;
  currentBackend = backend;
  const message =
    backend === "memory"
      ? `上传限速降级为进程内存桶（Redis 不可用${err ? `：${err instanceof Error ? err.message : String(err)}` : "，未配置 REDIS_URL"}）`
      : "上传限速已恢复使用 Redis 滚动桶";
  void addLog({ level: backend === "memory" ? "warn" : "info", actor: "system", message }).catch(
    () => {},
  );
}

// —— Redis 滑动窗口实现 ——
async function redisCount(r: Redis, scope: string, windowMs: number): Promise<number> {
  const key = KEY_PREFIX + scope;
  await r.zremrangebyscore(key, 0, Date.now() - windowMs);
  return r.zcard(key);
}

// 原子预占 Lua：清窗口外 → 统计 → 计算可占 granted → 逐个 ZADD → PEXPIRE → 返回占用的 member 列表。
// KEYS[1]=zset；ARGV: now, windowMs, want, limit, cutoff, rand。limit<=0 表示不限速（仍按 want 预占计数）。
const RESERVE_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local want = tonumber(ARGV[3])
local limit = tonumber(ARGV[4])
local cutoff = tonumber(ARGV[5])
local rand = ARGV[6]
redis.call('ZREMRANGEBYSCORE', key, 0, cutoff)
local count = redis.call('ZCARD', key)
local granted
if limit <= 0 then
  granted = want
else
  local room = limit - count
  if room < 0 then room = 0 end
  granted = math.min(want, room)
end
local members = {}
for i = 1, granted do
  local m = now .. ':' .. rand .. ':' .. i
  redis.call('ZADD', key, now, m)
  members[i] = m
end
if granted > 0 then
  redis.call('PEXPIRE', key, windowMs + 60000)
end
return members
`;

async function redisReserve(
  r: Redis,
  scope: string,
  limit: number,
  want: number,
  windowMs: number
): Promise<{ granted: number; members: string[] }> {
  const now = Date.now();
  const rand = crypto.randomBytes(6).toString("hex");
  const members = (await r.eval(
    RESERVE_LUA,
    1,
    KEY_PREFIX + scope,
    String(now),
    String(windowMs),
    String(want),
    String(limit),
    String(now - windowMs),
    rand
  )) as string[];
  return { granted: members.length, members };
}

/** 读取某 scope 当前窗口用量（limit=0 视为不限速，但 used 照常统计，供状态展示） */
export async function peekBucket(
  scope: string,
  limit: number,
  windowMinutes: number,
): Promise<BucketUsage> {
  const windowMs = Math.max(1, windowMinutes) * 60_000;
  let used: number;
  const r = getRedis();
  if (r) {
    try {
      used = await redisCount(r, scope, windowMs);
      noteBackend("redis");
      return { used, limit, windowMinutes, unlimited: limit <= 0 };
    } catch (err) {
      noteBackend("memory", err);
    }
  } else {
    noteBackend("memory");
  }
  used = memCount(scope, windowMs);
  return { used, limit, windowMinutes, unlimited: limit <= 0 };
}

/**
 * 原子预占 want 个额度（上传前调用）：返回实际占到的 granted（≤want）与 member 列表。
 * 因是「事前预占」，桶用量即时反映在途上传，并发下别的上传只能看到剩余额度 → 实现「占桶」语义。
 * 建渠道失败 / 池不足 / 多桶找零 时，用返回的 members 调 releaseBucket 退还。
 */
export async function reserveBucket(
  scope: string,
  limit: number,
  want: number,
  windowMinutes: number,
): Promise<{ granted: number; members: string[] }> {
  return reserveBucketMs(scope, limit, want, Math.max(1, windowMinutes) * 60_000);
}

/** 同 reserveBucket，但窗口按毫秒给（供秒级限流用，如「每 3 秒一次查询」）。 */
export async function reserveBucketMs(
  scope: string,
  limit: number,
  want: number,
  windowMs: number,
): Promise<{ granted: number; members: string[] }> {
  if (want <= 0) return { granted: 0, members: [] };
  const win = Math.max(1000, windowMs);
  const r = getRedis();
  if (r) {
    try {
      const res = await redisReserve(r, scope, limit, want, win);
      noteBackend("redis");
      return res;
    } catch (err) {
      noteBackend("memory", err);
    }
  } else {
    noteBackend("memory");
  }
  return memReserve(scope, limit, want, win);
}

/**
 * 该 scope 窗口内最早一次占用还有多久过期（毫秒；桶空返回 0）。
 * 占桶失败（429）时用它告诉用户还要等多久。
 */
export async function bucketRetryAfterMs(
  scope: string,
  windowMs: number,
): Promise<number> {
  const now = Date.now();
  const r = getRedis();
  if (r) {
    try {
      const res = await r.zrange(KEY_PREFIX + scope, 0, 0, "WITHSCORES");
      noteBackend("redis");
      if (res.length < 2) return 0;
      return Math.max(0, Number(res[1]) + windowMs - now);
    } catch (err) {
      noteBackend("memory", err);
    }
  }
  const list = memPrune(scope, windowMs);
  if (list.length === 0) return 0;
  return Math.max(0, list[0].ts + windowMs - now);
}

/** 退还此前预占的额度（回滚 / 找零）。members 为 reserveBucket 返回的成员子集。 */
export async function releaseBucket(scope: string, members: string[]): Promise<void> {
  if (members.length === 0) return;
  const r = getRedis();
  if (r) {
    try {
      await r.zrem(KEY_PREFIX + scope, ...members);
      noteBackend("redis");
      return;
    } catch (err) {
      noteBackend("memory", err);
    }
  }
  memRelease(scope, members);
}
