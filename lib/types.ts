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
  /** 单用户上传限速·个数覆盖（窗口内最多上传 key 数，0=不限；NULL=跟随全局默认） */
  uploadLimitCount?: number | null;
  /** 单用户上传限速·窗口分钟覆盖（NULL=跟随全局默认） */
  uploadLimitWindowMinutes?: number | null;
  /** 是否允许该用户使用高优先级（优先级6）渠道（默认 true）。false=其新渠道一律优先级5 */
  allowHighPriority?: boolean;
  /** 该用户可占用的优先级6渠道数量上限（全局6的子上限；NULL=不设独立上限，仅受全局约束） */
  highPriorityLimit?: number | null;
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
  /**
   * 优先级 6 渠道数量上限（naci 账号配额，默认 6）。建渠道前**本地**统计已建优先级 6 渠道数，
   * 达到此上限即直接用优先级 5 创建，避免服务器返回「优先级6已达到最多6个启用渠道限制」。
   */
  priority6Limit: number;
  /**
   * 优先级对账定时任务间隔（分钟，1~1440）：**全局**单任务定期把本地优先级与 naci 实际值对账，
   * 修正静默降级漂移；退化降级检测由独立快循环按秒执行。
   */
  priorityTaskIntervalMinutes: number;
  /**
   * 退化降级检测间隔（秒，5~86400）：独立快循环每 N 秒用一次 status-batch 读高优先级渠道状态，
   * 任一站点禁用即降到 5。下限 5s 防止打爆 naci。
   */
  demoteIntervalSeconds: number;
  /**
   * 退化判定宽限期（秒，0~86400）：渠道创建后需超过此时长才纳入降级判定，
   * 避免刚建、站点尚未就绪时被误判降级。0=不设宽限，建后即可被判定。
   */
  demoteGraceSeconds: number;
  /**
   * 用量刷新频率（分钟，1~1440）：后台任务每 N 分钟批量拉一次 used-quota 更新渠道用量缓存。
   */
  usageRefreshIntervalMinutes: number;
  /**
   * 每渠道最多刷新用量次数（0~100）：某渠道刷够此次数即冻结、不再拉 used-quota，避免雪崩。0=不刷新用量。
   */
  usageMaxUpdates: number;
  /** 全局上传限速：窗口内最多上传（推站点）多少个 key（0=不限速） */
  globalUploadLimitCount: number;
  /** 全局上传限速窗口（分钟，1~1440） */
  globalUploadLimitWindowMinutes: number;
  /** 用户默认上传限速：每个用户窗口内最多上传多少个 key（0=不限速；可被单用户覆盖） */
  userUploadLimitCount: number;
  /** 用户默认上传限速窗口（分钟，1~1440；可被单用户覆盖） */
  userUploadLimitWindowMinutes: number;
  /** 是否允许普通用户手动上传（「上传一批」「直接上传」）。false=只能录入本地库，由引擎自动推站点 */
  userManualUploadEnabled: boolean;
  /**
   * 仅使用高优先级渠道模式：开启后**只在有空闲优先级6名额时**才建渠道（强制优先级6，不降级到5），
   * 名额满则 key 留池等待降级任务回收后再建；多用户竞争时空闲名额按轮转公平分配。
   */
  onlyHighPriorityEnabled: boolean;
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
