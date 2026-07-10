#!/usr/bin/env node
/**
 * naci CLI —— 在命令行直接查询 naci admin-hub 的渠道与用量。
 *
 * 凭据从数据库 config 表读取（与 keyload 服务共用同一份配置），不在命令行/文件里写死。
 * 用法：
 *   node cli/naci-cli search <keyword> [--page-size=40]
 *   node cli/naci-cli usage <keyword> [--page-size=40]
 *   node cli/naci-cli detail <id>
 *
 * 示例：
 *   node cli/naci-cli search 07-09-ANTH-LIU-B
 *   node cli/naci-cli usage  07-09-ANTH-LIU-B
 */

const { Pool } = require("pg");

// ── 工具 ──────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fmtUSD(quota) {
  return "$" + (quota / 500000).toFixed(2);
}

function fmtAt(iso) {
  try { return new Date(iso + "Z").toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }); }
  catch { return iso; }
}

function fmtJSON(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  return JSON.stringify(v, null, 2);
}

// ── DB 读凭据 ─────────────────────────────────────────
async function getCreds() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("❌ 未设置 DATABASE_URL 环境变量");
    process.exit(1);
  }
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const { rows } = await pool.query(
      `SELECT naci_base_url, naci_username, naci_password FROM config LIMIT 1`
    );
    if (!rows[0]) throw new Error("config 表无数据");
    const base = (rows[0].naci_base_url || "").replace(/\/$/, "");
    const username = (rows[0].naci_username || "").trim();
    const password = rows[0].naci_password || "";
    if (!base || !username || !password) {
      console.error("❌ naci 凭据未在系统配置中设置（naciBaseUrl / naciUsername / naciPassword）");
      process.exit(1);
    }
    return { base, username, password };
  } finally {
    await pool.end();
  }
}

// ── naci session ──────────────────────────────────────
let _cookie = null;

