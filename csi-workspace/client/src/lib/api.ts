/** Typed fetch wrapper. All state-changing calls send the CSRF header the server requires. */
export class ApiError extends Error {
  constructor(public status: number, message: string, public fields: Record<string, string> = {}) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

function qs(q?: Query) {
  if (!q) return "";
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: () => void) => (onUnauthorized = fn);

async function request<T>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
  const res = await fetch(`/api${path}${qs(query)}`, {
    method,
    credentials: "same-origin",
    headers: { "x-csi-request": "1", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && onUnauthorized) onUnauthorized();
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const d = (data ?? {}) as { error?: string; details?: { fields?: Record<string, string> } };
    throw new ApiError(res.status, d.error || `Request failed (${res.status})`, d.details?.fields ?? {});
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, query?: Query) => request<T>("GET", path, undefined, query),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body ?? {}),
  del: <T>(path: string) => request<T>("DELETE", path),
};

/** Auth endpoints live outside /api. */
export async function authPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/auth${path}`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-csi-request": "1" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || "Request failed", data.details?.fields ?? {});
  return data as T;
}
export async function authGet<T>(path: string): Promise<T> {
  const res = await fetch(`/auth${path}`, { credentials: "same-origin" });
  return (await res.json()) as T;
}

/** Download helper for CSV/HTML exports served by the API (keeps cookies). */
export function downloadUrl(path: string, query?: Query) {
  return `/api${path}${qs(query)}`;
}
