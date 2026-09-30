import axios, { AxiosError, AxiosInstance } from 'axios';
import { readRetryAfterMs } from './transient';
import { attachInterceptors } from './interceptors';
import type { HttpInterceptors } from './interceptors';
import { logger } from './logger';
import { SDK_VERSION, DEFAULT_API_VERSION } from '../constants';
import { DEFAULT_TIMEOUT_MS, isAxiosTimeoutError, axiosTimeoutMs } from './timeout';

declare module 'axios' {
  export interface AxiosRequestConfig {
    /**
     * Opt a single request into retries that its HTTP method would otherwise
     * not qualify for.
     *
     * By default only idempotent methods (`GET`, `HEAD`, `OPTIONS`, `PUT`,
     * `DELETE`) are retried on `5xx` and transport errors, because replaying a
     * `POST` after an ambiguous failure risks duplicating the side effect.
     * Set `trustflowRetry: true` on a call you know is safe to replay (for
     * example a `POST` that upserts under a caller-supplied idempotency key).
     *
     * @example
     * ```typescript
     * await http.post('/disputes', payload, { trustflowRetry: true });
     * ```
     */
    trustflowRetry?: boolean;
  }
}

/**
 * Retry tuning for backend API requests.
 *
 * Reused as-is for the Horizon / Soroban RPC calls wired through
 * {@link import('./node-retry').withTransientRetry}, so a single
 * `ClientConfig.retry` block configures every network call the SDK makes.
 */
export interface ApiRetryConfig {
  /** Total retry attempts after the first request. Defaults to 3. */
  retries?: number;
  /** Base retry delay in milliseconds. Defaults to 250ms. */
  retryDelayMs?: number;
  /** Maximum retry delay in milliseconds. Defaults to 2000ms. */
  maxRetryDelayMs?: number;
  /**
   * Randomise each delay to avoid synchronised retries when many callers fail
   * at once. `true` applies "equal jitter" (half the computed delay plus a
   * uniform random share of the other half, so delays stay in
   * `[delay / 2, delay]`). Defaults to `true`; pass `false` for a
   * fully deterministic schedule.
   */
  jitter?: boolean;
}

export interface ApiHttpClientOptions {
  baseURL: string;
  apiKey?: string;
  apiVersion?: string;
  /**
   * Per-request timeout in milliseconds. Defaults to
   * {@link DEFAULT_TIMEOUT_MS} (10s). A timeout surfaces as a
   * `Request timed out after <n>ms` message from {@link toApiErrorMessage},
   * distinguishable from an ordinary transport failure.
   */
  timeoutMs?: number;
  retry?: ApiRetryConfig;
  additionalHeaders?: Record<string, string>;
  /** Request/response interceptor hooks applied to every call made by this client. */
  interceptors?: HttpInterceptors;
}

const DEFAULT_RETRY_CONFIG: Required<ApiRetryConfig> = {
  retries: 3,
  retryDelayMs: 250,
  maxRetryDelayMs: 2000,
  jitter: true,
};

/** HTTP methods that are safe to replay without changing server-side state. */
const IDEMPOTENT_METHODS = new Set(['get', 'head', 'options', 'put', 'delete']);

/** Internal bookkeeping attached to a request config as it is retried. */
interface RetryableRequestConfig extends axios.InternalAxiosRequestConfig {
  /** Attempts already made beyond the first. */
  __trustflowAttempts?: number;
}

/** Reads the request method off an axios error, defaulting to `GET`. */
export function requestMethodOf(error: unknown): string {
  const config = (error as { config?: { method?: unknown } } | undefined)?.config;
  const method = typeof config?.method === 'string' ? config.method : undefined;
  return (method ?? 'get').toLowerCase();
}

/** Whether the call opted in to retrying regardless of its HTTP method. */
function optedIntoAnyMethod(error: unknown): boolean {
  return (
    (error as { config?: { trustflowRetry?: unknown } } | undefined)?.config?.trustflowRetry ===
    true
  );
}

