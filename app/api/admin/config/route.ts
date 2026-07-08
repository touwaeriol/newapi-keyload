import { NextRequest } from "next/server";
import { errorResponse, fail, ok, requireAdmin } from "@/lib/auth";
import { getConfig, saveConfig } from "@/lib/store";

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
      priorityTaskIntervalMinutes: cfg.priorityTaskIntervalMinutes,
      demoteGraceMinutes: cfg.demoteGraceMinutes,
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
      priorityTaskIntervalMinutes?: number;
      demoteGraceMinutes?: number;
    };
    const naciBaseUrl = (body.naciBaseUrl ?? "").trim();
    if (!naciBaseUrl) return fail("naciBaseUrl 不能为空");

    const current = await getConfig();
    // 未传或为空则保留原值；saveConfig 内部会再兜底默认
    const models =
      typeof body.models === "string" && body.models.trim()
        ? body.models.trim()
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
    // 未传则保留原值；由 store.saveConfig 内部钳制到 1~1440 分钟
    const priorityTaskIntervalMinutes =
      body.priorityTaskIntervalMinutes == null
        ? current.priorityTaskIntervalMinutes
        : body.priorityTaskIntervalMinutes;
    // 未传则保留原值；由 store.saveConfig 内部钳制到 0~1440 分钟
    const demoteGraceMinutes =
      body.demoteGraceMinutes == null
        ? current.demoteGraceMinutes
        : body.demoteGraceMinutes;

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
      priorityTaskIntervalMinutes,
      demoteGraceMinutes,
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
      priorityTaskIntervalMinutes: saved.priorityTaskIntervalMinutes,
      demoteGraceMinutes: saved.demoteGraceMinutes,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
