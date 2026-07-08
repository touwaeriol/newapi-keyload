// 请求鉴权：从请求头取访问密钥，匹配用户身份与角色。
import { NextRequest, NextResponse } from "next/server";
import type { Role, User } from "./types";
import { findUserByKey } from "./store";

export const ACCESS_KEY_HEADER = "x-access-key";

export function extractKey(req: NextRequest): string {
  const h = req.headers.get(ACCESS_KEY_HEADER);
  if (h) return h.trim();
  // 兼容 Authorization: Bearer <key>
  const auth = req.headers.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  return "";
}

export class AuthError extends Error {
  status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.status = status;
  }
}

/** 解析当前请求用户；无效密钥抛 AuthError(401) */
export async function requireUser(req: NextRequest): Promise<User> {
  const key = extractKey(req);
  if (!key) throw new AuthError("缺少访问密钥", 401);
  const user = await findUserByKey(key);
  if (!user) throw new AuthError("访问密钥无效", 401);
  return user;
}

/** 要求管理员角色 */
export async function requireAdmin(req: NextRequest): Promise<User> {
  const user = await requireUser(req);
  if (user.role !== "admin") throw new AuthError("需要管理员权限", 403);
  return user;
}

/** 要求指定角色 */
export async function requireRole(req: NextRequest, role: Role): Promise<User> {
  const user = await requireUser(req);
  if (user.role !== role) throw new AuthError("角色权限不足", 403);
  return user;
}

/** 统一把 AuthError 转成响应；其他错误 500 */
export function errorResponse(err: unknown): NextResponse {
  if (err instanceof AuthError) {
    return NextResponse.json(
      { success: false, message: err.message },
      { status: err.status }
    );
  }
  // 未预期错误：记服务端日志，并把可读消息透传给前端（多为 naci 平台返回的业务错误，
  // 如「今日渠道创建数量已达上限 200 个」），便于用户直接看懂原因。非 Error 才用兜底文案。
  console.error("[api] 未处理错误:", err);
  const message =
    err instanceof Error && err.message ? err.message : "服务器内部错误";
  return NextResponse.json({ success: false, message }, { status: 500 });
}

export function ok(data: unknown = {}) {
  return NextResponse.json({ success: true, message: "", data });
}

export function fail(message: string, status = 400) {
  return NextResponse.json({ success: false, message }, { status });
}
