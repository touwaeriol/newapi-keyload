import { NextRequest } from "next/server";
import { errorResponse, fail, ok, requireAdmin } from "@/lib/auth";
import { findUserById } from "@/lib/store";
import { parseKeys } from "@/lib/supplier";
import { directUploadKeys } from "@/lib/channelService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/admin/users/[id]/upload-direct —— 管理员代指定用户「直接上传」key：
// 跳过定时队列，把本批 key 立即推送到站点（仍会先落本地库去重）。
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    await requireAdmin(req);
    const target = await findUserById(params.id);
    if (!target) return fail("用户不存在", 404);

    const body = (await req.json().catch(() => ({}))) as {
      keys?: string | string[];
    };
    const raw = Array.isArray(body.keys) ? body.keys.join("\n") : body.keys ?? "";
    const keys = parseKeys(raw);
    if (keys.length === 0) return fail("请提供至少一个 key");

    const result = await directUploadKeys(target, keys);
    return ok(result);
  } catch (err) {
    return errorResponse(err);
  }
}
