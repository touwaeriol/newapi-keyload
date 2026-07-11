import { NextRequest } from "next/server";
import { errorResponse, fail, ok, requireAdmin } from "@/lib/auth";
import {
  deleteUser,
  findUserById,
  genAccessKey,
  getUsers,
  normalizeCustomAccessKey,
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
      /** 单用户上传限速覆盖：数字=覆盖（个数 0=不限速），显式 null=清除回全局默认，未传=不动 */
      uploadLimitCount?: number | null;
      uploadLimitWindowMinutes?: number | null;
      /** 是否允许高优先级渠道；未传=不动 */
      allowHighPriority?: boolean;
      /** 独立优先级6数量上限：数字=设定（≥0），显式 null=清除（仅受全局），未传=不动 */
      highPriorityLimit?: number | null;
      /** 单独关闭该用户上传权限；未传=不动 */
      uploadDisabled?: boolean;
      /** 自定义访问密钥：填写=改成此值（校验+查重），留空/未传=不改（除非 regenerateKey） */
      accessKey?: string;
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
      // 渠道名全局唯一：不同用户绑同名渠道会跨用户共享/看到彼此日志
      if (nextName && nextName !== target.channelName) {
        const users = await getUsers();
        if (users.some((u) => u.channelName === nextName && u.id !== target.id)) {
          return fail("该渠道名已被其他用户绑定");
        }
      }
      // 渠道名变化时清空已缓存的 channelId，避免指向旧渠道
      if (nextName !== target.channelName) {
        target.channelName = nextName;
        target.channelId = null;
      }
    }

    // 单用户上传限速覆盖：区分「未传」（保持原值）与「显式 null」（清除覆盖，回全局默认）
    if ("uploadLimitCount" in body) {
      if (body.uploadLimitCount == null) {
        target.uploadLimitCount = null;
      } else {
        const v = Math.floor(Number(body.uploadLimitCount));
        if (!Number.isFinite(v) || v < 0) {
          return fail("上传限速·个数需为 ≥0 的整数（0=不限速）");
        }
        target.uploadLimitCount = Math.min(v, 1_000_000);
      }
    }
    if ("uploadLimitWindowMinutes" in body) {
      if (body.uploadLimitWindowMinutes == null) {
        target.uploadLimitWindowMinutes = null;
      } else {
        const v = Math.floor(Number(body.uploadLimitWindowMinutes));
        if (!Number.isFinite(v) || v < 1 || v > 1440) {
          return fail("上传限速·窗口需为 1~1440 分钟");
        }
        target.uploadLimitWindowMinutes = v;
      }
    }

    // 按用户高优先级配额
    if (typeof body.allowHighPriority === "boolean") {
      target.allowHighPriority = body.allowHighPriority;
    }
    if ("highPriorityLimit" in body) {
      if (body.highPriorityLimit == null) {
        target.highPriorityLimit = null;
      } else {
        const v = Math.floor(Number(body.highPriorityLimit));
        if (!Number.isFinite(v) || v < 0) {
          return fail("独立优先级6数量需为 ≥0 的整数");
        }
        target.highPriorityLimit = Math.min(v, 1000);
      }
    }

    if (typeof body.uploadDisabled === "boolean") {
      target.uploadDisabled = body.uploadDisabled;
    }

    // 访问密钥：自定义优先（校验+排他查重），否则 regenerateKey 随机重置，否则不动
    if (typeof body.accessKey === "string" && body.accessKey.trim() !== "") {
      const r = normalizeCustomAccessKey(body.accessKey);
      if ("error" in r) return fail(r.error);
      const users = await getUsers();
      if (users.some((u) => u.accessKey === r.value && u.id !== target.id)) {
        return fail("该访问密钥已被占用，请换一个");
      }
      target.accessKey = r.value;
    } else if (body.regenerateKey) {
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
