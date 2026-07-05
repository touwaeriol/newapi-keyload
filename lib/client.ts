// 客户端 fetch 封装：注入 x-access-key，解析统一响应 {success,message,data}，只暴露 data。
// 访问密钥来源：内存优先（本次会话缓存），回退 localStorage("akl.accessKey")。

const STORAGE_KEY = "akl.accessKey";

/** 内存缓存的访问密钥；避免每次都读 localStorage，也支持「不记住本机」场景 */
let memKey: string | null = null;

/** 读取当前访问密钥：内存优先，回退 localStorage */
export function getStoredKey(): string | null {
  if (memKey) return memKey;
  if (typeof window !== "undefined") {
    const k = window.localStorage.getItem(STORAGE_KEY);
    if (k) {
      memKey = k;
      return k;
    }
  }
  return null;
}

/** 写入访问密钥。remember=true 时持久化到 localStorage，否则仅本次会话内存有效 */
export function setStoredKey(k: string, remember: boolean): void {
  memKey = k;
  if (typeof window === "undefined") return;
  if (remember) window.localStorage.setItem(STORAGE_KEY, k);
  else window.localStorage.removeItem(STORAGE_KEY);
}

/** 清除访问密钥（退出登录） */
export function clearStoredKey(): void {
  memKey = null;
  if (typeof window !== "undefined") window.localStorage.removeItem(STORAGE_KEY);
}

interface ApiEnvelope<T> {
  success: boolean;
  message: string;
  data: T;
}

/**
 * 统一请求封装。自动注入 x-access-key 与 JSON Content-Type；
 * success=false 时抛出 Error(message)，成功返回 data。
 */
export async function apiFetch<T = unknown>(
  path: string,
  opts: RequestInit = {}
): Promise<T> {
  const key = getStoredKey();
  const headers = new Headers(opts.headers);
  if (key) headers.set("x-access-key", key);
  if (opts.body != null && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const res = await fetch(path, { ...opts, headers });

  let json: ApiEnvelope<T> | null = null;
  try {
    json = (await res.json()) as ApiEnvelope<T>;
  } catch {
    throw new Error(`请求失败 (HTTP ${res.status})`);
  }

  if (!json || json.success === false) {
    throw new Error(json?.message || `请求失败 (HTTP ${res.status})`);
  }
  return json.data;
}
