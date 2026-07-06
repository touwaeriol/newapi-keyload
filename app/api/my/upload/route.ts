import { NextRequest } from "next/server";
import { errorResponse, fail, ok, requireUser } from "@/lib/auth";
import { parseKeys } from "@/lib/supplier";
import { enqueueKeys } from "@/lib/channelService";
import { kickEngine } from "@/lib/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/my/upload —— 调用者为自己绑定的渠道上传 key。
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const body = (await req.json().catch(() => ({}))) as {
      keys?: string | string[];
    };
    const raw = Array.isArray(body.keys) ? body.keys.join("\n") : body.keys ?? "";
    const keys = parseKeys(raw);
    if (keys.length === 0) return fail("请提供至少一个 key");

    const result = await enqueueKeys(user, keys);
    // 入队后立即 kick 引擎：若渠道正缺 key 则马上上传，不等整分钟定时轮；已有调度在跑则忽略
    kickEngine(user.channelName);
    return ok(result);
  } catch (err) {
    return errorResponse(err);
  }
}
