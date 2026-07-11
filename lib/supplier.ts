// 供应商固定参数与渠道模板（admin-hub 方案）
//
// 这些值来自实测与参考数据（docs/edit-channel-request.txt、docs/add-channel-request.txt，
// 实测渠道 5409）：渠道类型固定为 Anthropic Claude 聚合渠道，模型、优先级、分组、多 key
// 模式全部固定，只有渠道名称与 key 由业务填充。
//
// admin-hub 的请求体顶层携带 channel_json（字符串，内部即完整渠道含 key），外加
// last_selected_site_ids_json / site_group_overrides / owner_user_id 控制发布到哪些站点。

/** 模型列表默认值（管理员可在系统配置里改；逗号分隔，new-api 原生格式）。 */
export const DEFAULT_MODELS =
  "claude-opus-4-6,claude-opus-4-7,claude-opus-4-8";

/** 兼容旧引用：保留 FIXED_MODELS 作为兜底默认值（= DEFAULT_MODELS）。 */
export const FIXED_MODELS = DEFAULT_MODELS;

/**
 * 新建渠道优先级：6（账号允许 3/5/6，其中 6 为高优先级但配额仅 6 个）。
 * 渠道退化后由定时任务降到 DEMOTED_PRIORITY(5)，腾出优先级 6 配额。
 */
export const FIXED_PRIORITY = 6;

/** 退化渠道降级到的优先级。 */
export const DEMOTED_PRIORITY = 5;

/**
 * 降级判定只看这些站点是否被禁用（排除对本账号结构性一直未打开的 AGT/13）。
 * 当其中任一站为「禁用(2)」或「自动禁用(3)」时，把渠道从 6 降到 5。
 */
export const DEMOTE_TRIGGER_SITE_IDS = [6, 21];

/** 降级宽限（分钟）：渠道刚建、站点尚未就绪时不判降级，避免误降。 */
export const DEMOTE_GRACE_MINUTES = 5;

/** 固定分组 */
export const FIXED_GROUP = "anthropic";

/**
 * 聚合渠道所属供应商账号 id。laoyu_01 的真实 id 为 66（用户 7/8 样例均为 owner_user_id=66，
 * 且 site 6 远程名为「老余-ice-…」即本账号）。旧值 18 会导致 naci 报「无权选择不可见站点」。
 */
export const OWNER_USER_ID = 66;

/**
 * 供应商已知的全部站点（实测 5409 均发布到这三站）。
 * 展示/校验用全集；实际发布到哪些站以 PUBLISH_SITES 为准（会排除 ai 站）。
 */
export const SITES = [
  { site_id: 6, site_name: "AC站" },
  { site_id: 13, site_name: "AGT站" },
  { site_id: 21, site_name: "61 站" },
];

/**
 * 需要停发的站点 site_id 列表。默认空 = 发布到全部站点 [21,13,6]（照示例请求体）。
 * ⚠️ 日后若要停发某站，把其 site_id 填进来即可（如 [13] 表示不再发 AGT 站），其余全自动跟着变。
 */
export const EXCLUDED_SITE_IDS: number[] = [];

/** 实际发布/重开的站点集合 = 全部站点去掉 EXCLUDED_SITE_IDS。 */
export const PUBLISH_SITES = SITES.filter(
  (s) => !EXCLUDED_SITE_IDS.includes(s.site_id)
);

/** 各站点的分组（全集）；发布时只取 PUBLISH_SITES 对应的子集。 */
const SITE_GROUPS: Record<string, string[]> = {
  "6": ["anthropic", "default"],
  "13": ["anthropic"],
  "21": ["anthropic"],
};

/** 站点分组覆盖（admin-hub 发布时指定每站归属分组）——按 PUBLISH_SITES 动态生成。 */
export const SITE_GROUP_OVERRIDES: Record<string, string[]> = Object.fromEntries(
  PUBLISH_SITES.map((s) => [
    String(s.site_id),
    SITE_GROUPS[String(s.site_id)] ?? ["anthropic"],
  ])
);