async function login(base, username, password) {
  const res = await fetch(`${base}/api/user/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || (json && json.success === false)) {
    throw new Error((json && json.message) || `登录失败 HTTP ${res.status}`);
  }
  const sc = res.headers.get("set-cookie") || "";
  const m = sc.match(/session=([^;]+)/);
  if (!m) throw new Error("登录未返回 session cookie");
  _cookie = m[1];
}

async function naciFetch(pathAndQuery, body) {
  const c = _cookie;
  if (!c) throw new Error("未登录");
  const url = `${_base}${pathAndQuery}`;
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: { Cookie: `session=${c}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const json = await res.json();
  if (!res.ok || (json && json.success === false)) {
    throw new Error((json && json.message) || `请求失败 HTTP ${res.status}`);
  }
  return json;
}

let _base = null;

// ── 子命令 ────────────────────────────────────────────

/** 解析 channel_json 里的 priority */
function parsePriority(item) {
  try {
    if (typeof item.channel_json === "string") {
      const inner = JSON.parse(item.channel_json);
      if (typeof inner.priority === "number") return inner.priority;
    }
  } catch { /* ignore */ }
  return null;
}

async function cmdSearch(keyword, pageSize) {
  pageSize = Math.min(200, Math.max(1, pageSize));
  if (!keyword) { console.error("❌ 缺少 keyword 参数"); process.exit(1); }

  let page = 1;
  let total = 0;
  let fetched = 0;
  const rows = [];

  while (true) {
    const env = await naciFetch(`/api/admin-hub/channels/?p=${page}&page_size=${pageSize}&keyword=${encodeURIComponent(keyword)}`);
    const d = env.data;
    const items = Array.isArray(d.items) ? d.items : [];
    for (const item of items) {
      rows.push(item);
      fetched += 1;
    }
    total = Number(d.total) || 0;
    page += 1;
    if (fetched >= total || items.length === 0) break;
    await sleep(200); // 分页节流
  }

  // 输出表格
  console.log(`\n🔍 关键词 "${keyword}"  共 ${total} 个渠道\n`);
  const hr = "─".repeat(78);
  console.log(hr);
  console.log(`${"naci id".padEnd(8)}  ${"渠道名".padEnd(28)}  ${"P".padEnd(3)}  ${"额度".padEnd(14)}  ${"创建时间"}`);
  console.log(hr);

  let totalQuota = 0;
  const byP = {};

  for (const c of rows) {
    const p = parsePriority(c);
    const pStr = p != null ? String(p) : "?";
    const q = Number(c.used_quota) || 0;
    totalQuota += q;
    if (p != null) {
      if (!byP[p]) byP[p] = { count: 0, quota: 0 };
      byP[p].count += 1;
      byP[p].quota += q;
    }

    console.log(
      `${String(c.id).padEnd(8)}  ${c.name.padEnd(28)}  ${pStr.padEnd(3)}  ${String(Math.round(q)).padEnd(10)}${fmtUSD(q).padEnd(6)}  ${fmtAt(c.created_at)}`
    );
  }
  console.log(hr);
  console.log(`合计 ${total} 个  |  总 used_quota: ${Math.round(totalQuota)} ≈ ${fmtUSD(totalQuota)}`);
  if (Object.keys(byP).length > 0) {
    console.log("\n按优先级:");
    for (const [p, v] of Object.entries(byP).sort((a, b) => b[0] - a[0])) {
      console.log(`  P${p}: ${v.count} 个  额度合计 ${Math.round(v.quota)} ≈ ${fmtUSD(v.quota)}`);
    }
  }
}

async function cmdUsage(keyword, pageSize) {
  pageSize = Math.min(200, Math.max(1, pageSize));
  if (!keyword) { console.error("❌ 缺少 keyword 参数"); process.exit(1); }

  // 1. 先搜出所有渠道 id
  let page = 1;
  let total = 0;
  let fetched = 0;
  const items = [];

  console.log(`⏳ 搜索关键词 "${keyword}" …`);
  while (true) {
    const env = await naciFetch(`/api/admin-hub/channels/?p=${page}&page_size=${pageSize}&keyword=${encodeURIComponent(keyword)}`);
    const d = env.data;
    const batch = Array.isArray(d.items) ? d.items : [];
    items.push(...batch);
    fetched += batch.length;
    total = Number(d.total) || 0;
    page += 1;
    if (fetched >= total || batch.length === 0) break;
    await sleep(200);
  }
  console.log(`  找到 ${total} 个渠道`);

  // 2. 分块拉 used-quota（每块 40，块间 300ms）
  const ids = items.map(c => c.id);
  const idToItem = new Map(items.map(c => [c.id, c]));
  const CHUNK = 40;

  const allUsage = new Map(); // id → {usedQuota, usedAmount, sites}
  console.log(`⏳ 拉 used-quota（${ids.length} 个渠道 / ${CHUNK} 块）…`);
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const env = await naciFetch("/api/admin-hub/channels/used-quota", { ids: chunk });
    const data = env.data || {};
    for (const id of chunk) {
      const entry = data[String(id)];
      if (entry && typeof entry === "object") {
        const q = Number(entry.used_quota) || 0;
        allUsage.set(id, { usedQuota: q, usedAmount: q / 500000, sites: entry.sites || [] });
      }
    }
    process.stdout.write(`\r  进度 ${Math.min(i + CHUNK, ids.length)}/${ids.length}`);
    if (i + CHUNK < ids.length) await sleep(300);
  }
  console.log("");

  // 3. 按优先级汇总 + 输出
  const byP = {}; // priority → {count, usedQuota, usedAmount, channels:[]}
  let grandTotalQuota = 0;
  let grandTotalAmount = 0;

  for (const item of items) {
    const p = parsePriority(item);
    const usage = allUsage.get(item.id);
    const q = usage ? usage.usedQuota : (Number(item.used_quota) || 0);
    const a = q / 500000;

    if (p != null) {
      if (!byP[p]) byP[p] = { count: 0, usedQuota: 0, usedAmount: 0, channels: [] };
      byP[p].count += 1;
      byP[p].usedQuota += q;
      byP[p].usedAmount += a;
      byP[p].channels.push({ id: item.id, name: item.name, usedQuota: q, usedAmount: a });
    }
    grandTotalQuota += q;
    grandTotalAmount += a;
  }

  console.log(`\n📊 关键词 "${keyword}"  用量汇总\n`);
  console.log(`渠道总数: ${items.length}    总 used_quota: ${Math.round(grandTotalQuota).toLocaleString()} ≈ ${fmtUSD(grandTotalQuota)}\n`);

  const hr = "─".repeat(64);
  for (const pkey of Object.keys(byP).sort((a, b) => b - a)) {
    const g = byP[pkey];
    console.log(`\n── P${pkey}（${g.count} 个）  合计 ${Math.round(g.usedQuota).toLocaleString()} ≈ ${fmtUSD(g.usedQuota)} ──`);
    console.log(hr);
    // 按 used_quota 降序
    const sorted = g.channels.sort((a, b) => b.usedQuota - a.usedQuota);
    for (const ch of sorted) {
      const bar = ch.usedQuota > 0 ? "█".repeat(Math.min(30, Math.round(ch.usedAmount * 10))) : "";
      console.log(
        `${String(ch.id).padEnd(8)}  ${ch.name.padEnd(32)}  ${fmtUSD(ch.usedQuota).padStart(10)}  ${bar}`
      );
    }
  }
  console.log(`\n━━ 总计: ${Math.round(grandTotalQuota).toLocaleString()} ≈ ${fmtUSD(grandTotalQuota)}`);
}

