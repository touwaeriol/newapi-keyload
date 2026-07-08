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
  /** 平台上该渠道的真实 key 数缓存（上传/重开站点后落库，供 GET 展示复用） */
  platformKeyCount?: number | null;
  /** 平台上被禁用（status=3）的 key 数缓存 */
  deadKeyCount?: number | null;
  /** 所有已建渠道的聚合已用额度缓存（naci used-quota，单位同平台 quota；÷QUOTA_PER_USD=美元） */
  usedQuota?: number | null;
  createdAt: string;
  updatedAt: string;
}

/** 系统配置：naci 平台连接信息（后端持有，前端不下发凭据明文给普通用户） */
export interface SystemConfig {
  naciBaseUrl: string;
  /** admin-hub 登录用户名（后端用其登录拿 session），只从数据库配置读取 */
  naciUsername?: string;
  /** admin-hub 登录密码，只从数据库配置读取；不回传明文 */
  naciPassword?: string;
  /** 旧 new-api 兼容端点的 Bearer token（可选；转向 admin-hub 后保留兼容，非必填） */
  naciToken?: string;
  /** 新建渠道使用的模型列表（逗号分隔，管理员可配；默认 3 个 opus）。 */
  models: string;
  /** 聚合 key 数量：每个新建渠道里聚合多少个 key（1~1000）。 */
  uploadBatchSize: number;
  /** 每批处理数量：定时任务每轮 / 直接上传每次处理多少个 key，拆成 ⌈处理数/聚合数⌉ 个渠道（1~10000）。 */
  processBatchSize: number;
  /** 是否启用自动补 key（定时引擎每 N 分钟从本地池按需补给） */
  autoRefillEnabled: boolean;
  /** 定时引擎补给间隔（分钟，1~1440）；改动下一轮生效，无需重启 */
  refillIntervalMinutes: number;
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
  /** 上传并重开站点后，平台上该渠道的真实 key 数（multi_key_size） */
  platformKeyCount?: number;
  /** 被禁用（status=3）的 key 数 */
  deadKeyCount?: number;
  raw?: unknown;
}

export interface SiteAmount {
  site_id: number;
  site_name: string;
  remote_channel_id: number;
  used_quota: number;
  used_amount: number;
}

/**
 * 平台上单个渠道的 key 统计（来自 admin-hub status 响应或渠道 channel_info）。
 * multi_key_status_list 每项为一个 key 的状态：3 = 自动禁用。
 */
export interface KeyStats {
  /** 平台上该渠道的真实 key 数（multi_key_size） */
  platformKeyCount: number;
  /** 被禁用（status=3）的 key 数 */
  deadKeyCount: number;
  /** 每个 key 的状态列表（multi_key_status_list） */
  statusList: number[];
}

/**
 * naci 渠道对象（admin-hub 列表/详情）。
 * admin-hub 顶层字段：id / name / channel_json(字符串) / last_selected_site_ids_json /
 * site_group_overrides / owner_user_id / used_quota 等；
 * lib/naci.ts 归一化时会把 channel_json 内部字段（models/group/priority/type/status…）
 * 展开到顶层，方便消费方直接访问。
 */
export interface NaciChannel {
  id: number;
  name: string;
  type: number;
  models: string;
  group: string;
  priority: number;
  status?: number;
  weight?: number;
  auto_ban?: number;
  used_quota?: number;
  used_amount?: number;
  site_amounts?: SiteAmount[];
  /** admin-hub 原始 channel_json 字符串 */
  channelJson?: string;
  /** 解析后的 channel_json 对象 */
  channelJsonObj?: Record<string, unknown>;
  /** admin-hub 站点顺序字符串（如 "[21,13,6]"） */
  lastSelectedSiteIdsJson?: string;
  /** admin-hub 各站点分组覆盖 */
  siteGroupOverrides?: Record<string, string[]>;
  /** 渠道归属供应商账号 id */
  ownerUserId?: number;
  [k: string]: unknown;
}

/** 前端安全用户视图（不含 accessKey 明文，除非管理员查看） */
export interface SafeUser extends Omit<User, "accessKey"> {
  accessKey?: string;
}
