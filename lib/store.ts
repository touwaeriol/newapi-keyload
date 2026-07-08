// 持久层：PostgreSQL（node-postgres）。
// 对外导出的函数签名与返回类型与原 JSON 版本完全一致，
// 因此 channelService.ts 与所有 route 无需改动。
import crypto from "crypto";
import { Pool } from "pg";
import { buildChannelName, DEFAULT_MODELS } from "./supplier";
import type { LogEntry, LogLevel, Role, SystemConfig, User } from "./types";

// —— seed 默认值 ——
// naci 平台地址允许用 env 兜底 seed；登录凭据不走环境变量，统一在数据库配置中手动管理。
const DEFAULT_NACI_BASEURL = "https://open.naci-tech.com";
const SEED_NACI_BASEURL = process.env.NACI_BASE_URL || DEFAULT_NACI_BASEURL;
const SEED_NACI_TOKEN = "";
const SEED_NACI_USERNAME = "";
const SEED_NACI_PASSWORD = "";
// 定时补 key 引擎默认参数（可在系统配置中调整）
const SEED_UPLOAD_BATCH_SIZE = 20; // 聚合 key 数量（每渠道）
const SEED_PROCESS_BATCH_SIZE = 20; // 每批处理数量（每轮/每次处理多少 key）
const SEED_MODELS = DEFAULT_MODELS; // 模型列表默认（管理员可配）
const SEED_AUTO_REFILL_ENABLED = true;
const SEED_REFILL_INTERVAL_MINUTES = 1;

/** 聚合 key 数量合法区间钳制（1~1000，每渠道聚合多少 key） */
export function clampBatchSize(n: unknown): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 1) return SEED_UPLOAD_BATCH_SIZE;
  if (v > 1000) return 1000;
  return v;
}

/** 每批处理数量合法区间钳制（1~10000，每轮/每次处理多少 key） */
export function clampProcessBatchSize(n: unknown): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 1) return SEED_PROCESS_BATCH_SIZE;
  if (v > 10000) return 10000;
  return v;
}

/** 补给间隔（分钟）合法区间钳制（1~1440，即最长一天） */
export function clampIntervalMinutes(n: unknown): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 1) return SEED_REFILL_INTERVAL_MINUTES;
  if (v > 1440) return 1440;
  return v;
}

export function genId(): string {
  return crypto.randomBytes(8).toString("hex");
}

/** 生成一个用户访问密钥 */
export function genAccessKey(prefix = "uk"): string {
  return `${prefix}-${crypto.randomBytes(18).toString("base64url")}`;
}

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

// —— 连接池（单例，兼容 Next dev 热重载） ——
function getPool(): Pool {
  const g = globalThis as unknown as { __keyloadPool?: Pool };
  if (!g.__keyloadPool) {
    g.__keyloadPool = new Pool({
      connectionString: process.env.DATABASE_URL,
    });
  }
  return g.__keyloadPool;
}

