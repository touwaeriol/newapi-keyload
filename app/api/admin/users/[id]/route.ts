import { NextRequest } from "next/server";
import { errorResponse, fail, ok, requireAdmin } from "@/lib/auth";
import {
  deleteUser,
  findUserById,
  genAccessKey,
  getUsers,
  upsertUser,
} from "@/lib/store";
import type { Role } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PUT /api/admin/users/[id] —— 修改用户属性 / 重置密钥。
export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    await requireAdmin(req);
    const target = await findUserById(params.id);
    if (!target) return fail("用户不存在", 404);

    const body = (await req.json().catch(() => ({}))) as {
      username?: string;
      role?: Role;
      channelName?: string;
      regenerateKey?: boolean;
    };

    if (typeof body.username === "string") {
      const username = body.username.trim();
      if (!username) return fail("用户名不能为空");
      const users = await getUsers();
      if (users.some((u) => u.username === username && u.id !== target.id)) {
        return fail("用户名已存在");
      }
      target.username = username;
    }

    if (body.role === "admin" || body.role === "user") {
      // 防止把最后一个 admin 降级为普通用户
      if (target.role === "admin" && body.role === "user") {
        const users = await getUsers();
        const adminCount = users.filter((u) => u.role === "admin").length;
        if (adminCount <= 1) return fail("至少保留一个管理员");
      }
      target.role = body.role;
    }

    if (typeof body.channelName === "string") {
      const nextName = body.channelName.trim();
      // 渠道名变化时清空已缓存的 channelId，避免指向旧渠道
      if (nextName !== target.channelName) {
        target.channelName = nextName;
        target.channelId = null;
      }
    }

    if (body.regenerateKey) {
      target.accessKey = genAccessKey();
    }

    target.updatedAt = new Date().toISOString();
    await upsertUser(target);
    return ok({ user: target });
  } catch (err) {
    return errorResponse(err);
  }
}

// DELETE /api/admin/users/[id] —— 删除用户（禁止删最后一个 admin / 删自己）。
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const me = await requireAdmin(req);
    const target = await findUserById(params.id);
    if (!target) return fail("用户不存在", 404);

    if (target.id === me.id) return fail("不能删除当前登录的自己");

    if (target.role === "admin") {
      const users = await getUsers();
      const adminCount = users.filter((u) => u.role === "admin").length;
      if (adminCount <= 1) return fail("不能删除最后一个管理员");
    }

    await deleteUser(target.id);
    return ok({ id: target.id });
  } catch (err) {
    return errorResponse(err);
  }
}
