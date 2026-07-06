// 持久层：PostgreSQL（node-postgres）。
// 对外导出的函数签名与返回类型与原 JSON 版本完全一致，
// 因此 channelService.ts 与所有 route 无需改动。
import crypto from "crypto";
import { Pool } from "pg";
import type { LogEntry, LogLevel, Role, SystemConfig, User } from "./types";

// —— seed 默认值 ——
// naci 平台地址允许用 env 兜底 seed；登录凭据不走环境变量，统一在数据库配置中手动管理。
const DEFAULT_NACI_BASEURL = "https://open.naci-tech.com";
const SEED_NACI_BASEURL = process.env.NACI_BASE_URL || DEFAULT_NACI_BASEURL;
const SEED_NACI_TOKEN = "";
const SEED_NACI_USERNAME = "";
const SEED_NACI_PASSWORD = "";
// 定时补 key 引擎默认参数（可在系统配置中调整）
const SEED_UPLOAD_BATCH_SIZE = 20;
const SEED_AUTO_REFILL_ENABLED = true;

/** 每批上传数量合法区间钳制（1~1000） */
export function clampBatchSize(n: unknown): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 1) return SEED_UPLOAD_BATCH_SIZE;
  if (v > 1000) return 1000;
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
  await pool.query(
    `ALTER TABLE config ADD COLUMN IF NOT EXISTS auto_refill_enabled boolean NOT NULL DEFAULT true`
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

// —— Config ——
export async function getConfig(): Promise<SystemConfig> {
  const pool = await ensureReady();
  const { rows } = await pool.query<{
    naci_base_url: string;
    naci_token: string;
    naci_username: string;
    naci_password: string;
    upload_batch_size: number;
    auto_refill_enabled: boolean;
  }>(
    "SELECT naci_base_url, naci_token, naci_username, naci_password, upload_batch_size, auto_refill_enabled FROM config WHERE id = 1"
  );
  if (!rows[0]) {
    return {
      naciBaseUrl: SEED_NACI_BASEURL,
      naciToken: SEED_NACI_TOKEN,
      naciUsername: SEED_NACI_USERNAME,
      naciPassword: SEED_NACI_PASSWORD,
      uploadBatchSize: SEED_UPLOAD_BATCH_SIZE,
      autoRefillEnabled: SEED_AUTO_REFILL_ENABLED,
    };
  }
  return {
    naciBaseUrl: rows[0].naci_base_url,
    naciToken: rows[0].naci_token,
    naciUsername: rows[0].naci_username,
    naciPassword: rows[0].naci_password,
    uploadBatchSize: clampBatchSize(rows[0].upload_batch_size),
    autoRefillEnabled: Boolean(rows[0].auto_refill_enabled),
  };
}

export async function saveConfig(cfg: SystemConfig): Promise<void> {
  const pool = await ensureReady();
  await pool.query(
    `INSERT INTO config (id, naci_base_url, naci_token, naci_username, naci_password, upload_batch_size, auto_refill_enabled)
     VALUES (1, $1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE SET
       naci_base_url = EXCLUDED.naci_base_url,
       naci_token = EXCLUDED.naci_token,
       naci_username = EXCLUDED.naci_username,
       naci_password = EXCLUDED.naci_password,
       upload_batch_size = EXCLUDED.upload_batch_size,
       auto_refill_enabled = EXCLUDED.auto_refill_enabled`,
    [
      cfg.naciBaseUrl,
      cfg.naciToken ?? "",
      cfg.naciUsername ?? "",
      cfg.naciPassword ?? "",
      clampBatchSize(cfg.uploadBatchSize),
      cfg.autoRefillEnabled ?? SEED_AUTO_REFILL_ENABLED,
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
    if (r.status === "pending") counts.pending = Number(r.count);
    else if (r.status === "uploaded") counts.uploaded = Number(r.count);
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

/** 取该渠道下一批待上传的 key（status='pending'，按 id 升序 LIMIT n）。 */
export async function nextPendingBatch(
  channelName: string,
  n: number
): Promise<{ id: string; key: string }[]> {
  const name = channelName.trim();
  if (!name || n <= 0) return [];
  const pool = await ensureReady();
  const { rows } = await pool.query<{ id: string; key: string }>(
    `SELECT id, key FROM key_pool
     WHERE channel_name = $1 AND status = 'pending'
     ORDER BY id ASC LIMIT $2`,
    [name, n]
  );
  // bigserial 经 pg 返回字符串，统一转为 string 避免精度问题。
  return rows.map((r) => ({ id: String(r.id), key: r.key }));
}

/** 标记一批池内 key 为已上传。 */
export async function markPoolUploaded(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const pool = await ensureReady();
  await pool.query(
    `UPDATE key_pool SET status = 'uploaded', uploaded_at = now()
     WHERE id = ANY($1::bigint[])`,
    [ids]
  );
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
            count(*) FILTER (WHERE status = 'pending')::int  AS pending,
            count(*) FILTER (WHERE status = 'uploaded')::int AS uploaded
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