/** True when this request's method is safe to replay (or it opted in). */
export function isMethodRetryable(error: unknown): boolean {
  if (optedIntoAnyMethod(error)) return true;
  return IDEMPOTENT_METHODS.has(requestMethodOf(error));
}

/**
 * Decides whether a failed request should be replayed.
 *
 * Retries `429`, `408` and `5xx`, plus transport errors (no response at all) —
 * and only for idempotent methods, or a call that set `trustflowRetry: true`.
 * Every other `4xx` is a client error that will fail identically.
 *
 * @param error - The rejected axios error
 * @returns Whether to replay the request
 */
export function shouldRetryRequest(error: unknown): boolean {
  if (!isMethodRetryable(error)) return false;
  const status = (error as { response?: { status?: number } }).response?.status;
  if (status === undefined) return true; // transport failure
  if (status === 429 || status === 408) return true;
  return status >= 500 && status < 600;
}

/** Equal jitter: keeps the delay within `[half, full]` so it never grows. */
function withJitter(delay: number, enabled: boolean): number {
  if (!enabled || delay <= 0) return delay;
  const half = delay / 2;
  return Math.round(half + Math.random() * half);
}

/**
 * Delay before the next attempt: the server's `Retry-After` hint when it sent
 * one (still capped by `maxRetryDelayMs`), otherwise exponential backoff with
 * optional jitter.
 *
 * @param retryCount - 1 for the first retry
 * @param error - The failure that triggered the retry, for the `Retry-After` hint
 * @param config - The resolved retry budget
 */
