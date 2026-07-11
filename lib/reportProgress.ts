// 报表生成进度（内存版）：下载路由按前端随请求带来的 jobId 上报「拉列表/补用量」进度，
// /api/report-progress 轮询端点按 jobId+用户读取。单实例部署（引擎同进程）内存 Map 足够；
// 条目 10 分钟自动过期 + 总量上限，防止长期运行泄漏。
type ReportPhase = "search" | "enrich" | "done";

export interface ReportProgress {
  phase: ReportPhase;
  /** 当前阶段已处理数（search=已拉到的渠道数，enrich=已补完用量的渠道数） */
  done: number;
  /** 当前阶段总数（search=平台命中总数，enrich=进报表的渠道数）；0=尚未知 */
  total: number;
}

interface Entry extends ReportProgress {
  userId: string;
  updatedAt: number;
}

const TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 1000;

// 挂 globalThis：dev 热重载/多次 import 共享同一张表
const g = globalThis as unknown as { __reportProgressStore?: Map<string, Entry> };
const store: Map<string, Entry> = (g.__reportProgressStore ??= new Map());

function sweep(): void {
  const now = Date.now();
  for (const [k, v] of store) {
    if (now - v.updatedAt > TTL_MS) store.delete(k);
  }
}

export function updateReportProgress(
  jobId: string,
  userId: string,
  phase: ReportPhase,
  done: number,
  total: number
): void {
  if (!jobId) return;
  sweep();
  if (!store.has(jobId) && store.size >= MAX_ENTRIES) return;
  store.set(jobId, { userId, phase, done, total, updatedAt: Date.now() });
}

/** 只允许创建该 job 的用户读取；未知/过期/他人 job 返回 null。 */
export function getReportProgress(
  jobId: string,
  userId: string
): ReportProgress | null {
  sweep();
  const e = store.get(jobId);
  if (!e || e.userId !== userId) return null;
  return { phase: e.phase, done: e.done, total: e.total };
}
