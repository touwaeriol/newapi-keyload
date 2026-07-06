// 供应商固定参数与渠道模板（admin-hub 方案）
//
// 这些值来自实测与参考数据（docs/edit-channel-request.txt、docs/add-channel-request.txt，
// 实测渠道 5409）：渠道类型固定为 Anthropic Claude 聚合渠道，模型、优先级、分组、多 key
// 模式全部固定，只有渠道名称与 key 由业务填充。
//
// admin-hub 的请求体顶层携带 channel_json（字符串，内部即完整渠道含 key），外加
// last_selected_site_ids_json / site_group_overrides / owner_user_id 控制发布到哪些站点。

/** 固定模型列表（逗号分隔，new-api 原生格式） */
export const FIXED_MODELS =
  "claude-sonnet-4-5-20250929,claude-opus-4-5-20251101,claude-sonnet-4-6,claude-haiku-4-5-20251001,claude-opus-4-6,claude-opus-4-7,claude-opus-4-8,claude-sonnet-5,claude-fable-5";

/** 固定优先级 */
export const FIXED_PRIORITY = 7;

/** 固定分组 */
export const FIXED_GROUP = "anthropic";

/** 聚合渠道所属供应商账号（session 登录用户 laoyu_01 → id 18） */
export const OWNER_USER_ID = 18;

/**
 * 供应商发布的站点（实测 5409 均发布到这三站）。
 * site_group_overrides / last_selected_site_ids_json 均以此为准。
 */
export const SITES = [
  { site_id: 6, site_name: "AC站" },
  { site_id: 13, site_name: "AGT站" },
  { site_id: 21, site_name: "61 站" },
];

/** 各站点的分组覆盖（admin-hub 发布时指定每个站点归属的分组） */
export const SITE_GROUP_OVERRIDES: Record<string, string[]> = {
  "6": ["anthropic", "default"],
  "13": ["anthropic"],
  "21": ["anthropic"],
};

/** 上次选择的站点顺序（admin-hub 要求的字符串化数组），发布到 21/13/6 三站 */
export const LAST_SELECTED_SITE_IDS_JSON = "[21,13,6]";

/** 渠道高级设置（setting 字段，JSON 字符串） */
const CHANNEL_SETTING =
  '{"proxy":"","concurrency_protection_enabled":false,"max_concurrency":500,"concurrency_protection_threshold":60,"ramp_up_minutes":5,"ramp_recovery_threshold":54,"ramp_reach_threshold":90,"ramp_up_confirm_windows":1,"ramp_down_load_threshold":10,"ramp_down_unhealthy_windows":2}';

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
  settings: '{"allow_service_tier":false}',
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