// —— 初始化（建表 + seed，带重试，只执行一次） ——
let ready: Promise<void> | null = null;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function createTables(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id text PRIMARY KEY,
      username text UNIQUE NOT NULL,
      role text NOT NULL,
      access_key text UNIQUE NOT NULL,
      channel_name text NOT NULL DEFAULT '',
      channel_id integer,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    )
  `);
  // 兼容已存在的线上库：新增平台 key 统计缓存字段（可空，旧数据默认 NULL）。
  await pool.query(
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS platform_key_count integer`
  );
  await pool.query(
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS dead_key_count integer`
  );
  // 兼容已存在的线上库：缓存该用户所有已建渠道的聚合已用额度（供管理员列表「累计金额」列复用）。
  await pool.query(
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS used_quota bigint`
  );
  await pool.query(`
    CREATE TABLE IF NOT EXISTS config (
      id int PRIMARY KEY DEFAULT 1,
      naci_base_url text NOT NULL,
      naci_token text NOT NULL
    )
  `);
  // 兼容已存在的线上库：新增 admin-hub 登录字段（缺省空串，不破坏旧数据）。
  await pool.query(
    `ALTER TABLE config ADD COLUMN IF NOT EXISTS naci_username text NOT NULL DEFAULT ''`
  );
  await pool.query(
    `ALTER TABLE config ADD COLUMN IF NOT EXISTS naci_password text NOT NULL DEFAULT ''`
  );
  // 兼容已存在的线上库：新增定时补 key 引擎配置（带默认值，不破坏旧数据）。
  await pool.query(
    `ALTER TABLE config ADD COLUMN IF NOT EXISTS upload_batch_size int NOT NULL DEFAULT 20`
  );
  // 每批处理数量（每轮/每次处理多少 key）；旧库默认取聚合数量，保持行为不变。
  await pool.query(
    `ALTER TABLE config ADD COLUMN IF NOT EXISTS process_batch_size int NOT NULL DEFAULT 20`
  );
  // 模型列表（管理员可配）；旧库默认 3 个 opus。
  await pool.query(
    `ALTER TABLE config ADD COLUMN IF NOT EXISTS models text NOT NULL DEFAULT '${SEED_MODELS}'`
  );
  await pool.query(
    `ALTER TABLE config ADD COLUMN IF NOT EXISTS auto_refill_enabled boolean NOT NULL DEFAULT true`
  );
  await pool.query(
    `ALTER TABLE config ADD COLUMN IF NOT EXISTS refill_interval_minutes int NOT NULL DEFAULT 1`
  );
  await pool.query(`
    CREATE TABLE IF NOT EXISTS logs (
      id text PRIMARY KEY,
      at timestamptz NOT NULL,
      level text NOT NULL,
      actor text NOT NULL,
      channel_name text,
      channel_id integer,
      message text NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS uploaded_keys (
      channel_name text NOT NULL,
      key_hash text NOT NULL,
      PRIMARY KEY (channel_name, key_hash)
    )
  `);
  // 本地 key 池：上传的 key 先落这里（明文，供定时引擎取回补 key），逐批 append 到 naci。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS key_pool (
      id bigserial PRIMARY KEY,
      channel_name text NOT NULL,
      key text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      created_at timestamptz NOT NULL DEFAULT now(),
      uploaded_at timestamptz,
      UNIQUE(channel_name, key)
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_key_pool_pending ON key_pool(channel_name, status)`
  );
  // 兼容已存在的线上库：新增「认领中」中间态时间戳（原子取批时置 claimed_at=now()，
  // 供 reclaimStaleClaimed 回收因进程崩溃残留的 claimed 死行）。
  await pool.query(
    `ALTER TABLE key_pool ADD COLUMN IF NOT EXISTS claimed_at timestamptz`
  );
  // 本系统创建的每个 naci 渠道（新模型：每上传一批建一个新渠道）。
  // prefix = 用户前缀(users.channel_name)；suffix = 该前缀下递增序号；(prefix,suffix) 唯一。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS created_channels (
      id           bigserial PRIMARY KEY,
      prefix       text NOT NULL,
      suffix       int  NOT NULL,
      channel_name text NOT NULL,
      channel_id   integer,
      key_count    int  NOT NULL DEFAULT 0,
      priority     int  NOT NULL DEFAULT 6,
      created_at   timestamptz NOT NULL DEFAULT now(),
      UNIQUE(prefix, suffix)
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_created_channels_prefix ON created_channels(prefix)`
  );
  // 兼容旧库：新增渠道优先级列。旧渠道均建于优先级 5（历史 FIXED_PRIORITY=5），
  // 故已存在行回填 5；新建渠道由 finalizeCreatedChannel 显式写 6。
  await pool.query(
    `ALTER TABLE created_channels ADD COLUMN IF NOT EXISTS priority int NOT NULL DEFAULT 5`
  );
  // 每个已建渠道在各站点的远程渠道 id / 名称（来自 naci 创建响应 publish_results）。
  // created_channel_id 引用 created_channels.id；渠道占位行删除时级联清理。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS created_channel_sites (
      created_channel_id   bigint NOT NULL REFERENCES created_channels(id) ON DELETE CASCADE,
      site_id              int  NOT NULL,
      remote_channel_id    int,
      remote_channel_name  text,
      PRIMARY KEY (created_channel_id, site_id)
    )
  `);
}

async function seed(pool: Pool): Promise<void> {
  const { rows: userRows } = await pool.query<{ count: string }>(
    "SELECT count(*)::int AS count FROM users"
  );
  if (Number(userRows[0]?.count ?? 0) === 0) {
    let adminKey = (process.env.ADMIN_ACCESS_KEY || "").trim();
    if (!adminKey) {
      adminKey = genAccessKey("admin");
      console.log("[seed] 生成默认管理员密钥:", adminKey);
    }
    const now = new Date().toISOString();
    await pool.query(
      `INSERT INTO users (id, username, role, access_key, channel_name, channel_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [genId(), "admin", "admin", adminKey, "", null, now, now]
    );
  }

  const { rows: cfgRows } = await pool.query(
    "SELECT 1 FROM config WHERE id = 1"
  );
  if (cfgRows.length === 0) {
    await pool.query(
      `INSERT INTO config (id, naci_base_url, naci_token, naci_username, naci_password)
       VALUES (1, $1, $2, $3, $4)`,
      [
        SEED_NACI_BASEURL,
        SEED_NACI_TOKEN,
        SEED_NACI_USERNAME,
        SEED_NACI_PASSWORD,
      ]
    );
  }
}

