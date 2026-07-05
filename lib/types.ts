// 全局类型定义

export type Role = "admin" | "user";

/** 系统用户：一个用户 = 一个访问密钥 = 一个绑定渠道 */
export interface User {
  id: string;
  username: string;
  role: Role;
  /** 登录本系统使用的访问密钥（区别于 naci 平台 Bearer token） */
  accessKey: string;
  /** 管理员为该用户绑定的 naci 渠道名称（唯一标识渠道） */
  channelName: string;
  /** 已解析并缓存的 naci 渠道 id；首次上传时按名称解析后写入 */
  channelId: number | null;
  createdAt: string;
  updatedAt: string;
}

/** 系统配置：naci 平台连接信息（后端持有，前端不下发 token 明文给普通用户） */
export interface SystemConfig {
  naciBaseUrl: string;
  /** naci new-api 兼容端点的 Bearer token（个人设置页「生成令牌」得到） */
  naciToken: string;
}

export type LogLevel = "info" | "success" | "warn" | "error";

export interface LogEntry {
  id: string;
  at: string;
  level: LogLevel;
  /** 触发操作的用户名 */
  actor: string;
  /** 相关渠道名称 */
  channelName?: string;
  channelId?: number | null;
  message: string;
}

/** 上传 key 的结果 */
export interface UploadResult {
  action: "created" | "updated";
  channelId: number;
  channelName: string;
  /** 本次上传的 key 数 */
  keyCount: number;
  /** 本系统累计去重的 key 总数（naci 不返回 key 数，本地统计） */
  uploadedKeyCount: number;
  /** naci 详情返回的站点发布明细 */
  siteAmounts?: SiteAmount[];
  raw?: unknown;
}

export interface SiteAmount {
  site_id: number;
  site_name: string;
  remote_channel_id: number;
  used_quota: number;
  used_amount: number;
}

/** naci 渠道对象（列表/详情，部分字段） */
export interface NaciChannel {
  id: number;
  name: string;
  type: number;
  models: string;
  group: string;
  priority: number;
  weight?: number;
  auto_ban?: number;
  used_quota?: number;
  used_amount?: number;
  site_amounts?: SiteAmount[];
  [k: string]: unknown;
}

/** 前端安全用户视图（不含 accessKey 明文，除非管理员查看） */
export interface SafeUser extends Omit<User, "accessKey"> {
  accessKey?: string;
}
