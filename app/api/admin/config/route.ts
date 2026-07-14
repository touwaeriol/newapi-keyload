import { NextRequest } from "next/server";
import { errorResponse, fail, ok, requireAdmin } from "@/lib/auth";
import { getConfig, saveConfig } from "@/lib/store";
import { adminEnabledModels } from "@/lib/supplier";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/admin/config —— 读取 naci 连接配置。
// 出于安全，密码与 token 均不回传明文，仅返回是否已设置（hasNaciPassword / hasNaciToken）。
export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);
    const cfg = await getConfig();
    return ok({
      naciBaseUrl: cfg.naciBaseUrl,
      naciUsername: cfg.naciUsername,
      hasNaciPassword: Boolean(cfg.naciPassword),
      hasNaciToken: Boolean(cfg.naciToken),
      models: cfg.models,
      uploadBatchSize: cfg.uploadBatchSize,
      processBatchSize: cfg.processBatchSize,
      autoRefillEnabled: cfg.autoRefillEnabled,
      refillIntervalMinutes: cfg.refillIntervalMinutes,
      priority6Limit: cfg.priority6Limit,
      demoteIntervalSeconds: cfg.demoteIntervalSeconds,
      demoteGraceSeconds: cfg.demoteGraceSeconds,
      usageRefreshIntervalMinutes: cfg.usageRefreshIntervalMinutes,
      usageMaxUpdates: cfg.usageMaxUpdates,
      globalUploadLimitCount: cfg.globalUploadLimitCount,
      globalUploadLimitWindowMinutes: cfg.globalUploadLimitWindowMinutes,
      userUploadLimitCount: cfg.userUploadLimitCount,
      userUploadLimitWindowMinutes: cfg.userUploadLimitWindowMinutes,
      userManualUploadEnabled: cfg.userManualUploadEnabled,
      onlyHighPriorityEnabled: cfg.onlyHighPriorityEnabled,
      uploadDisabled: cfg.uploadDisabled,
      userQueryIntervalSeconds: cfg.userQueryIntervalSeconds,
      userReportIntervalMinutes: cfg.userReportIntervalMinutes,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

// PUT /api/admin/config —— 保存 naci 连接配置。
// naciPassword / naciToken 留空表示保持原值不变（GET 不回传明文，前端读到空值不应清库）。
export async function PUT(req: NextRequest) {
  try {
    await requireAdmin(req);
    const body = (await req.json().catch(() => ({}))) as {
      naciBaseUrl?: string;
      naciUsername?: string;
      naciPassword?: string;
      naciToken?: string;
      models?: string;
      uploadBatchSize?: number;
      processBatchSize?: number;
      autoRefillEnabled?: boolean;
      refillIntervalMinutes?: number;
      priority6Limit?: number;
      demoteIntervalSeconds?: number;
      demoteGraceSeconds?: number;
      usageRefreshIntervalMinutes?: number;
      usageMaxUpdates?: number;
      globalUploadLimitCount?: number;
      globalUploadLimitWindowMinutes?: number;
      userUploadLimitCount?: number;
      userUploadLimitWindowMinutes?: number;
      userManualUploadEnabled?: boolean;
      onlyHighPriorityEnabled?: boolean;
      uploadDisabled?: boolean;
      userQueryIntervalSeconds?: number;
      userReportIntervalMinutes?: number;
    };
    const naciBaseUrl = (body.naciBaseUrl ?? "").trim();
    if (!naciBaseUrl) return fail("naciBaseUrl 不能为空");

    const current = await getConfig();
    // 模型：仅接受 ALLOWED_MODELS 内的项（按标准顺序规整）；空/全非法则保留原值，不清库
    const models =
      typeof body.models === "string"
        ? adminEnabledModels(body.models).join(",") || current.models
        : current.models;
    const naciUsername = (body.naciUsername ?? current.naciUsername ?? "").trim();
    const naciPassword =
      body.naciPassword && body.naciPassword.length > 0
        ? body.naciPassword
        : current.naciPassword ?? "";
    const naciToken =
      body.naciToken && body.naciToken.trim().length > 0
        ? body.naciToken.trim()
        : current.naciToken ?? "";
    // 未传则保留原值；batch 由 store.saveConfig 内部钳制到 1~1000
    const uploadBatchSize =
      body.uploadBatchSize == null
        ? current.uploadBatchSize
        : body.uploadBatchSize;
    // 未传则保留原值；由 store.saveConfig 内部钳制到 1~10000
    const processBatchSize =
      body.processBatchSize == null
        ? current.processBatchSize
        : body.processBatchSize;
    const autoRefillEnabled =
      typeof body.autoRefillEnabled === "boolean"
        ? body.autoRefillEnabled
        : current.autoRefillEnabled;
    // 未传则保留原值；间隔由 store.saveConfig 内部钳制到 1~1440 分钟
    const refillIntervalMinutes =
      body.refillIntervalMinutes == null
        ? current.refillIntervalMinutes
        : body.refillIntervalMinutes;
    // 未传则保留原值；由 store.saveConfig 内部钳制到 0~1000
    const priority6Limit =
      body.priority6Limit == null
        ? current.priority6Limit
        : body.priority6Limit;
    // 未传则保留原值；由 store.saveConfig 内部钳制到 5~86400 秒
    const demoteIntervalSeconds =
      body.demoteIntervalSeconds == null
        ? current.demoteIntervalSeconds
        : body.demoteIntervalSeconds;
    // 未传则保留原值；由 store.saveConfig 内部钳制到 0~86400 秒
    const demoteGraceSeconds =
      body.demoteGraceSeconds == null
        ? current.demoteGraceSeconds
        : body.demoteGraceSeconds;
    // 用量刷新：频率(1~1440 分钟) + 每渠道最多刷新次数(0~100)
    const usageRefreshIntervalMinutes =
      body.usageRefreshIntervalMinutes == null
        ? current.usageRefreshIntervalMinutes
        : body.usageRefreshIntervalMinutes;
    const usageMaxUpdates =
      body.usageMaxUpdates == null
        ? current.usageMaxUpdates
        : body.usageMaxUpdates;
    // 上传限速 4 项：未传则保留原值；个数钳制 0~1000000（0=不限速），窗口钳制 1~1440 分钟
    const globalUploadLimitCount =
      body.globalUploadLimitCount == null
        ? current.globalUploadLimitCount
        : body.globalUploadLimitCount;
    const globalUploadLimitWindowMinutes =
      body.globalUploadLimitWindowMinutes == null
        ? current.globalUploadLimitWindowMinutes
        : body.globalUploadLimitWindowMinutes;
    const userUploadLimitCount =
      body.userUploadLimitCount == null
        ? current.userUploadLimitCount
        : body.userUploadLimitCount;
    const userUploadLimitWindowMinutes =
      body.userUploadLimitWindowMinutes == null
        ? current.userUploadLimitWindowMinutes
        : body.userUploadLimitWindowMinutes;
    const userManualUploadEnabled =
      typeof body.userManualUploadEnabled === "boolean"
        ? body.userManualUploadEnabled
        : current.userManualUploadEnabled;
    const onlyHighPriorityEnabled =
      typeof body.onlyHighPriorityEnabled === "boolean"
        ? body.onlyHighPriorityEnabled
        : current.onlyHighPriorityEnabled;
    const uploadDisabled =
      typeof body.uploadDisabled === "boolean"
        ? body.uploadDisabled
        : current.uploadDisabled;
    // 用户查询/报表限流：未传则保留原值；由 store.saveConfig 内部钳制（0=不限）
    const userQueryIntervalSeconds =
      body.userQueryIntervalSeconds == null
        ? current.userQueryIntervalSeconds
        : body.userQueryIntervalSeconds;
    const userReportIntervalMinutes =
      body.userReportIntervalMinutes == null
        ? current.userReportIntervalMinutes
        : body.userReportIntervalMinutes;

    await saveConfig({
      naciBaseUrl,
      naciUsername,
      naciPassword,
      naciToken,
      models,
      uploadBatchSize,
      processBatchSize,
      autoRefillEnabled,
      refillIntervalMinutes,
      priority6Limit,
      demoteIntervalSeconds,
      demoteGraceSeconds,
      usageRefreshIntervalMinutes,
      usageMaxUpdates,
      globalUploadLimitCount,
      globalUploadLimitWindowMinutes,
      userUploadLimitCount,
      userUploadLimitWindowMinutes,
      userManualUploadEnabled,
      onlyHighPriorityEnabled,
      uploadDisabled,
      userQueryIntervalSeconds,
      userReportIntervalMinutes,
    });
    // 回读钳制后的最终值返回
    const saved = await getConfig();
    return ok({
      naciBaseUrl,
      naciUsername,
      hasNaciPassword: Boolean(naciPassword),
      hasNaciToken: Boolean(naciToken),
      models: saved.models,
      uploadBatchSize: saved.uploadBatchSize,
      processBatchSize: saved.processBatchSize,
      autoRefillEnabled: saved.autoRefillEnabled,
      refillIntervalMinutes: saved.refillIntervalMinutes,
      priority6Limit: saved.priority6Limit,
      demoteIntervalSeconds: saved.demoteIntervalSeconds,
      demoteGraceSeconds: saved.demoteGraceSeconds,
      usageRefreshIntervalMinutes: saved.usageRefreshIntervalMinutes,
      usageMaxUpdates: saved.usageMaxUpdates,
      globalUploadLimitCount: saved.globalUploadLimitCount,
      globalUploadLimitWindowMinutes: saved.globalUploadLimitWindowMinutes,
      userUploadLimitCount: saved.userUploadLimitCount,
      userUploadLimitWindowMinutes: saved.userUploadLimitWindowMinutes,
      userManualUploadEnabled: saved.userManualUploadEnabled,
      onlyHighPriorityEnabled: saved.onlyHighPriorityEnabled,
      uploadDisabled: saved.uploadDisabled,
      userQueryIntervalSeconds: saved.userQueryIntervalSeconds,
      userReportIntervalMinutes: saved.userReportIntervalMinutes,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