async function init(): Promise<void> {
  const pool = getPool();
  let lastErr: unknown;
  for (let i = 0; i < 10; i++) {
    try {
      await pool.query("SELECT 1");
      await createTables(pool);
      await seed(pool);
      return;
    } catch (err) {
      lastErr = err;
      await sleep(1000);
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error("数据库初始化失败");
}

async function ensureReady(): Promise<Pool> {
  if (!ready) {
    // 初始化失败则清空缓存，允许后续请求重试
    ready = init().catch((err) => {
      ready = null;
      throw err;
    });
  }
  await ready;
  return getPool();
}

// —— 行 ↔ 对象映射 ——
interface UserRow {
  id: string;
  username: string;
  role: string;
  access_key: string;
  channel_name: string;
  channel_id: number | null;
  platform_key_count: number | null;
  dead_key_count: number | null;
  used_quota: string | number | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function toIso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function rowToUser(r: UserRow): User {
  return {
    id: r.id,
    username: r.username,
    role: r.role as Role,
    accessKey: r.access_key,
    channelName: r.channel_name,
    channelId: r.channel_id === null ? null : Number(r.channel_id),
    platformKeyCount:
      r.platform_key_count == null ? null : Number(r.platform_key_count),
    deadKeyCount: r.dead_key_count == null ? null : Number(r.dead_key_count),
    usedQuota: r.used_quota == null ? null : Number(r.used_quota),
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

// —— Users ——
export async function getUsers(): Promise<User[]> {
  const pool = await ensureReady();
  const { rows } = await pool.query<UserRow>(
    "SELECT * FROM users ORDER BY created_at ASC, username ASC"
  );
  return rows.map(rowToUser);
}

export async function findUserByKey(key: string): Promise<User | undefined> {
  if (!key) return undefined;
  const pool = await ensureReady();
  const { rows } = await pool.query<UserRow>(
    "SELECT * FROM users WHERE access_key = $1",
    [key]
  );
  return rows[0] ? rowToUser(rows[0]) : undefined;
}

export async function findUserById(id: string): Promise<User | undefined> {
  const pool = await ensureReady();
  const { rows } = await pool.query<UserRow>(
    "SELECT * FROM users WHERE id = $1",
    [id]
  );
  return rows[0] ? rowToUser(rows[0]) : undefined;
}

/** 按绑定渠道名找用户（渠道名全局唯一，用于引擎回写渠道 id / key 统计缓存）。 */
export async function findUserByChannelName(
  channelName: string
): Promise<User | undefined> {
  const name = channelName.trim();
  if (!name) return undefined;
  const pool = await ensureReady();
  const { rows } = await pool.query<UserRow>(
    "SELECT * FROM users WHERE channel_name = $1 LIMIT 1",
    [name]
  );
  return rows[0] ? rowToUser(rows[0]) : undefined;
}

/** 按 id upsert：冲突则整行更新。 */
export async function upsertUser(user: User): Promise<void> {
  const pool = await ensureReady();
  await pool.query(
    `INSERT INTO users (id, username, role, access_key, channel_name, channel_id, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (id) DO UPDATE SET
       username = EXCLUDED.username,
       role = EXCLUDED.role,
       access_key = EXCLUDED.access_key,
       channel_name = EXCLUDED.channel_name,
       channel_id = EXCLUDED.channel_id,
       created_at = EXCLUDED.created_at,
       updated_at = EXCLUDED.updated_at`,
    [
      user.id,
      user.username,
      user.role,
      user.accessKey,
      user.channelName,
      user.channelId,
      user.createdAt,
      user.updatedAt,
    ]
  );
}

export async function deleteUser(id: string): Promise<void> {
  const pool = await ensureReady();
  await pool.query("DELETE FROM users WHERE id = $1", [id]);
}

/** 落库缓存该用户渠道的平台 key 统计（上传/重开站点后写入，供 GET 展示复用）。 */
export async function updateUserKeyStats(
  userId: string,
  stats: { platformKeyCount?: number | null; deadKeyCount?: number | null }
): Promise<void> {
  const pool = await ensureReady();
  await pool.query(
    `UPDATE users SET platform_key_count = $2, dead_key_count = $3 WHERE id = $1`,
    [userId, stats.platformKeyCount ?? null, stats.deadKeyCount ?? null]
  );
}

/** 落库缓存该用户所有已建渠道的聚合已用额度（used-quota 拉取成功后写入，供管理员列表复用）。 */
export async function updateUserUsedQuota(
  userId: string,
  usedQuota: number
): Promise<void> {
  const pool = await ensureReady();
  await pool.query(`UPDATE users SET used_quota = $2 WHERE id = $1`, [
    userId,
    Math.max(0, Math.round(usedQuota)),
  ]);
}

// —— Config ——
export async function getConfig(): Promise<SystemConfig> {
  const pool = await ensureReady();
  const { rows } = await pool.query<{
    naci_base_url: string;
    naci_token: string;
    naci_username: string;
    naci_password: string;
    models: string;
    upload_batch_size: number;
    process_batch_size: number;
    auto_refill_enabled: boolean;
    refill_interval_minutes: number;
  }>(
    "SELECT naci_base_url, naci_token, naci_username, naci_password, models, upload_batch_size, process_batch_size, auto_refill_enabled, refill_interval_minutes FROM config WHERE id = 1"
  );
  if (!rows[0]) {
    return {
      naciBaseUrl: SEED_NACI_BASEURL,
      naciToken: SEED_NACI_TOKEN,
      naciUsername: SEED_NACI_USERNAME,
      naciPassword: SEED_NACI_PASSWORD,
      models: SEED_MODELS,
      uploadBatchSize: SEED_UPLOAD_BATCH_SIZE,
      processBatchSize: SEED_PROCESS_BATCH_SIZE,
      autoRefillEnabled: SEED_AUTO_REFILL_ENABLED,
      refillIntervalMinutes: SEED_REFILL_INTERVAL_MINUTES,
    };
  }
  return {
    naciBaseUrl: rows[0].naci_base_url,
    naciToken: rows[0].naci_token,
    naciUsername: rows[0].naci_username,
    naciPassword: rows[0].naci_password,
    models: (rows[0].models || SEED_MODELS).trim(),
    uploadBatchSize: clampBatchSize(rows[0].upload_batch_size),
    processBatchSize: clampProcessBatchSize(rows[0].process_batch_size),
    autoRefillEnabled: Boolean(rows[0].auto_refill_enabled),
    refillIntervalMinutes: clampIntervalMinutes(rows[0].refill_interval_minutes),
  };
}

export async function saveConfig(cfg: SystemConfig): Promise<void> {
  const pool = await ensureReady();
  const models = (cfg.models ?? "").trim() || SEED_MODELS;
  await pool.query(
    `INSERT INTO config (id, naci_base_url, naci_token, naci_username, naci_password, models, upload_batch_size, process_batch_size, auto_refill_enabled, refill_interval_minutes)
     VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO UPDATE SET
       naci_base_url = EXCLUDED.naci_base_url,
       naci_token = EXCLUDED.naci_token,
       naci_username = EXCLUDED.naci_username,
       naci_password = EXCLUDED.naci_password,
       models = EXCLUDED.models,
       upload_batch_size = EXCLUDED.upload_batch_size,
       process_batch_size = EXCLUDED.process_batch_size,
       auto_refill_enabled = EXCLUDED.auto_refill_enabled,
       refill_interval_minutes = EXCLUDED.refill_interval_minutes`,
    [
      cfg.naciBaseUrl,
      cfg.naciToken ?? "",
      cfg.naciUsername ?? "",
      cfg.naciPassword ?? "",
      models,
      clampBatchSize(cfg.uploadBatchSize),
      clampProcessBatchSize(cfg.processBatchSize),
      cfg.autoRefillEnabled ?? SEED_AUTO_REFILL_ENABLED,
      clampIntervalMinutes(cfg.refillIntervalMinutes),
    ]
  );
}

// —— Logs ——
interface LogRow {
  id: string;
  at: Date | string;
  level: string;
  actor: string;
  channel_name: string | null;
  channel_id: number | null;
  message: string;
}

export async function getLogs(): Promise<LogEntry[]> {
  const pool = await ensureReady();
  const { rows } = await pool.query<LogRow>(
    "SELECT * FROM logs ORDER BY at DESC"
  );
  return rows.map((r) => ({
    id: r.id,
    at: toIso(r.at),
    level: r.level as LogLevel,
    actor: r.actor,
    channelName: r.channel_name ?? undefined,
    channelId: r.channel_id === null ? null : Number(r.channel_id),
    message: r.message,
  }));
}

export async function addLog(entry: {
  level: LogLevel;
  actor: string;
  message: string;
  channelName?: string;
  channelId?: number | null;
}): Promise<void> {
  const pool = await ensureReady();
  await pool.query(
    `INSERT INTO logs (id, at, level, actor, channel_name, channel_id, message)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      genId(),
      new Date().toISOString(),
      entry.level,
      entry.actor,
      entry.channelName ?? null,
      entry.channelId ?? null,
      entry.message,
    ]
  );
  // 仅保留最近 500 条
  await pool.query(
    `DELETE FROM logs WHERE id NOT IN (
       SELECT id FROM logs ORDER BY at DESC LIMIT 500
     )`
  );
}

// —— 上传 key 计数 ——
// naci 详情不返回 key 数量，本系统自行统计「累计去重上传数」。
// 只存 key 的 sha256 十六进制，不存明文；(channel_name, key_hash) 主键天然去重。
export async function recordUploadedKeys(
  channelName: string,
  keys: string[]
): Promise<number> {
  const name = channelName.trim();
  if (!name) return 0;
  const pool = await ensureReady();
  // 批量单条 INSERT：本次去重后一次写入，减少数据库往返。
  const hashes = Array.from(
    new Set(keys.map((k) => k.trim()).filter(Boolean).map((k) => sha256(k)))
  );
  if (hashes.length > 0) {
    const params: string[] = [name, ...hashes];
    const valuesSql = hashes
      .map((_, i) => `($1, $${i + 2})`)
      .join(", ");
    await pool.query(
      `INSERT INTO uploaded_keys (channel_name, key_hash)
       VALUES ${valuesSql} ON CONFLICT DO NOTHING`,
      params
    );
  }
  return getUploadedKeyCount(name);
}

export async function getUploadedKeyCount(channelName: string): Promise<number> {
  const name = channelName.trim();
  if (!name) return 0;
  const pool = await ensureReady();
  const { rows } = await pool.query<{ count: string }>(
    "SELECT count(*)::int AS count FROM uploaded_keys WHERE channel_name = $1",
    [name]
  );
  return Number(rows[0]?.count ?? 0);
}

// —— 本地 key 池（明文，供定时引擎逐批取回补 key） ——

export interface PoolCounts {
  pending: number;
  uploaded: number;
}

/** 该渠道池内 pending / uploaded 计数。 */
export async function poolCounts(channelName: string): Promise<PoolCounts> {
  const name = channelName.trim();
  if (!name) return { pending: 0, uploaded: 0 };
  const pool = await ensureReady();
  const { rows } = await pool.query<{ status: string; count: string }>(
    `SELECT status, count(*)::int AS count FROM key_pool
     WHERE channel_name = $1 GROUP BY status`,
    [name]
  );
  const counts: PoolCounts = { pending: 0, uploaded: 0 };
  for (const r of rows) {
    // 认领中(claimed)的 key 是取批后、渠道建成前的在途态，展示上仍算作「待上传」，避免计数跳变。
    if (r.status === "pending" || r.status === "claimed") {
      counts.pending += Number(r.count);
    } else if (r.status === "uploaded") {
      counts.uploaded = Number(r.count);
    }
  }
  return counts;
}

/**
 * 把 key 批量入池（多值 INSERT ... ON CONFLICT DO NOTHING 去重）。
 * 返回本次新增数与该渠道当前 pending/uploaded 计数。
 */
export async function addKeysToPool(
  channelName: string,
  keys: string[]
): Promise<{ added: number } & PoolCounts> {
  const name = channelName.trim();
  if (!name) return { added: 0, pending: 0, uploaded: 0 };
  const pool = await ensureReady();
  const clean = Array.from(new Set(keys.map((k) => k.trim()).filter(Boolean)));
  let added = 0;
  if (clean.length > 0) {
    const params: string[] = [name, ...clean];
    const valuesSql = clean.map((_, i) => `($1, $${i + 2})`).join(", ");
    const res = await pool.query(
      `INSERT INTO key_pool (channel_name, key)
       VALUES ${valuesSql}
       ON CONFLICT (channel_name, key) DO NOTHING`,
      params
    );
    added = res.rowCount ?? 0;
  }
  const counts = await poolCounts(name);
  return { added, ...counts };
}

/**
 * 原子认领该渠道下一批待上传的 key：单条 UPDATE ... FOR UPDATE SKIP LOCKED，
 * 把选中的 pending 行置为 claimed 并 RETURNING（id, key）。
 *
 * 取代旧的纯 SELECT nextPendingBatch：并发调用（双击 / 双标签页 / kick 撞手动按钮 /
 * admin+user 同时）各自认领**不相交**的批次，杜绝同一批 key 被两个渠道重复上传。
 * 认领成功后：建渠道成功→markPoolUploaded(claimed→uploaded)；失败→releaseClaim(claimed→pending)。
 */
export async function claimPendingBatch(
  channelName: string,
  n: number
): Promise<{ id: string; key: string }[]> {
  const name = channelName.trim();
  if (!name || n <= 0) return [];
  const pool = await ensureReady();
  const { rows } = await pool.query<{ id: string; key: string }>(
    `UPDATE key_pool SET status = 'claimed', claimed_at = now()
     WHERE id IN (
       SELECT id FROM key_pool
       WHERE channel_name = $1 AND status = 'pending'
       ORDER BY id ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, key`,
    [name, n]
  );
  // bigserial 经 pg 返回字符串，统一转为 string 避免精度问题。
  return rows.map((r) => ({ id: String(r.id), key: r.key }));
}

/** 标记一批池内 key 为已上传（claimed/pending → uploaded）。 */
export async function markPoolUploaded(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const pool = await ensureReady();
  await pool.query(
    `UPDATE key_pool SET status = 'uploaded', uploaded_at = now(), claimed_at = NULL
     WHERE id = ANY($1::bigint[])`,
    [ids]
  );
}

/** 释放一批认领：claimed → pending（建渠道失败时回退，下轮/手动可重取）。 */
export async function releaseClaim(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const pool = await ensureReady();
  await pool.query(
    `UPDATE key_pool SET status = 'pending', claimed_at = NULL
     WHERE id = ANY($1::bigint[]) AND status = 'claimed'`,
    [ids]
  );
}

/**
 * 回收超过阈值仍处于 claimed 的死行（进程在「认领后、结算前」崩溃会残留）→ 退回 pending。
 * 权衡：若在「naci 建渠道成功后、markPoolUploaded 前」这一极窄窗口崩溃，被回收的 key 会在
 * 下一轮重传（产生一次重复），概率极低，属可接受取舍。返回回收行数。
 */
export async function reclaimStaleClaimed(
  thresholdMinutes: number
): Promise<number> {
  const pool = await ensureReady();
  const mins = Math.max(1, Math.floor(thresholdMinutes));
  const res = await pool.query(
    `UPDATE key_pool SET status = 'pending', claimed_at = NULL
     WHERE status = 'claimed'
       AND claimed_at IS NOT NULL
       AND claimed_at < now() - ($1::int * interval '1 minute')`,
    [mins]
  );
  return res.rowCount ?? 0;
}

/**
 * 一次性取所有渠道的池计数（pending/uploaded），供管理员用户列表概览。
 * 返回以 channelName 为键的映射；无池记录的渠道不在其中（调用方按缺省 0 处理）。
 */
export async function poolCountsAll(): Promise<Record<string, PoolCounts>> {
  const pool = await ensureReady();
  const { rows } = await pool.query<{
    channel_name: string;
    pending: string;
    uploaded: string;
  }>(
    `SELECT channel_name,
            count(*) FILTER (WHERE status IN ('pending','claimed'))::int AS pending,
            count(*) FILTER (WHERE status = 'uploaded')::int             AS uploaded
       FROM key_pool
      GROUP BY channel_name`
  );
  const map: Record<string, PoolCounts> = {};
  for (const r of rows) {
    map[r.channel_name] = {
      pending: Number(r.pending),
      uploaded: Number(r.uploaded),
    };
  }
  return map;
}

/** 所有仍有 pending key 的渠道名（去重）。 */
export async function channelsWithPending(): Promise<string[]> {
  const pool = await ensureReady();
  const { rows } = await pool.query<{ channel_name: string }>(
    `SELECT DISTINCT channel_name FROM key_pool WHERE status = 'pending'`
  );
  return rows.map((r) => r.channel_name);
}

// —— 已创建渠道（新模型：每上传一批建一个新渠道） ——

export interface CreatedChannel {
  id: string;
  prefix: string;
  suffix: number;
  channelName: string;
  channelId: number | null;
  keyCount: number;
  /** 本系统记录的当前优先级（6=新建，5=退化后降级）。 */
  priority: number;
  createdAt: string;
}

interface CreatedChannelRow {
  id: string;
  prefix: string;
  suffix: number;
  channel_name: string;
  channel_id: number | null;
  key_count: number;
  priority: number;
  created_at: Date | string;
}

function rowToCreatedChannel(r: CreatedChannelRow): CreatedChannel {
  return {
    id: String(r.id),
    prefix: r.prefix,
    suffix: Number(r.suffix),
    channelName: r.channel_name,
    channelId: r.channel_id === null ? null : Number(r.channel_id),
    keyCount: Number(r.key_count),
    priority: Number(r.priority),
    createdAt: toIso(r.created_at),
  };
}

/**
 * 原子分配某前缀的下一个序号并占位插入一行（channel_id 暂空）：
 * 事务内 advisory lock 串行化同前缀的并发（手动按钮 / 引擎），取 MAX(suffix)+1，
 * 插入占位行返回 { id, suffix, channelName }。naci 创建成功后调 finalizeCreatedChannel 回填，
 * 失败则调 deleteCreatedChannel 删除占位行（释放该序号，避免留空洞）。
 */
export async function allocateCreatedChannel(
  prefix: string
): Promise<{ id: string; suffix: number; channelName: string }> {
  const name = prefix.trim();
  if (!name) throw new Error("前缀为空，无法分配渠道序号");
  const pool = await ensureReady();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [name]);
    const { rows } = await client.query<{ next: number }>(
      "SELECT COALESCE(MAX(suffix),0)+1 AS next FROM created_channels WHERE prefix = $1",
      [name]
    );
    const suffix = Number(rows[0].next);
    const channelName = buildChannelName(name, suffix);
    const ins = await client.query<{ id: string }>(
      `INSERT INTO created_channels (prefix, suffix, channel_name, channel_id, key_count)
       VALUES ($1,$2,$3,NULL,0) RETURNING id`,
      [name, suffix, channelName]
    );
    await client.query("COMMIT");
    return { id: String(ins.rows[0].id), suffix, channelName };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback error
    }
    throw err;
  } finally {
    client.release();
  }
}

/** naci 渠道创建成功后回填 channel_id / key_count / priority。 */
export async function finalizeCreatedChannel(
  id: string,
  data: { channelId: number; keyCount: number; priority: number }
): Promise<void> {
  const pool = await ensureReady();
  await pool.query(
    `UPDATE created_channels SET channel_id = $2, key_count = $3, priority = $4 WHERE id = $1`,
    [id, data.channelId, data.keyCount, data.priority]
  );
}

/** 更新某已建渠道（按 naci channel_id）的本地记录优先级（降级后回写）。 */
export async function updateCreatedChannelPriority(
  channelId: number,
  priority: number
): Promise<void> {
  const pool = await ensureReady();
  await pool.query(
    `UPDATE created_channels SET priority = $2 WHERE channel_id = $1`,
    [channelId, priority]
  );
}

/** 删除一条占位/失败的 created_channels 行（naci 创建失败时回滚序号）。 */
export async function deleteCreatedChannel(id: string): Promise<void> {
  const pool = await ensureReady();
  await pool.query(`DELETE FROM created_channels WHERE id = $1`, [id]);
}

/** 某前缀下已成功创建的渠道（channel_id 非空），按序号倒序（最新在前）。 */
export async function listCreatedChannels(
  prefix: string
): Promise<CreatedChannel[]> {
  const name = prefix.trim();
  if (!name) return [];
  const pool = await ensureReady();
  const { rows } = await pool.query<CreatedChannelRow>(
    `SELECT * FROM created_channels
     WHERE prefix = $1 AND channel_id IS NOT NULL
     ORDER BY suffix DESC`,
    [name]
  );
  return rows.map(rowToCreatedChannel);
}

/** 某前缀下已成功创建的渠道 id 列表（channel_id 非空）。 */
export async function createdChannelIds(prefix: string): Promise<number[]> {
  const name = prefix.trim();
  if (!name) return [];
  const pool = await ensureReady();
  const { rows } = await pool.query<{ channel_id: number }>(
    `SELECT channel_id FROM created_channels
     WHERE prefix = $1 AND channel_id IS NOT NULL
     ORDER BY suffix ASC`,
    [name]
  );
  return rows.map((r) => Number(r.channel_id));
}

/** 各前缀已成功创建的渠道数（供管理员列表概览）。 */
export async function createdChannelCountsAll(): Promise<Record<string, number>> {
  const pool = await ensureReady();
  const { rows } = await pool.query<{ prefix: string; count: string }>(
    `SELECT prefix, count(*)::int AS count FROM created_channels
     WHERE channel_id IS NOT NULL GROUP BY prefix`
  );
  const map: Record<string, number> = {};
  for (const r of rows) map[r.prefix] = Number(r.count);
  return map;
}

/** 所有已成功创建过渠道的前缀（去重），供引擎刷新已建渠道状态。 */
export async function prefixesWithCreatedChannels(): Promise<string[]> {
  const pool = await ensureReady();
  const { rows } = await pool.query<{ prefix: string }>(
    `SELECT DISTINCT prefix FROM created_channels WHERE channel_id IS NOT NULL`
  );
  return rows.map((r) => r.prefix);
}

// —— 已建渠道的每站远程渠道 id（naci publish_results 落库） ——

/** 某已建渠道在单个站点的远程渠道 id / 名称。 */
export interface CreatedChannelSite {
  siteId: number;
  remoteChannelId: number;
  remoteChannelName: string;
}

/** 写入某已建渠道各站点的远程渠道 id（幂等 upsert，供 finalize 时调用）。 */
export async function recordCreatedChannelSites(
  createdChannelId: string,
  sites: CreatedChannelSite[]
): Promise<void> {
  if (!createdChannelId || sites.length === 0) return;
  const pool = await ensureReady();
  const params: unknown[] = [createdChannelId];
  const values: string[] = [];
  let i = 2;
  for (const s of sites) {
    values.push(`($1, $${i}, $${i + 1}, $${i + 2})`);
    params.push(s.siteId, s.remoteChannelId, s.remoteChannelName);
    i += 3;
  }
  await pool.query(
    `INSERT INTO created_channel_sites
       (created_channel_id, site_id, remote_channel_id, remote_channel_name)
     VALUES ${values.join(", ")}
     ON CONFLICT (created_channel_id, site_id) DO UPDATE SET
       remote_channel_id = EXCLUDED.remote_channel_id,
       remote_channel_name = EXCLUDED.remote_channel_name`,
    params
  );
}

/** 批量读取多个已建渠道（按 created_channels.id）的每站远程渠道 id，按 site_id 升序分组。 */
export async function createdChannelSitesByChannel(
  createdChannelIds: string[]
): Promise<Map<string, CreatedChannelSite[]>> {
  const out = new Map<string, CreatedChannelSite[]>();
  if (createdChannelIds.length === 0) return out;
  const pool = await ensureReady();
  const { rows } = await pool.query<{
    created_channel_id: string;
    site_id: number;
    remote_channel_id: number | null;
    remote_channel_name: string | null;
  }>(
    `SELECT created_channel_id, site_id, remote_channel_id, remote_channel_name
       FROM created_channel_sites
      WHERE created_channel_id = ANY($1::bigint[])
      ORDER BY site_id ASC`,
    [createdChannelIds]
  );
  for (const r of rows) {
    const key = String(r.created_channel_id);
    const list = out.get(key) ?? [];
    list.push({
      siteId: Number(r.site_id),
      remoteChannelId:
        r.remote_channel_id == null ? 0 : Number(r.remote_channel_id),
      remoteChannelName: r.remote_channel_name ?? "",
    });
    out.set(key, list);
  }
  return out;
}
