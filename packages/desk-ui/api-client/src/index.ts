export type Envelope<T> = {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; details?: unknown } | string;
  meta?: Record<string, unknown>;
};

export type ApiClientOptions = {
  tokenKey?: string;
  getToken?: () => string;
  setToken?: (t: string) => void;
  baseUrl?: string;
};

export function createApiClient(opts: ApiClientOptions = {}) {
  const tokenKey = opts.tokenKey ?? "desk_agent_token";
  const getToken =
    opts.getToken ??
    (() => (typeof localStorage !== "undefined" ? localStorage.getItem(tokenKey) || "" : ""));
  const setToken =
    opts.setToken ??
    ((t: string) => {
      if (typeof localStorage !== "undefined") localStorage.setItem(tokenKey, t);
    });
  const baseUrl = opts.baseUrl ?? "";
  // A stored token the server no longer accepts (revoked, or a password saved as
  // a token by older builds) would block cookie sign-in forever: forget it.
  const dropRejectedToken = (status: number, token: string, msg: string) => {
    if (status === 401 && token && msg === "Invalid bearer token" && typeof localStorage !== "undefined" && localStorage.getItem(tokenKey) === token)
      localStorage.removeItem(tokenKey);
  };

  async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers || {});
    if (!headers.has("Content-Type") && init.body) {
      headers.set("Content-Type", "application/json");
    }
    const token = getToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);

    const res = await fetch(`${baseUrl}${path}`, { ...init, headers });
    const json = (await res.json()) as Envelope<T>;
    if (!json.ok) {
      const msg =
        typeof json.error === "string"
          ? json.error
          : json.error?.message || `request failed ${res.status}`;
      dropRejectedToken(res.status, token, msg);
      throw new Error(msg);
    }
    return json.data as T;
  }

  async function apiMeta<T>(path: string, init?: RequestInit) {
    const headers = new Headers(init?.headers || {});
    const token = getToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const res = await fetch(`${baseUrl}${path}`, { ...init, headers });
    const json = (await res.json()) as Envelope<T>;
    if (!json.ok) {
      const msg =
        typeof json.error === "string"
          ? json.error
          : json.error?.message || "failed";
      dropRejectedToken(res.status, token, msg);
      throw new Error(msg);
    }
    return { data: json.data as T, meta: json.meta || {} };
  }

  return { api, apiMeta, getToken, setToken, tokenKey };
}

export const defaultApi = createApiClient();
export const api = defaultApi.api;
export const apiMeta = defaultApi.apiMeta;
export const getAgentToken = defaultApi.getToken;
export const setAgentToken = defaultApi.setToken;
