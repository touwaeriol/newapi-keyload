import { NextRequest } from "next/server";
import { errorResponse, fail, ok, requireUser } from "@/lib/auth";
import { parseKeys } from "@/lib/supplier";
import { directUploadKeys } from "@/lib/channelService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/my/upload-direct —— 调用者为自己绑定的渠道「直接上传」key：
// 跳过定时队列，立即推送到站点（仍会先落本地库去重）。
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const body = (await req.json().catch(() => ({}))) as {
      keys?: string | string[];
    };
    const raw = Array.isArray(body.keys) ? body.keys.join("\n") : body.keys ?? "";
    const keys = parseKeys(raw);
    if (keys.length === 0) return fail("请提供至少一个 key");

    const result = await directUploadKeys(user, keys);
    return ok(result);
  } catch (err) {
    return errorResponse(err);
  }
}