export function apiRetryDelay(
  retryCount: number,
  error: unknown,
  config: Required<ApiRetryConfig>,
): number {
  const hint = readRetryAfterMs(error);
  if (hint !== undefined) {
    return Math.min(hint, config.maxRetryDelayMs);
  }
  const exponential = config.retryDelayMs * 2 ** (retryCount - 1);
  return withJitter(Math.min(exponential, config.maxRetryDelayMs), config.jitter);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Installs the SDK's retry interceptor on an axios instance.
 *
 * Implemented directly rather than with `axios-retry`, which is CommonJS-only:
 * its `import isRetryAllowed from 'is-retry-allowed'` breaks Rollup's strict ESM
 * output with `"default" is not exported by ...`, forcing every Rollup consumer
 * to add `@rollup/plugin-commonjs`. An interceptor is also the only way to
 * apply the method-idempotency gate, the `Retry-After` hint and jitter exactly
 * as the SDK documents them.
 *
 * @param instance - The axios instance to instrument
 * @param config - The resolved retry budget
 */
export function installApiRetryInterceptor(
  instance: AxiosInstance,
  config: Required<ApiRetryConfig>,
): void {
  // Unit tests mock `axios.create` to return a bare object without
  // `interceptors`; there is no way to hook responses there, so skip rather
  // than throw (the logging interceptors below are optional-chained too).
  if (!instance.interceptors?.response) return;
  instance.interceptors.response.use(undefined, async (error: AxiosError) => {
    const requestConfig = error.config as RetryableRequestConfig | undefined;
    // No config means the failure happened before a request was even built
    // (e.g. a bad baseURL); there is nothing safe to replay.
    if (!requestConfig) throw error;

    const attempts = (requestConfig.__trustflowAttempts ?? 0) + 1;
    if (attempts > config.retries || !shouldRetryRequest(error)) {
      throw error;
    }

    await sleep(apiRetryDelay(attempts, error, config));

    requestConfig.__trustflowAttempts = attempts;
    return instance.request(requestConfig);
  });
}

/**
 * Creates an Axios instance configured with safe automatic retries for transient failures.
 *
 * **What is retried**
 * - Transport errors (connection reset/refused, DNS, offline) and timeouts, for
 *   idempotent methods only.
 * - `429`, `408` and `5xx` responses, again for idempotent methods only.
 * - A `Retry-After` header on a `429` overrides the backoff schedule (still
 *   capped by `maxRetryDelayMs`).
 *
 * **What is not retried**
 * - `POST`/`PATCH` (and any other non-idempotent method) on `5xx` or a transport
 *   error, because the server may have processed the request before the failure
 *   and a replay could duplicate the side effect. Opt a specific call in with
 *   `{ trustflowRetry: true }` when replaying it is safe.
 * - Any `4xx` other than `408`/`429` — a client error will fail identically.
 * - Every delay is jittered (`ApiRetryConfig.jitter`, default `true`).
 *
 * @example
 * ```typescript
 * const http = createApiHttpClient({
 *   baseURL: 'https://api.trustflow.xyz',
 *   apiKey: process.env.API_KEY,
 *   retry: { retries: 5, retryDelayMs: 500, maxRetryDelayMs: 10_000 },
 * });
 * ```
 */
export function createApiHttpClient(options: ApiHttpClientOptions): AxiosInstance {
  const retryConfig = {
    ...DEFAULT_RETRY_CONFIG,
    ...options.retry,
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-SDK-Version': SDK_VERSION,
    'X-API-Version': options.apiVersion ?? DEFAULT_API_VERSION,
    ...options.additionalHeaders,
  };

  if (options.apiKey) {
    headers['Authorization'] = `Bearer ${options.apiKey}`;
  }

  const instance = axios.create({
    baseURL: options.baseURL,
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    headers,
  });

  // Interceptors are attached first so request hooks run once per attempt
  // (including retries) and response hooks observe the final outcome, not
  // every intermediate failure. Axios runs response interceptors in
  // registration order, so the retry handler below is the outermost one.
  if (options.interceptors) {
    attachInterceptors(instance, options.interceptors);
  }

  installApiRetryInterceptor(instance, retryConfig);

  // Request/response logging interceptors (optional-chained so unit tests
  // that mock `axios.create` without interceptors keep working).
  instance.interceptors?.request?.use(
    (config) => {
      logger.debug('HTTP request', {
        method: config.method?.toUpperCase(),
        url: config.url,
        baseURL: config.baseURL,
      });
      return config;
    },
    (error) => {
      logger.error('HTTP request error', { error: error.message });
      return Promise.reject(error);
    }
  );

  instance.interceptors?.response?.use(
    (response) => {
      logger.debug('HTTP response', {
        status: response.status,
        url: response.config.url,
        baseURL: response.config.baseURL,
      });
      return response;
    },
    (error) => {
      const status = error.response?.status;
      logger.warn('HTTP error response', {
        status,
        url: error.config?.url,
        baseURL: error.config?.baseURL,
        message: error.message,
      });
      return Promise.reject(error);
    }
  );

  return instance;
}

/**
 * Maps unknown transport errors into stable SDK error strings.
 *
 * Timeouts are reported distinctly from other transport failures: an axios
 * timeout becomes `Request timed out after <n>ms` (the configured budget,
 * parsed off axios' own message) rather than the generic
 * `Network error: timeout of <n>ms exceeded`, so callers can branch on
 * "the server was slow" without string-matching axios internals.
 */
export function toApiErrorMessage(error: unknown): string {
  if (error instanceof AxiosError) {
    const status = error.response?.status;
    const statusText = error.response?.statusText;
    if (typeof status === 'number') {
      return statusText ? `HTTP ${status}: ${statusText}` : `HTTP ${status}`;
    }
    if (isAxiosTimeoutError(error)) {
      const ms = axiosTimeoutMs(error);
      return ms === undefined ? 'Request timed out' : `Request timed out after ${ms}ms`;
    }
    return `Network error: ${error.message}`;
  }
  if (error instanceof Error) {
    return `Network error: ${error.message}`;
  }
  return `Network error: ${String(error)}`;
}