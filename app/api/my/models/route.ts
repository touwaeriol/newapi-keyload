import { NextRequest } from "next/server";
import { errorResponse, fail, ok, requireUser } from "@/lib/auth";
import { getConfig, upsertUser } from "@/lib/store";
import { adminEnabledModels, resolveUserModels } from "@/lib/supplier";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/my/models —— 返回调用者可选的模型集与当前所选。
//   available = 管理员启用集；selected = 该用户生效模型（未自定义时=全选 available）。
export async function GET(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const cfg = await getConfig();
    return ok({
      available: adminEnabledModels(cfg.models),
      selected: resolveUserModels(user.models, cfg.models),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

// POST /api/my/models —— 保存调用者自选模型列表。body { models: string[] }。
//   只接受 available 内的模型；至少 1 个；选满全部则存 NULL（跟随管理员默认，日后新增自动纳入）。
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const cfg = await getConfig();
    const available = adminEnabledModels(cfg.models);
    if (available.length === 0) {
      return fail("管理员尚未启用任何模型，请联系管理员");
    }

    const body = (await req.json().catch(() => ({}))) as { models?: unknown };
    const raw = Array.isArray(body.models) ? body.models.map(String) : [];
    // 交集并按 available 顺序规整，过滤越权/未知模型
    const selected = available.filter((m) => raw.includes(m));
    if (selected.length === 0) {
      return fail("请至少选择 1 个模型");
    }

    // 选满全部 → 存 NULL（跟随默认）；否则存显式子集
    user.models =
      selected.length === available.length ? null : selected.join(",");
    user.updatedAt = new Date().toISOString();
    await upsertUser(user);

    return ok({
      available,
      selected: resolveUserModels(user.models, cfg.models),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