/**
 * 上次选择的站点顺序（admin-hub 要求的字符串化数组）。
 * 保持原 [21,13,6] 顺序并去掉 EXCLUDED_SITE_IDS（默认空 → "[21,13,6]"）。
 */
export const LAST_SELECTED_SITE_IDS_JSON = JSON.stringify(
  [21, 13, 6].filter((id) => !EXCLUDED_SITE_IDS.includes(id))
);

/**
 * 渠道高级设置（setting 字段，JSON 字符串）。含 error_filter_mode:2（对齐示例请求体）。
 * 不再携带 proxy 字段——新建渠道一律不走代理（按运营要求去掉）。
 */
const CHANNEL_SETTING =
  '{"concurrency_protection_enabled":false,"max_concurrency":500,"concurrency_protection_threshold":60,"error_filter_mode":2,"ramp_up_minutes":5,"ramp_recovery_threshold":54,"ramp_reach_threshold":90,"ramp_up_confirm_windows":1,"ramp_down_load_threshold":10,"ramp_down_unhealthy_windows":2}';

/**
 * channel_json 内部对象的固定字段模板（不含 name / key）。
 * 结构以 docs/edit-channel-request.txt 里被 naci 接受的请求体为准。
 * 创建时：与 name + key 合并后 JSON.stringify 作为顶层 channel_json 字符串。
 * 更新时：不使用本模板整体覆盖，而是解析平台现有 channel_json 后仅改 key（见 lib/naci.ts）。
 */
export const CHANNEL_JSON_TEMPLATE: Record<string, unknown> = {
  model_series: "anthropic.claude",
  type: 14,
  openai_organization: "",
  max_input_tokens: 0,
  base_url: "",
  other: "",
  model_mapping: "",
  param_override: "",
  header_override: "",
  status_code_mapping: "",
  models: FIXED_MODELS,
  provider_id: 3,
  auto_ban: 1,
  test_model: "",
  priority: FIXED_PRIORITY,
  weight: 1,
  tag: "",
  multi_key_mode: "random",
  settings: '{"allow_service_tier":false,"allow_claude_fallbacks":true}',
  group: FIXED_GROUP,
  status: 1,
  setting: CHANNEL_SETTING,
  remark: "",
  other_info: "",
  channel_info: {},
  azure_responses_version: "",
  // 聚合渠道：多个 key 聚合进单个渠道，配合 multi_key_mode 轮询取用
  create_mode: "multi_to_single",
  doubao_asset_ak_sk: "",
  doubao_asset_host: "",
  doubao_asset_project_name: "",
  key_mode: "append",
  platform_channel_type: "anthropic_claude",
  ramp_down_load_threshold: 10,
  ramp_down_unhealthy_windows: 2,
  ramp_reach_threshold: 90,
  ramp_recovery_threshold: 54,
  ramp_up_confirm_windows: 1,
};

/** 序号直接转字符串（不补零，不限位数：1→"1"，100001→"100001"）。 */
export function formatSuffix(n: number): string {
  return String(Math.max(0, Math.floor(n)));
}

/**
 * 今天的日期标签（MM-DD，**显式**上海时区）。
 * 不用 new Date().getMonth()（取的是服务器本地时区）：容器没设 TZ 时日期会在北京时间
 * 早 8 点才翻天，且与 store.ts 回填 SQL 的 AT TIME ZONE 'Asia/Shanghai' 不一致。
 */
export function todayTag(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const mm = parts.find((p) => p.type === "month")?.value ?? "00";
  const dd = parts.find((p) => p.type === "day")?.value ?? "00";
  return `${mm}-${dd}`;
}

/** 由日期标签 + 前缀 + 序号拼渠道名：`07-10-前缀-1`。每个日期从 1 开始累加，不限位数。 */
export function buildChannelName(prefix: string, dateTag: string, suffix: number): string {
  return `${dateTag}-${prefix.trim()}-${formatSuffix(suffix)}`;
}

/** 把多行/含空白的 key 文本解析为去重、去空的有序数组 */
export function parseKeys(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const k = line.trim();
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}
