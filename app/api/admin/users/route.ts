import { NextRequest } from "next/server";
import { errorResponse, fail, ok, requireAdmin } from "@/lib/auth";
import {
  createdChannelCountsAll,
  genAccessKey,
  genId,
  getUsers,
  normalizeCustomAccessKey,
  poolCountsAll,
  upsertUser,
} from "@/lib/store";
import { QUOTA_PER_USD } from "@/lib/naci";
import type { Role, User } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/admin/users —— 用户列表（含 accessKey 供分发，附本地池 pending/uploaded 概览）。
export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);
    const [users, poolMap, createdMap] = await Promise.all([
      getUsers(),
      poolCountsAll(),
      createdChannelCountsAll(),
    ]);
    const withPool = users.map((u) => {
      const p = poolMap[u.channelName] ?? { pending: 0, uploaded: 0 };
      return {
        ...u,
        poolPending: p.pending,
        poolUploaded: p.uploaded,
        createdChannelCount: createdMap[u.channelName] ?? 0,
        // 累计金额（美元）：由缓存的聚合 used_quota 换算，缺失则为 null（前端显示「-」）。
        usedAmount:
          u.usedQuota == null ? null : u.usedQuota / QUOTA_PER_USD,
      };
    });
    return ok({ users: withPool });
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
      /** 可选自定义访问密钥；留空/未传=自动生成 */
      accessKey?: string;
    };
    const username = (body.username ?? "").trim();
    const channelName = (body.channelName ?? "").trim();
    const role: Role = body.role === "admin" ? "admin" : "user";
    if (!username) return fail("用户名不能为空");

    const users = await getUsers();
    if (users.some((u) => u.username === username)) {
      return fail("用户名已存在");
    }
    // 渠道名全局唯一：不同用户绑同名渠道会跨用户共享/看到彼此日志
    if (channelName && users.some((u) => u.channelName === channelName)) {
      return fail("该渠道名已被其他用户绑定");
    }

    // 访问密钥：管理员填了就用自定义（校验+查重），否则自动生成
    let accessKey = genAccessKey();
    if (typeof body.accessKey === "string" && body.accessKey.trim() !== "") {
      const r = normalizeCustomAccessKey(body.accessKey);
      if ("error" in r) return fail(r.error);
      if (users.some((u) => u.accessKey === r.value)) {
        return fail("该访问密钥已被占用，请换一个");
      }
      accessKey = r.value;
    }

    const now = new Date().toISOString();
    const user: User = {
      id: genId(),
      username,
      role,
      accessKey,
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
