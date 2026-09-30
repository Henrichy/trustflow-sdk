import type { AxiosInstance, AxiosResponse, InternalAxiosRequestConfig } from 'axios';

/** Request config passed through request interceptors before a request is sent. */
export type InterceptorRequestConfig = InternalAxiosRequestConfig;

/** Response passed through response interceptors after a response is received. */
export type InterceptorResponse<T = unknown> = AxiosResponse<T>;

/** Transforms a value before it is handed to the next interceptor. May be async. */
export type InterceptorFulfilled<V> = (value: V) => V | Promise<V>;

/**
 * Handles an error thrown by the transport or an earlier interceptor.
 * Return (or resolve) a value to recover; throw (or reject) to keep the chain failing.
 */
export type InterceptorRejected<V> = (error: unknown) => V | Promise<V>;

interface InterceptorHandler<V> {
  fulfilled?: InterceptorFulfilled<V>;
  rejected?: InterceptorRejected<V>;
}

/**
 * Ordered list of interceptors, modelled on axios' `InterceptorManager`.
 *
 * Unlike axios (which runs request interceptors in reverse registration order),
 * both request and response interceptors here run in the order they were added.
 */
export class InterceptorManager<V> {
  private handlers: Array<InterceptorHandler<V> | null> = [];

  /**
   * Registers an interceptor.
   *
   * @returns An id that can be passed to {@link eject} to remove it.
   */
  use(fulfilled?: InterceptorFulfilled<V>, rejected?: InterceptorRejected<V>): number {
    this.handlers.push({ fulfilled, rejected });
    return this.handlers.length - 1;
  }

  /** Removes a previously registered interceptor. Unknown ids are ignored. */
  eject(id: number): void {
    if (this.handlers[id]) {
      this.handlers[id] = null;
    }
  }

  /** Removes all interceptors. */
  clear(): void {
    this.handlers = [];
  }

  /** Number of active interceptors. */
  get size(): number {
    return this.handlers.filter(Boolean).length;
  }

  /**
   * Runs `value` (or `error`, when `failed` is true) through every interceptor in order.
   * A fulfilled handler that throws switches the chain into the rejected path;
   * a rejected handler that returns a value switches it back.
   */
  async run(input: unknown, failed = false): Promise<V> {
    let state: { ok: true; value: V } | { ok: false; error: unknown } = failed
      ? { ok: false, error: input }
      : { ok: true, value: input as V };

    for (const handler of this.handlers) {
      if (!handler) continue;
      try {
        if (state.ok) {
          if (handler.fulfilled) {
            state = { ok: true, value: await handler.fulfilled(state.value) };
          }
        } else if (handler.rejected) {
          state = { ok: true, value: await handler.rejected(state.error) };
        }
      } catch (error) {
        state = { ok: false, error };
      }
    }

    if (!state.ok) {
      throw state.error;
    }
    return state.value;
  }
}

/**
 * Request/response interceptor hooks for SDK HTTP clients.
 *
 * Share one instance across clients to apply the same logging, auth or
 * transformation logic to every backend call.
 *
 * @example
 * ```typescript
 * const interceptors = new HttpInterceptors();
 *
 * interceptors.request.use(async (config) => {
 *   config.headers.set('X-Request-Id', crypto.randomUUID());
 *   return config;
 * });
 *
 * interceptors.response.use(
 *   (response) => response,
 *   (error) => {
 *     console.error('API call failed', error);
 *     throw error;
 *   },
 * );
 *
 * const profiles = new ProfileClient(apiUrl, token, { interceptors });
 * ```
 */
export class HttpInterceptors {
  readonly request = new InterceptorManager<InterceptorRequestConfig>();
  readonly response = new InterceptorManager<InterceptorResponse>();
}

/**
 * Wires {@link HttpInterceptors} into an axios instance.
 *
 * Interceptors are resolved lazily on each request, so handlers added or
 * ejected after the client is created still take effect.
 */
export function attachInterceptors(instance: AxiosInstance, interceptors: HttpInterceptors): void {
  instance.interceptors.request.use((config) => interceptors.request.run(config));
  instance.interceptors.response.use(
    (response) => interceptors.response.run(response),
    (error: unknown) => interceptors.response.run(error, true),
  );
}
