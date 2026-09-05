// Axios adapter for the Kubb-generated SDK (kubb.config.ts points importPath
// here). Adapted from madi's client/src/api/client.ts, trimmed to what this
// app needs: the Authentication header (SimpleLogin's exact header name — not
// Authorization) and a generic expired-key 401 bounce.

import axios from "axios";
import type { AxiosError, AxiosRequestConfig, AxiosResponse } from "axios";
import { clearApiKey, getApiKey } from "../auth";
import { isExtension, shellApiOrigin } from "../shell";

/**
 * Subset of AxiosRequestConfig
 */
export type RequestConfig<TData = unknown> = {
  baseURL?: string;
  url?: string;
  method?: "GET" | "PUT" | "PATCH" | "POST" | "DELETE" | "OPTIONS";
  params?: unknown;
  data?: TData | FormData;
  responseType?: "arraybuffer" | "blob" | "document" | "json" | "text" | "stream";
  signal?: AbortSignal;
  headers?: AxiosRequestConfig["headers"];
};

/**
 * Subset of AxiosResponse
 */
export type ResponseConfig<TData = unknown> = {
  data: TData;
  status: number;
  statusText: string;
  headers: AxiosResponse["headers"];
};

export type ResponseErrorConfig<TError = unknown> = AxiosError<TError>;

export const axiosInstance = axios.create();

// Stamp the stored api key on every request (never overwrite an explicit
// per-request header). The generated SDK's baseURL is the relative `/api`;
// inside the extension popup the shell says which origin that lives on.
axiosInstance.interceptors.request.use((config) => {
  const key = getApiKey();
  if (key && !config.headers.has("Authentication")) {
    config.headers.set("Authentication", key);
  }
  const origin = shellApiOrigin();
  if (origin && config.baseURL?.startsWith("/")) {
    config.baseURL = origin + config.baseURL;
  }
  return config;
});

// Where the login page is from the browser's point of view: a real path under
// the /app basepath on the web, a hash route inside the extension popup
// (hash history — src/app.tsx).
function onLoginPage(): boolean {
  return isExtension()
    ? window.location.hash.startsWith("#/login")
    : window.location.pathname === "/app/login";
}
function loginHref(): string {
  return isExtension() ? "#/login?reason=expired" : "/app/login?reason=expired";
}

// Generic 401 handler: any authenticated request coming back 401 means the
// key is gone/revoked — clear it and bounce to the login page. Exempt the
// auth posts themselves (their 4xx belongs on the form).
axiosInstance.interceptors.response.use(
  (res) => res,
  (error: AxiosError) => {
    const status = error.response?.status;
    const url = error.config?.url ?? "";
    const exempt = url.startsWith("/auth/");
    if (status === 401 && !exempt && typeof window !== "undefined" && !onLoginPage()) {
      clearApiKey();
      window.location.assign(loginHref());
    }
    return Promise.reject(error);
  },
);

export const client = async <TData, _TError = unknown, TVariables = unknown>(
  config: RequestConfig<TVariables>,
): Promise<ResponseConfig<TData>> => {
  return axiosInstance.request<TData, ResponseConfig<TData>>(config);
};

export default client;
