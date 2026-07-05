import { NextRequest } from "next/server";
import { errorResponse, ok, requireUser } from "@/lib/auth";
import type { SafeUser } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/me —— 返回当前访问密钥对应的用户（不含 accessKey），供登录校验。
export async function GET(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const { accessKey, ...safe } = user;
    return ok({ user: safe as SafeUser });
  } catch (err) {
    return errorResponse(err);
  }
}
