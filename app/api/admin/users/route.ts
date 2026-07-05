import { NextRequest } from "next/server";
import { errorResponse, fail, ok, requireAdmin } from "@/lib/auth";
import { genAccessKey, genId, getUsers, upsertUser } from "@/lib/store";
import type { Role, User } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/admin/users —— 用户列表（含 accessKey，供管理员分发）。
export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);
    const users = await getUsers();
    return ok({ users });
  } catch (err) {
    return errorResponse(err);
  }
}

// POST /api/admin/users —— 新建用户，自动生成 accessKey。
export async function POST(req: NextRequest) {
  try {
    await requireAdmin(req);
    const body = (await req.json().catch(() => ({}))) as {
      username?: string;
      role?: Role;
      channelName?: string;
    };
    const username = (body.username ?? "").trim();
    const channelName = (body.channelName ?? "").trim();
    const role: Role = body.role === "admin" ? "admin" : "user";
    if (!username) return fail("用户名不能为空");

    const users = await getUsers();
    if (users.some((u) => u.username === username)) {
      return fail("用户名已存在");
    }

    const now = new Date().toISOString();
    const user: User = {
      id: genId(),
      username,
      role,
      accessKey: genAccessKey(),
      channelName,
      channelId: null,
      createdAt: now,
      updatedAt: now,
    };
    await upsertUser(user);
    return ok({ user });
  } catch (err) {
    return errorResponse(err);
  }
}
