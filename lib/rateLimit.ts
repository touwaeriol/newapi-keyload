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

// —— 内存桶（降级用；{ts,n} 条目按窗口裁剪） ——
interface MemEntry {
  ts: number;
  n: number;
}

function memStore(): Map<string, MemEntry[]> {
  const g = globalThis as unknown as { __keyloadRateMem?: Map<string, MemEntry[]> };
  if (!g.__keyloadRateMem) g.__keyloadRateMem = new Map();
  return g.__keyloadRateMem;
}

function memCount(scope: string, windowMs: number): number {
  const store = memStore();
  const cutoff = Date.now() - windowMs;
  const list = (store.get(scope) ?? []).filter((e) => e.ts > cutoff);
  if (list.length > 0) store.set(scope, list);
  else store.delete(scope);
  return list.reduce((sum, e) => sum + e.n, 0);
}

function memAdd(scope: string, n: number): void {
  const store = memStore();
  const list = store.get(scope) ?? [];
  list.push({ ts: Date.now(), n });
  store.set(scope, list);
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

async function redisAdd(r: Redis, scope: string, n: number, windowMs: number): Promise<void> {
  const key = KEY_PREFIX + scope;
  const now = Date.now();
  const rand = crypto.randomBytes(6).toString("hex");
  const args: (string | number)[] = [];
  for (let i = 0; i < n; i++) {
    args.push(now, `${now}:${rand}:${i}`); // score, member 成对
  }
  await r.zadd(key, ...args);
  await r.pexpire(key, windowMs + 60_000); // 窗口后兜底清 key
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

/** 上传成功后记账：向 scope 写入 n 个计数（窗口滚动后自动失效） */
export async function consumeBucket(
  scope: string,
  n: number,
  windowMinutes: number,
): Promise<void> {
  if (n <= 0) return;
  const windowMs = Math.max(1, windowMinutes) * 60_000;
  const r = getRedis();
  if (r) {
    try {
      await redisAdd(r, scope, n, windowMs);
      noteBackend("redis");
      return;
    } catch (err) {
      noteBackend("memory", err);
    }
  } else {
    noteBackend("memory");
  }
  memAdd(scope, n);
}