async function cmdDetail(id) {
  if (!id) { console.error("❌ 缺少渠道 id"); process.exit(1); }

  // 渠道详情
  const env = await naciFetch(`/api/admin-hub/channels/${id}`);
  const c = env.data;

  // used-quota
  let usage = null;
  try {
    const uEnv = await naciFetch("/api/admin-hub/channels/used-quota", { ids: [id] });
    usage = (uEnv.data && uEnv.data[String(id)]) || null;
  } catch { /* ok */ }

  const p = parsePriority(c);

  console.log(`\n📋 渠道 #${c.id}`);
  console.log(`  名称:        ${c.name}`);
  console.log(`  优先级:       ${p != null ? p : "?"}`);
  console.log(`  used_quota:   ${(c.used_quota || 0).toLocaleString()} ≈ ${fmtUSD(c.used_quota || 0)}`);
  console.log(`  创建时间:     ${fmtAt(c.created_at)}`);
  console.log(`  更新时间:     ${fmtAt(c.updated_at)}`);

  if (usage && Array.isArray(usage.sites)) {
    console.log(`\n  各站用量:`);
    for (const s of usage.sites) {
      console.log(`    site ${s.site_id} ${(s.site_name || "").padEnd(6)}  ${String(s.used_quota || 0).padStart(10)} ≈ ${fmtUSD(s.used_quota || 0)}`);
    }
  }
  console.log("");
}

// ── 入口 ──────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    console.log(
      "naci CLI —— 查询 naci admin-hub 的渠道与用量\n" +
      "\n用法:\n" +
      "  node cli/naci-cli search  <keyword>         列表（分页）+ used_quota\n" +
      "  node cli/naci-cli usage   <keyword>         列表 + 实时 used-quota 聚合\n" +
      "  node cli/naci-cli detail  <id>              单渠道详情\n" +
      "\n选项:\n" +
      "  --page-size=N  每页数量（默认 200）\n" +
      "\n示例:\n" +
      "  node cli/naci-cli search 07-09-ANTH-LIU-B\n" +
      "  node cli/naci-cli usage  07-09-ANTH-LIU-B --page-size=40\n" +
      "  node cli/naci-cli detail 24052\n"
    );
    process.exit(0);
  }

  const cmd = args[0];
  const keywordArgs = args.slice(1).filter(a => !a.startsWith("--"));
  const keyword = keywordArgs[0] || "";
  const pageSizeIdx = args.findIndex(a => a.startsWith("--page-size="));
  const pageSize = pageSizeIdx >= 0
    ? parseInt(args[pageSizeIdx].split("=")[1], 10)
    : 200;

  // 登录
  const creds = await getCreds();
  _base = creds.base;
  try {
    await login(creds.base, creds.username, creds.password);
  } catch (err) {
    console.error("❌ naci 登录失败:", err.message);
    process.exit(1);
  }

  try {
    switch (cmd) {
      case "search":  await cmdSearch(keyword, pageSize); break;
      case "usage":   await cmdUsage(keyword, pageSize); break;
      case "detail":  await cmdDetail(parseInt(keyword, 10)); break;
      default:
        console.error(`❌ 未知命令: ${cmd}`);
        process.exit(1);
    }
  } catch (err) {
    console.error("❌ 错误:", err.message);
    process.exit(1);
  }
}

main();
