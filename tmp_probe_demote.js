/* 诊断：为什么自动禁用的优先级6渠道没被降级。
 * 凭据从 DB config 表读取，只用于登录，绝不打印。用完即删本文件。 */
const { Client } = require("pg");

const IDS = [14889, 14918, 14920, 14927, 14930, 14932, 14933, 14935, 14977, 14985];

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const r = await db.query(
    "SELECT naci_base_url base, naci_username username, naci_password password FROM config LIMIT 1"
  );
  const { base, username, password } = r.rows[0];

  await db.end();

  // 登录 naci（429 时退避重试）
  let cookie = null;
  for (let i = 0; i < 5 && !cookie; i++) {
    const loginRes = await fetch(`${base}/api/user/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const setCookie = loginRes.headers.get("set-cookie") || "";
    const m = setCookie.match(/session=[^;]+/);
    if (m) { cookie = m[0]; break; }
    console.log(`login attempt ${i + 1} failed: HTTP ${loginRes.status}, retry in 45s`);
    await new Promise((r2) => setTimeout(r2, 45000));
  }
  if (!cookie) { console.log("login failed after retries"); return; }
  const H = { Cookie: cookie, "Content-Type": "application/json" };

  // 1) 批量 status-batch（降级任务的读法）
  const batchRes = await fetch(`${base}/api/admin-hub/channels/status-batch`, {
    method: "POST", headers: H, body: JSON.stringify({ ids: IDS }),
  });
  const batch = await batchRes.json();
  console.log("\n== 批量 status-batch（降级任务用的这种） ==");
  for (const id of IDS) {
    const e = batch?.data?.[String(id)];
    if (!e || !Array.isArray(e.sites)) { console.log(`${id}: <无条目>`); continue; }
    const parts = e.sites.map((s) => {
      const info = s.channel_info || {};
      const list = info.multi_key_status_list;
      const listStr = list ? JSON.stringify(list) : "-";
      return `site${s.site_id}:st=${s.status},size=${info.multi_key_size ?? "-"},list=${listStr}`;
    });
    console.log(`${id}: ${parts.join(" | ")}`);
  }

  // 2) 渠道列表条目（看渠道级 status 字段——页面上的「自动禁用」标签来源）
  console.log("\n== 渠道详情 GET /channels/{id}（看渠道级 status） ==");
  for (const id of IDS) {
    const dRes = await fetch(`${base}/api/admin-hub/channels/${id}`, { headers: H });
    const d = await dRes.json();
    const ch = d?.data?.channel ?? d?.data ?? {};
    const info = ch.channel_info ?? {};
    console.log(
      `${id}: status=${ch.status} priority=${ch.priority} auto_ban=${ch.auto_ban ?? "-"} info=${JSON.stringify(info).slice(0, 120)}`
    );
    await new Promise((r2) => setTimeout(r2, 150));
  }
}

main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
