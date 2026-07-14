"use client";

// 模型缺口卡（管理端 + 用户端共用）：查 naci 平台某站各模型的供需缺口。
// endpoint 决定走管理员还是用户接口（数据一致，仅鉴权不同）。
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/client";
import { Button, Card, Spinner } from "@/components/ui";

/** 可查询模型缺口的站点（naci SITES）。 */
const GAP_SITES = [
  { id: 6, label: "AC站" },
  { id: 13, label: "AGT站" },
  { id: 21, label: "61 站" },
];

/** model-gaps 返回的单条缺口。 */
interface GapItem {
  channel_type: number;
  channel_type_name: string;
  model_name: string;
  gap_rpm: number;
  gap_tpm_est: number;
}

/** 平台渠道类型 → 展示配置（类型徽章色 + 模型名药丸色 + 图标）。未知类型回退 slate。 */
const PLATFORM_META: Record<
  number,
  { label: string; icon: string; badge: string; pill: string }
> = {
  14: {
    label: "Anthropic Claude",
    icon: "✳️",
    badge: "bg-amber-100 text-amber-700 ring-1 ring-amber-200",
    pill: "bg-amber-50 text-amber-600 ring-1 ring-amber-100",
  },
  41: {
    label: "Vertex AI",
    icon: "🔷",
    badge: "bg-sky-100 text-sky-700 ring-1 ring-sky-200",
    pill: "bg-sky-50 text-sky-600 ring-1 ring-sky-100",
  },
};

function platformMeta(g: GapItem) {
  return (
    PLATFORM_META[g.channel_type] ?? {
      label: g.channel_type_name || `type ${g.channel_type}`,
      icon: "📡",
      badge: "bg-slate-100 text-slate-600 ring-1 ring-slate-200",
      pill: "bg-slate-50 text-slate-500 ring-1 ring-slate-100",
    }
  );
}

/** 缺口 RPM 火苗等级：越紧缺火越多。 */
function fireLevel(rpm: number): string {
  if (rpm >= 500) return "🔥🔥";
  if (rpm >= 100) return "🔥";
  return "";
}

/** TPM 以「万」展示（÷1万，千分位）。 */
function fmtWan(n: number): string {
  return `${Math.round(n / 10000).toLocaleString("en-US")}万`;
}

/**
 * 「小请求难超刷」标记：缺口 RPM 够大但单请求平均 token 很小（如 RPM 5000 / TPM 仅 500万 ≈ 1000 token/请求）
 * → 说明多为小请求、难靠超刷补上缺口，提示考虑从模型列表移除。阈值可调。
 */
function smallReqFlag(g: GapItem): boolean {
  return g.gap_rpm >= 500 && g.gap_tpm_est / Math.max(g.gap_rpm, 1) < 2000;
}

/**
 * 模型缺口卡。endpoint 缺省走管理员接口；用户端传 "/api/my/model-gaps"。
 */
export function ModelGapCard({
  endpoint = "/api/admin/model-gaps",
}: {
  endpoint?: string;
}) {
  const [siteId, setSiteId] = useState(13); // 默认 AGT 站
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<{
    site_name: string;
    checked_at: number;
    items: GapItem[];
  } | null>(null);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      const d = await apiFetch<{
        site_name: string;
        checked_at: number;
        items: GapItem[];
      }>(`${endpoint}?site_id=${siteId}`);
      setData(d);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId]);

  const checkedLabel =
    data && data.checked_at > 0
      ? `取样 ${new Date(data.checked_at * 1000).toLocaleString("zh-CN", {
          hour12: false,
          timeZone: "Asia/Shanghai",
        })}`
      : "";

  return (
    <Card
      title="📉 模型缺口"
      subtitle={
        data
          ? `${data.site_name} · ${checkedLabel}`
          : "naci 平台各模型供给缺口（gap = 需求量 − 供应量）"
      }
      actions={
        <div className="flex items-center gap-2">
          <select
            value={siteId}
            onChange={(e) => setSiteId(Number(e.target.value))}
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700"
          >
            {GAP_SITES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          <Button onClick={load} loading={loading}>
            🔄 刷新
          </Button>
        </div>
      }
    >
      <div className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800 ring-1 ring-amber-100">
        <span className="font-semibold">说明：</span>缺口 = 需求 − 供应。若某模型「缺口 RPM
        很大但缺口 TPM 很小」（例如 RPM 5000 而 TPM 仅 500万），说明其请求多为小请求，很难靠超刷补上缺口，建议从模型列表中
        <strong>去掉该模型</strong>；
        <code className="rounded bg-amber-100 px-1">claude-opus-4-7</code>{" "}
        尤其容易出现这种情况（下方 ⚠️ 即命中该特征的模型）。
      </div>
      {error && (
        <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {error}
        </p>
      )}
      {loading && (
        <div className="flex items-center justify-center gap-2 py-8 text-slate-400">
          <Spinner /> <span className="text-sm">拉取模型缺口数据…</span>
        </div>
      )}
      {data && !loading && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                <th className="pb-2 pr-3 font-medium">类型</th>
                <th className="pb-2 pr-3 font-medium">模型名</th>
                <th className="pb-2 pr-3 text-right font-medium">缺口RPM</th>
                <th className="pb-2 text-right font-medium">缺口TPM(估)</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((g, i) => {
                const m = platformMeta(g);
                return (
                  <tr
                    key={i}
                    className="border-b border-slate-50 hover:bg-slate-50/60"
                  >
                    <td className="py-2 pr-3">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${m.badge}`}
                      >
                        <span>{m.icon}</span>
                        {m.label}
                      </span>
                    </td>
                    <td className="py-2 pr-3">
                      <span
                        className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${m.pill}`}
                      >
                        <span>{m.icon}</span>
                        {g.model_name}
                      </span>
                      {smallReqFlag(g) && (
                        <span
                          className="ml-1 cursor-help"
                          title="小请求为主、难以超刷（缺口 RPM 大但缺口 TPM 小），建议考虑从模型列表移除"
                        >
                          ⚠️
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums font-semibold text-slate-800">
                      {fireLevel(g.gap_rpm) && (
                        <span className="mr-1">{fireLevel(g.gap_rpm)}</span>
                      )}
                      {g.gap_rpm.toLocaleString("en-US")}
                    </td>
                    <td className="py-2 text-right tabular-nums text-slate-500">
                      {fmtWan(g.gap_tpm_est)}
                    </td>
                  </tr>
                );
              })}
              {data.items.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-6 text-center text-slate-400">
                    该站点暂无模型缺口数据
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
