// 供应商固定参数与渠道模板
//
// 这些值来自实测与参考数据（docs/edit-channel-request.txt、实测 5409/5798）：
// 渠道类型固定为 Anthropic Claude 聚合渠道，模型、优先级、分组、多 key 模式全部固定，
// 只有渠道名称与 key 由业务填充。

/** 固定模型列表（逗号分隔，new-api 原生格式） */
export const FIXED_MODELS =
  "claude-sonnet-4-5-20250929,claude-opus-4-5-20251101,claude-sonnet-4-6,claude-haiku-4-5-20251001,claude-opus-4-6,claude-opus-4-7,claude-opus-4-8,claude-sonnet-5,claude-fable-5";

/** 固定优先级 */
export const FIXED_PRIORITY = 7;

/** 固定分组 */
export const FIXED_GROUP = "anthropic";

/** Anthropic Claude 渠道的固定字段模板（不含 name / key） */
export const CHANNEL_TEMPLATE = {
  type: 14,
  base_url: "",
  models: FIXED_MODELS,
  group: FIXED_GROUP,
  priority: FIXED_PRIORITY,
  model_series: "anthropic.claude",
  platform_channel_type: "anthropic_claude",
  provider_id: 3,
  multi_key_mode: "random",
  auto_ban: 1,
  weight: 1,
  status: 1,
  settings: '{"allow_service_tier":false}',
  key_mode: "append" as const,
};

/** 供应商发布的站点（实测 5409/5798 均发布到这三站） */
export const SITES = [
  { site_id: 6, site_name: "AC站" },
  { site_id: 13, site_name: "AGT站" },
  { site_id: 21, site_name: "61 站" },
];

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
