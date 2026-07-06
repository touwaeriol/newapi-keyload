// 持久层：PostgreSQL（node-postgres）。
// 对外导出的函数签名与返回类型与原 JSON 版本完全一致，
// 因此 channelService.ts 与所有 route 无需改动。
import crypto from "crypto";
import { Pool } from "pg";
import type { LogEntry, LogLevel, Role, SystemConfig, User } from "./types";

// —— seed 默认值（敏感信息来自环境变量，代码内不留明文） ——
const DEFAULT_NACI_BASEURL = "https://open.naci-tech.com";
const SEED_NACI_BASEURL = process.env.NACI_BASE_URL || DEFAULT_NACI_BASEURL;
const SEED_NACI_TOKEN = "";
// naci 登录凭据不从环境变量兜底，统一在数据库配置中手动管理
const SEED_NACI_USERNAME = "";
const SEED_NACI_PASSWORD = "";

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

/** 整表替换：事务内清空后批量插入。 */
export async function saveUsers(users: User[]): Promise<void> {
  const pool = await ensureReady();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM users");
    for (const u of users) {
      await client.query(
        `INSERT INTO users (id, username, role, access_key, channel_name, channel_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          u.id,
          u.username,
          u.role,
          u.accessKey,
          u.channelName,
          u.channelId,
          u.createdAt,
          u.updatedAt,
        ]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
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

// —— Config ——
export async function getConfig(): Promise<SystemConfig> {
  const pool = await ensureReady();
  const { rows } = await pool.query<{
    naci_base_url: string;
    naci_token: string;
    naci_username: string;
    naci_password: string;
  }>(
    "SELECT naci_base_url, naci_token, naci_username, naci_password FROM config WHERE id = 1"
  );
  if (!rows[0]) {
    return {
      naciBaseUrl: SEED_NACI_BASEURL,
      naciToken: SEED_NACI_TOKEN,
      naciUsername: SEED_NACI_USERNAME,
      naciPassword: SEED_NACI_PASSWORD,
    };
  }
  return {
    naciBaseUrl: rows[0].naci_base_url,
    naciToken: rows[0].naci_token,
    naciUsername: rows[0].naci_username,
    naciPassword: rows[0].naci_password,
  };
}

export async function saveConfig(cfg: SystemConfig): Promise<void> {
  const pool = await ensureReady();
  await pool.query(
    `INSERT INTO config (id, naci_base_url, naci_token, naci_username, naci_password)
     VALUES (1, $1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET
       naci_base_url = EXCLUDED.naci_base_url,
       naci_token = EXCLUDED.naci_token,
       naci_username = EXCLUDED.naci_username,
       naci_password = EXCLUDED.naci_password`,
    [
      cfg.naciBaseUrl,
      cfg.naciToken ?? "",
      cfg.naciUsername ?? "",
      cfg.naciPassword ?? "",
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
  for (const k of keys) {
    const trimmed = k.trim();
    if (!trimmed) continue;
    await pool.query(
      `INSERT INTO uploaded_keys (channel_name, key_hash)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [name, sha256(trimmed)]
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
